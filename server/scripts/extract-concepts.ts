/**
 * Extract concepts from a module's indexed source material.
 *
 * Whole-week strategy: for each week of the module, send ALL the chunks
 * (lecture transcripts + slide decks) in a single Claude call and ask for
 * the week-level concept list directly. No per-lecture extraction, no
 * downstream consolidation. The earlier per-lecture pipeline produced too
 * many granular concepts that needed an expensive merge step — the
 * whole-week experiment showed this approach yields cleaner output at lower
 * cost. See data/extracted-concepts/experiments/ for the head-to-head.
 *
 * Pipeline:
 *   PASS 1  Per-week extraction over combined transcript+slide chunks
 *           (1 call per week, 5-10 concepts each)
 *   PASS 2  Module-wide coverage check (1 call total, optional via --skip-pass4)
 *
 * Output:
 *   data/extracted-concepts/{module}.json
 *   data/extracted-concepts/{module}.coverage-gaps.txt
 *
 * Run:
 *   cd server && npx tsx scripts/extract-concepts.ts --module neuralcomp
 *   cd server && npx tsx scripts/extract-concepts.ts --module neuralcomp --skip-pass4
 *
 * The script never touches the DB. After reviewing the JSON, use
 * `import-concepts.ts` to write it.
 */
import 'dotenv/config'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY

// OpenRouter is opt-in via env: if OPENROUTER_API_KEY is set, route through
// it for the higher rate-limit ceiling. Otherwise fall back to Anthropic
// direct.
const USE_OPENROUTER = !!OPENROUTER_KEY
if (!SUPABASE_URL || !SERVICE_KEY || (!ANTHROPIC_KEY && !OPENROUTER_KEY)) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and either ANTHROPIC_API_KEY or OPENROUTER_API_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
// The Anthropic SDK appends `/v1/messages` to baseURL, so the OpenRouter
// baseURL must NOT include `/v1` — otherwise it doubles up.
const anthropic = USE_OPENROUTER
  ? new Anthropic({
      apiKey: OPENROUTER_KEY!,
      baseURL: 'https://openrouter.ai/api',
      defaultHeaders: {
        'HTTP-Referer': 'https://cramkit.app',
        'X-Title': 'cramkit',
      },
    })
  : new Anthropic({ apiKey: ANTHROPIC_KEY! })

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(REPO_ROOT, 'data', 'extracted-concepts')

// Concurrency for the per-week extraction pass. Each call is large (~50-80k
// input tokens), so even on OpenRouter we keep this modest to avoid bursts.
const DEFAULT_CONCURRENCY = USE_OPENROUTER ? 4 : 2

// Model identifiers. The whole-week strategy needs the model to read 200+
// chunks at once and produce the canonical week-level concept list — that's
// a reasoning task, so Sonnet is the right pick. Haiku tested noticeably
// worse on this in the prompt experiment.
const SONNET_ID = USE_OPENROUTER ? 'anthropic/claude-sonnet-4-6' : 'claude-sonnet-4-6'
const HAIKU_ID = USE_OPENROUTER ? 'anthropic/claude-haiku-4-5' : 'claude-haiku-4-5-20251001'

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(name)
}

const MODULE_SLUG = arg('--module')
const SKIP_COVERAGE = flag('--skip-coverage') || flag('--skip-pass4')
const FORCE = flag('--force') // ignore checkpoint, re-extract everything
const CONCURRENCY = parseInt(arg('--concurrency') ?? String(DEFAULT_CONCURRENCY), 10)
const MODEL_OVERRIDE = arg('--model') // 'sonnet' | 'haiku'

if (!MODULE_SLUG) {
  console.error('Usage: tsx scripts/extract-concepts.ts --module <slug> [--skip-coverage] [--force] [--concurrency N] [--model sonnet|haiku]')
  console.error('  --skip-coverage : skip the module-wide coverage check (saves one call)')
  console.error('  --force         : ignore the checkpoint and re-extract every week')
  console.error('  --concurrency N : in-flight per-week calls. Default 4 on OpenRouter, 2 direct.')
  console.error('  --model         : sonnet (default) or haiku')
  process.exit(1)
}

const MODEL = MODEL_OVERRIDE === 'haiku' ? HAIKU_ID : SONNET_ID

// ----------------------------------------------------------------------------
// DB types and loaders
// ----------------------------------------------------------------------------
interface SourceRow {
  id: string
  source_type: 'lecture' | 'slides' | string
  code: string
  week: number | null
  lecture: string | null
  module: string
}

interface ChunkRow {
  id: string
  source_id: string
  chunk_index: number
  text: string
  locator: Record<string, unknown>
}

interface SourceWithChunks {
  source: SourceRow
  chunks: ChunkRow[]
}

async function fetchSources(moduleSlug: string): Promise<SourceRow[]> {
  const { data, error } = await sb
    .from('sources')
    .select('id, source_type, code, week, lecture, module')
    .eq('module', moduleSlug)
  if (error) throw error
  return (data ?? []) as SourceRow[]
}

async function fetchChunksForSource(sourceId: string): Promise<ChunkRow[]> {
  const PAGE = 1000
  const out: ChunkRow[] = []
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('source_chunks')
      .select('id, source_id, chunk_index, text, locator')
      .eq('source_id', sourceId)
      .order('chunk_index', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as ChunkRow[]
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

// ----------------------------------------------------------------------------
// Concurrency pool — runs `worker(item)` for each item with at most `limit`
// in flight at once.
// ----------------------------------------------------------------------------
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function next() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next())
  await Promise.all(runners)
  return results
}

// ----------------------------------------------------------------------------
// Claude call with retry, JSON-only enforcement
//
// On 429 we respect Anthropic's retry-after header, falling back to a 60s
// wait — the rate limit window is rolling per minute, so anything shorter
// hits the same limit again. Other errors get a short exponential backoff.
// ----------------------------------------------------------------------------
async function callClaude<T>(
  systemPrompt: string,
  userContent: string,
  label: string,
  maxTokens = 16384,
): Promise<T> {
  let attempt = 0
  const MAX_RETRIES = 6
  // Hard wall-clock timeout per call. Without this the SDK will sit on a
  // dead OpenRouter socket forever (saw 15+ minute hangs on cvi week 2).
  const CALL_TIMEOUT_MS = 8 * 60 * 1000
  const HEARTBEAT_MS = 30_000
  const inputChars = systemPrompt.length + userContent.length
  const inputTokensEst = Math.round(inputChars / 4)
  while (true) {
    const callStart = Date.now()
    let heartbeats = 0
    const heartbeat = setInterval(() => {
      heartbeats++
      const elapsedSec = Math.round((Date.now() - callStart) / 1000)
      console.log(`  ${label} heartbeat ${heartbeats} · ${elapsedSec}s elapsed`)
    }, HEARTBEAT_MS)
    try {
      console.log(`  ${label} START attempt=${attempt + 1} input≈${inputTokensEst}t (${inputChars} chars) max_out=${maxTokens}`)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
      let res
      try {
        res = await anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }],
          },
          { signal: controller.signal },
        )
      } finally {
        clearTimeout(timer)
        clearInterval(heartbeat)
      }
      const elapsedSec = Math.round((Date.now() - callStart) / 1000)
      const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
      console.log(`  ${label} RESPONSE ${elapsedSec}s · in=${usage?.input_tokens ?? '?'} out=${usage?.output_tokens ?? '?'} tokens`)
      const text = res.content[0].type === 'text' ? res.content[0].text : ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) throw new Error(`${label}: no JSON found in response`)
      return JSON.parse(m[0]) as T
    } catch (err) {
      clearInterval(heartbeat)
      const elapsedSec = Math.round((Date.now() - callStart) / 1000)
      console.warn(`  ${label} ERROR after ${elapsedSec}s — ${(err as Error).message ?? err}`)
      attempt++
      if (attempt > MAX_RETRIES) throw err

      const e = err as { status?: number; headers?: Record<string, string>; message?: string }
      const isRateLimit = e.status === 429
      const isOverloaded = e.status === 529

      let wait: number
      if (isRateLimit || isOverloaded) {
        const retryAfterSec = parseFloat(e.headers?.['retry-after'] ?? '0')
        const baseline = retryAfterSec > 0 ? retryAfterSec * 1000 : 60_000
        wait = Math.round(baseline * (1 + Math.random() * 0.1))
      } else {
        wait = 1500 * attempt
      }
      console.warn(`  ${label} retry ${attempt}/${MAX_RETRIES} after ${Math.round(wait / 1000)}s — ${e.message ?? err}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

// ----------------------------------------------------------------------------
// Whole-week extraction
// Single Claude call covering all the chunks (transcripts + slides) for one
// week. Returns 5-10 canonical concepts, each grounded in the relevant
// chunk IDs across both source types.
// ----------------------------------------------------------------------------
interface ExtractedConcept {
  name: string
  description: string
  key_facts: string[]
  difficulty: number
  source_chunk_ids: string[]
}

interface ExtractResponse {
  concepts: ExtractedConcept[]
}

const WHOLE_WEEK_PROMPT = `You are extracting concepts from one week of a university course (typically 2-3 lectures, ~3 hours of teaching, plus the corresponding slide deck).

A typical week of a UK MSc-level CS course covers 5-10 distinct concepts that students will be examined on. Your task is to identify those concepts from all the lecture transcripts and slide chunks below.

INPUT: numbered chunks from multiple sources. Each has a UUID, a source label (e.g. "nc1.1", "neuralcomp-slides-w1"), and the content text.

OUTPUT: ONLY a JSON object of this shape:
{
  "concepts": [
    {
      "name": "Canonical textbook-style name (3-7 words)",
      "description": "2-3 sentences explaining what the concept is and why it matters",
      "key_facts": ["atomic fact 1", "atomic fact 2", "..."],
      "difficulty": 3,
      "source_chunk_ids": ["uuid1", "uuid2", "..."]
    }
  ]
}

CRITICAL RULES:
- Aim for 5-10 concepts for the whole week. Don't fragment closely related ideas. Don't pad.
- Each concept must be substantial enough to be an exam question worth 5-10 marks.
- source_chunk_ids should include EVERY chunk where the concept appears (across both transcripts and slides) — typically 3-15 chunk ids per concept.
- When the same concept appears in both a slide and a transcript, MERGE them into one concept and include all the chunk ids in source_chunk_ids.
- Use canonical naming from the field, not paraphrases. "Backpropagation Algorithm" not "How gradients flow backwards through networks".
- Difficulty: 1 = basic recall, 3 = applying it, 5 = deep understanding / proofs / non-obvious implications.

WHAT TO SKIP:
- Course logistics (curriculum overviews, prerequisites, exam timetables, "what we'll cover")
- Historical anecdotes ("this was invented in 1986...")
- Named example systems used purely as illustration (Viola-Jones, AlphaGo, Minimax) — unless the lecturer is teaching the technique itself
- Mathematical asides made in passing (fold them into a parent concept's key_facts instead)
- Single sentences that don't sustain at least 5 minutes of explanation

KEY FACTS:
- Each key fact should be one atomic claim — the kind of thing you could quiz a student on with a single question
- Aim for 5-10 key facts per concept
- Cover the definition, why it matters, how it's computed/derived, common pitfalls, and any standard variants

source_chunk_ids must reference real UUIDs from the input — never invent.`

async function extractWeek(
  weekNumber: number,
  weekSources: SourceWithChunks[],
): Promise<ExtractedConcept[]> {
  // Build the combined input: every chunk from every source for this week,
  // tagged with the source code so the model can attribute concepts back.
  const parts: string[] = []
  for (const { source, chunks } of weekSources) {
    for (const ch of chunks) {
      parts.push(`[chunk_id=${ch.id}] (${source.code}) ${ch.text}`)
    }
  }
  const userContent = parts.join('\n\n')
  const result = await callClaude<ExtractResponse>(
    WHOLE_WEEK_PROMPT,
    userContent,
    `week ${weekNumber}`,
    16384,
  )
  return result.concepts.filter((c) => c.name && c.description)
}

// ----------------------------------------------------------------------------
// Coverage check (optional, single call)
// ----------------------------------------------------------------------------
const COVERAGE_PROMPT = `You are reviewing the concept list extracted for a university module. Looking at the topic names below, your job is to flag obvious gaps in coverage that a student studying this module would expect to see.

Be specific. Don't list every possible adjacent topic — only call out things that should clearly be there given the topics that ARE there. If coverage looks complete, say so.

Return ONLY a plain text response (not JSON), formatted as:

COVERAGE ASSESSMENT
Status: [COMPLETE | GAPS_FOUND]

Gaps:
- [gap 1, with a one-sentence explanation of why it should be there]
- [gap 2, ...]

(or "None — coverage looks comprehensive given the listed topics" if no gaps)`

async function coverageCheck(moduleSlug: string, concepts: OutputConcept[]): Promise<string> {
  const outline = concepts
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0))
    .map((c, i) => `${i + 1}. [w${c.week ?? '?'}] ${c.name}`)
    .join('\n')
  const userContent = `Module: ${moduleSlug}\n\nExtracted concepts:\n${outline}`
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: COVERAGE_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  })
  return res.content[0].type === 'text' ? res.content[0].text : ''
}

// ----------------------------------------------------------------------------
// Checkpointing — append-only JSONL of completed weeks so a crashed run can
// resume without redoing finished weeks.
// ----------------------------------------------------------------------------
interface CheckpointEntry {
  week: number
  concepts: ExtractedConcept[]
}

function checkpointPath(moduleSlug: string): string {
  return join(OUT_DIR, `${moduleSlug}.checkpoint.jsonl`)
}

function loadCheckpoint(moduleSlug: string): Map<number, ExtractedConcept[]> {
  const path = checkpointPath(moduleSlug)
  const map = new Map<number, ExtractedConcept[]>()
  if (!existsSync(path)) return map
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as CheckpointEntry
      map.set(entry.week, entry.concepts)
    } catch {
      // Tolerate corrupt lines
    }
  }
  return map
}

function appendCheckpoint(moduleSlug: string, week: number, concepts: ExtractedConcept[]) {
  mkdirSync(OUT_DIR, { recursive: true })
  appendFileSync(checkpointPath(moduleSlug), JSON.stringify({ week, concepts }) + '\n')
}

// ----------------------------------------------------------------------------
// Output shape (JSON file)
// ----------------------------------------------------------------------------
interface OutputConcept extends ExtractedConcept {
  week: number | null
  lecture: string | null
}

interface OutputFile {
  module: string
  generated_at: string
  total_concepts: number
  by_week: Record<string, number>
  concepts: OutputConcept[]
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  console.log(`\nExtracting concepts for module: ${MODULE_SLUG}`)
  console.log(`Strategy: whole-week single-call`)
  console.log(`Model: ${MODEL}`)
  console.log(`Provider: ${USE_OPENROUTER ? 'OpenRouter' : 'Anthropic direct'}`)
  console.log(`Concurrency: ${CONCURRENCY}\n`)

  // Load all sources
  const sources = await fetchSources(MODULE_SLUG!)
  if (sources.length === 0) {
    console.error(`No sources found for module "${MODULE_SLUG}". Did you ingest first?`)
    process.exit(1)
  }
  const lectureCount = sources.filter((s) => s.source_type === 'lecture').length
  const slideCount = sources.filter((s) => s.source_type === 'slides').length
  console.log(`Found ${lectureCount} lecture(s) and ${slideCount} slide deck(s)\n`)

  // Group sources by week and load their chunks
  console.log('Loading chunks…')
  const byWeek = new Map<number, SourceWithChunks[]>()
  for (const s of sources) {
    if (s.week === null) continue
    const chunks = await fetchChunksForSource(s.id)
    if (chunks.length === 0) continue
    const list = byWeek.get(s.week) ?? []
    list.push({ source: s, chunks })
    byWeek.set(s.week, list)
  }
  const weekNumbers = [...byWeek.keys()].sort((a, b) => a - b)
  console.log(`  ${weekNumbers.length} week(s) with content: ${weekNumbers.join(', ')}\n`)

  // Load checkpoint (unless --force)
  const checkpoint = FORCE ? new Map<number, ExtractedConcept[]>() : loadCheckpoint(MODULE_SLUG!)
  if (checkpoint.size > 0) {
    console.log(`Resuming from checkpoint: ${checkpoint.size} week(s) already extracted\n`)
  }

  const weeksToDo = weekNumbers.filter((w) => !checkpoint.has(w))

  // ─── Extract each week ───
  console.log(`=== Extracting ${weeksToDo.length} week(s) (concurrency=${CONCURRENCY}) ===`)
  let done = 0
  const failures: number[] = []
  await runWithConcurrency(weeksToDo, CONCURRENCY, async (week) => {
    const weekSources = byWeek.get(week)!
    const totalChunks = weekSources.reduce((s, x) => s + x.chunks.length, 0)
    try {
      const concepts = await extractWeek(week, weekSources)
      appendCheckpoint(MODULE_SLUG!, week, concepts)
      done++
      console.log(
        `  [${done}/${weeksToDo.length}] week ${week} — ${concepts.length} concept(s) ` +
        `(${weekSources.length} source(s), ${totalChunks} chunks)`
      )
    } catch (err) {
      failures.push(week)
      done++
      console.error(`  [${done}/${weeksToDo.length}] week ${week} — FAILED: ${(err as Error).message}`)
    }
  })

  if (failures.length > 0) {
    console.warn(`\n⚠ Extraction failed on ${failures.length} week(s): ${failures.join(', ')}. Re-run to retry.`)
  }

  // Build the flat output, replaying checkpoint + new results
  const flatConcepts: OutputConcept[] = []
  const finalByWeek = new Map<number, ExtractedConcept[]>()
  for (const [w, cs] of checkpoint) finalByWeek.set(w, cs)
  // The just-extracted weeks are also already in the checkpoint (we appended
  // them as we went), so we re-load to make sure resumed and fresh runs are
  // identical.
  const fresh = loadCheckpoint(MODULE_SLUG!)
  for (const [w, cs] of fresh) finalByWeek.set(w, cs)

  // Cross-week deduplication: the whole-week strategy can't see across weeks,
  // so when a lecturer recaps a previous week's topic ("last time we looked
  // at Block Cipher Modes"), it gets re-extracted in both weeks. We drop the
  // later occurrence and keep the earlier one (which has the more complete
  // grounding from when it was first taught).
  const seenNames = new Set<string>()
  let crossWeekDropped = 0
  for (const week of [...finalByWeek.keys()].sort((a, b) => a - b)) {
    for (const c of finalByWeek.get(week)!) {
      const key = c.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
      if (seenNames.has(key)) {
        crossWeekDropped++
        continue
      }
      seenNames.add(key)
      flatConcepts.push({ ...c, week, lecture: null })
    }
  }
  console.log(`\n  Total: ${flatConcepts.length} concept(s) across ${finalByWeek.size} week(s)`)
  if (crossWeekDropped > 0) {
    console.log(`  (Dropped ${crossWeekDropped} cross-week duplicate concept(s) — kept earliest occurrence)`)
  }

  // ─── Coverage check ───
  let coverageReport = ''
  if (!SKIP_COVERAGE && flatConcepts.length > 0) {
    console.log('\n=== Coverage check ===')
    try {
      coverageReport = await coverageCheck(MODULE_SLUG!, flatConcepts)
      console.log('  Done')
    } catch (err) {
      console.warn(`  Coverage check failed (non-fatal): ${(err as Error).message}`)
    }
  }

  // ─── Write output ───
  mkdirSync(OUT_DIR, { recursive: true })

  const byWeekCounts: Record<string, number> = {}
  for (const c of flatConcepts) {
    const key = c.week === null ? 'no-week' : `week-${c.week}`
    byWeekCounts[key] = (byWeekCounts[key] ?? 0) + 1
  }

  const output: OutputFile = {
    module: MODULE_SLUG!,
    generated_at: new Date().toISOString(),
    total_concepts: flatConcepts.length,
    by_week: byWeekCounts,
    concepts: flatConcepts,
  }

  const jsonPath = join(OUT_DIR, `${MODULE_SLUG}.json`)
  writeFileSync(jsonPath, JSON.stringify(output, null, 2))
  console.log(`\n✓ Wrote ${flatConcepts.length} concepts to ${jsonPath}`)

  if (coverageReport) {
    const gapsPath = join(OUT_DIR, `${MODULE_SLUG}.coverage-gaps.txt`)
    writeFileSync(gapsPath, coverageReport)
    console.log(`✓ Wrote coverage report to ${gapsPath}`)
  }

  console.log('\nDone. Review the JSON file and run import-concepts.ts when ready.')
  console.log(`(Checkpoint: ${checkpointPath(MODULE_SLUG!)} — delete it or pass --force to re-extract from scratch.)`)
}

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
