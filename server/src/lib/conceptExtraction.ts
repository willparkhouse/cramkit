/**
 * Reusable concept-extraction core. Lifted out of scripts/extract-concepts.ts
 * so the admin pipeline route can call it (writing to the extracted_concepts
 * table) without spawning a CLI subprocess.
 *
 * The CLI script still imports `runExtraction()` and wraps the results in
 * its own JSON-file output for backwards compatibility.
 *
 * Strategy: whole-week single-call extraction. For each week of a module,
 * send all transcript and slide chunks in one Claude call and ask for the
 * canonical 5-10 concepts. No per-lecture pass, no consolidation pass.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------
export interface ExtractedConcept {
  name: string
  description: string
  key_facts: string[]
  difficulty: number
  source_chunk_ids: string[]
}

export interface ExtractedConceptWithLocation extends ExtractedConcept {
  week: number | null
  lecture: string | null
}

export interface ExtractionResult {
  module: string
  generated_at: string
  total_concepts: number
  by_week: Record<string, number>
  concepts: ExtractedConceptWithLocation[]
  coverage_report: string | null
}

export interface ExtractionProgress {
  weeks_total: number
  weeks_done: number
  last_week: number | null
  failures: number[]
}

export interface ExtractionOptions {
  moduleSlug: string
  /** Skip the optional module-wide coverage check (saves one Claude call) */
  skipCoverage?: boolean
  /** Max concurrent week extractions. Default 4 on OpenRouter, 2 direct. */
  concurrency?: number
  /** 'sonnet' (default) or 'haiku' */
  model?: 'sonnet' | 'haiku'
  /** Optional progress callback fired after each week completes */
  onProgress?: (p: ExtractionProgress) => void | Promise<void>
  /** Optional log line callback for streaming logs to a UI */
  onLog?: (line: string) => void | Promise<void>
}

// ----------------------------------------------------------------------------
// Internal types
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

interface ExtractResponse {
  concepts: ExtractedConcept[]
}

// ----------------------------------------------------------------------------
// Provider + model resolution
// ----------------------------------------------------------------------------
function getClients() {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  }
  if (!ANTHROPIC_KEY && !OPENROUTER_KEY) {
    throw new Error('Either ANTHROPIC_API_KEY or OPENROUTER_API_KEY required')
  }

  const useOpenRouter = !!OPENROUTER_KEY
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const anthropic = useOpenRouter
    ? new Anthropic({
        apiKey: OPENROUTER_KEY!,
        baseURL: 'https://openrouter.ai/api',
        defaultHeaders: {
          'HTTP-Referer': 'https://cramkit.app',
          'X-Title': 'cramkit',
        },
      })
    : new Anthropic({ apiKey: ANTHROPIC_KEY! })

  const sonnetId = useOpenRouter ? 'anthropic/claude-sonnet-4-6' : 'claude-sonnet-4-6'
  const haikuId = useOpenRouter ? 'anthropic/claude-haiku-4-5' : 'claude-haiku-4-5-20251001'
  const defaultConcurrency = useOpenRouter ? 4 : 2
  return { sb, anthropic, sonnetId, haikuId, defaultConcurrency, useOpenRouter }
}

// ----------------------------------------------------------------------------
// DB loaders
// ----------------------------------------------------------------------------
async function fetchSources(sb: SupabaseClient, moduleSlug: string): Promise<SourceRow[]> {
  const { data, error } = await sb
    .from('sources')
    .select('id, source_type, code, week, lecture, module')
    .eq('module', moduleSlug)
  if (error) throw error
  return (data ?? []) as SourceRow[]
}

async function fetchChunksForSource(sb: SupabaseClient, sourceId: string): Promise<ChunkRow[]> {
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
// Concurrency pool
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
// ----------------------------------------------------------------------------
async function callClaude<T>(
  anthropic: Anthropic,
  model: string,
  systemPrompt: string,
  userContent: string,
  label: string,
  log: (line: string) => void | Promise<void>,
  maxTokens = 16384,
): Promise<T> {
  let attempt = 0
  const MAX_RETRIES = 6
  // Hard wall-clock timeout per call. The Anthropic SDK + OpenRouter
  // occasionally produce a stalled connection that the underlying fetch
  // never times out on (saw a 15+ minute hang on cvi week 2). 8 minutes
  // is well above any legitimate Sonnet response time at our payload sizes.
  const CALL_TIMEOUT_MS = 8 * 60 * 1000
  // Heartbeat: while a call is in flight, log every 30s so you can tell
  // the difference between "still processing" and "actually hung". The
  // diff between elapsed and last_heartbeat tells you whether the
  // hang is in our code or in the SDK/network layer.
  const HEARTBEAT_MS = 30_000
  const inputChars = systemPrompt.length + userContent.length
  const inputTokensEst = Math.round(inputChars / 4)
  while (true) {
    const callStart = Date.now()
    let lastTickAt = callStart
    let heartbeats = 0
    const heartbeat = setInterval(async () => {
      heartbeats++
      const elapsedSec = Math.round((Date.now() - callStart) / 1000)
      const sinceLastTick = Math.round((Date.now() - lastTickAt) / 1000)
      lastTickAt = Date.now()
      await log(`  ${label} heartbeat ${heartbeats} · ${elapsedSec}s elapsed · +${sinceLastTick}s since last tick`)
    }, HEARTBEAT_MS)
    try {
      await log(`  ${label} START attempt=${attempt + 1} model=${model} input≈${inputTokensEst} tokens (${inputChars} chars) max_out=${maxTokens}`)
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, CALL_TIMEOUT_MS)
      let res
      try {
        res = await anthropic.messages.create(
          {
            model,
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
      await log(
        `  ${label} RESPONSE ${elapsedSec}s · in=${usage?.input_tokens ?? '?'} out=${usage?.output_tokens ?? '?'} tokens`
      )
      const text = res.content[0].type === 'text' ? res.content[0].text : ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) throw new Error(`${label}: no JSON found in response`)
      try {
        return JSON.parse(m[0]) as T
      } catch (parseErr) {
        throw new Error(`${label}: JSON parse failed — ${(parseErr as { message?: string }).message}`)
      }
    } catch (err) {
      clearInterval(heartbeat)
      const elapsedSec = Math.round((Date.now() - callStart) / 1000)
      await log(`  ${label} ERROR after ${elapsedSec}s — ${(err as Error).message ?? err}`)
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
      await log(`  ${label} retry ${attempt}/${MAX_RETRIES} after ${Math.round(wait / 1000)}s — ${e.message ?? err}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------
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

const COVERAGE_PROMPT = `You are reviewing the concept list extracted for a university module. Looking at the topic names below, your job is to flag obvious gaps in coverage that a student studying this module would expect to see.

Be specific. Don't list every possible adjacent topic — only call out things that should clearly be there given the topics that ARE there. If coverage looks complete, say so.

Note: weeks 6 and similar are commonly reading weeks in UK MSc programmes — if a week is missing entirely from the list and there's no other gap, this is probably intentional rather than a real coverage gap.

Return ONLY a plain text response (not JSON), formatted as:

COVERAGE ASSESSMENT
Status: [COMPLETE | GAPS_FOUND]

Gaps:
- [gap 1, with a one-sentence explanation of why it should be there]
- [gap 2, ...]

(or "None — coverage looks comprehensive given the listed topics" if no gaps)`

// ----------------------------------------------------------------------------
// Per-week extraction
// ----------------------------------------------------------------------------
async function extractWeek(
  anthropic: Anthropic,
  model: string,
  weekNumber: number,
  weekSources: SourceWithChunks[],
  log: (line: string) => void | Promise<void>,
): Promise<ExtractedConcept[]> {
  const parts: string[] = []
  for (const { source, chunks } of weekSources) {
    for (const ch of chunks) {
      parts.push(`[chunk_id=${ch.id}] (${source.code}) ${ch.text}`)
    }
  }
  const userContent = parts.join('\n\n')
  const result = await callClaude<ExtractResponse>(
    anthropic,
    model,
    WHOLE_WEEK_PROMPT,
    userContent,
    `week ${weekNumber}`,
    log,
    16384,
  )
  return result.concepts.filter((c) => c.name && c.description)
}

async function coverageCheck(
  anthropic: Anthropic,
  model: string,
  moduleSlug: string,
  concepts: ExtractedConceptWithLocation[],
): Promise<string> {
  const outline = concepts
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0))
    .map((c, i) => `${i + 1}. [w${c.week ?? '?'}] ${c.name}`)
    .join('\n')
  const userContent = `Module: ${moduleSlug}\n\nExtracted concepts:\n${outline}`
  const res = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    system: COVERAGE_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  })
  return res.content[0].type === 'text' ? res.content[0].text : ''
}

// ----------------------------------------------------------------------------
// Cross-week dedup — drop concepts whose name (normalised) already appeared
// in an earlier week. Keeps the earliest occurrence.
// ----------------------------------------------------------------------------
function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function dedupCrossWeek(
  byWeek: Map<number, ExtractedConcept[]>,
): { flat: ExtractedConceptWithLocation[]; dropped: number } {
  const seen = new Set<string>()
  let dropped = 0
  const flat: ExtractedConceptWithLocation[] = []
  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    for (const c of byWeek.get(week)!) {
      const key = normaliseName(c.name)
      if (seen.has(key)) {
        dropped++
        continue
      }
      seen.add(key)
      flat.push({ ...c, week, lecture: null })
    }
  }
  return { flat, dropped }
}

// ----------------------------------------------------------------------------
// Public entrypoint
// ----------------------------------------------------------------------------
export async function runExtraction(opts: ExtractionOptions): Promise<ExtractionResult> {
  const { sb, anthropic, sonnetId, haikuId, defaultConcurrency } = getClients()
  const model = opts.model === 'haiku' ? haikuId : sonnetId
  const concurrency = opts.concurrency ?? defaultConcurrency
  const log = opts.onLog ?? (() => {})
  const reportProgress = opts.onProgress ?? (() => {})

  await log(`Extracting concepts for module: ${opts.moduleSlug}`)
  await log(`Strategy: whole-week single-call`)
  await log(`Model: ${model}`)
  await log(`Concurrency: ${concurrency}`)

  // Load sources
  const sources = await fetchSources(sb, opts.moduleSlug)
  if (sources.length === 0) {
    throw new Error(`No sources found for module "${opts.moduleSlug}"`)
  }

  // Group by week + load chunks
  await log(`Loading chunks…`)
  const byWeekSources = new Map<number, SourceWithChunks[]>()
  for (const s of sources) {
    if (s.week === null) continue
    const chunks = await fetchChunksForSource(sb, s.id)
    if (chunks.length === 0) continue
    const list = byWeekSources.get(s.week) ?? []
    list.push({ source: s, chunks })
    byWeekSources.set(s.week, list)
  }
  const weeks = [...byWeekSources.keys()].sort((a, b) => a - b)
  await log(`${weeks.length} week(s) with content: ${weeks.join(', ')}`)

  // Initial progress notification
  await reportProgress({ weeks_total: weeks.length, weeks_done: 0, last_week: null, failures: [] })

  // Run extraction in parallel
  const byWeek = new Map<number, ExtractedConcept[]>()
  const failures: number[] = []
  let done = 0
  await runWithConcurrency(weeks, concurrency, async (week) => {
    const weekSources = byWeekSources.get(week)!
    const totalChunks = weekSources.reduce((s, x) => s + x.chunks.length, 0)
    try {
      const concepts = await extractWeek(anthropic, model, week, weekSources, log)
      byWeek.set(week, concepts)
      done++
      await log(`  [${done}/${weeks.length}] week ${week} — ${concepts.length} concept(s) (${weekSources.length} sources, ${totalChunks} chunks)`)
      await reportProgress({ weeks_total: weeks.length, weeks_done: done, last_week: week, failures: [...failures] })
    } catch (err) {
      failures.push(week)
      done++
      await log(`  [${done}/${weeks.length}] week ${week} — FAILED: ${(err as Error).message}`)
      await reportProgress({ weeks_total: weeks.length, weeks_done: done, last_week: week, failures: [...failures] })
    }
  })

  // Cross-week dedup
  const { flat, dropped } = dedupCrossWeek(byWeek)
  if (dropped > 0) {
    await log(`Dropped ${dropped} cross-week duplicate(s) — kept earliest occurrence`)
  }
  await log(`Total: ${flat.length} concept(s) across ${byWeek.size} week(s)`)

  // Coverage check (optional)
  let coverageReport: string | null = null
  if (!opts.skipCoverage && flat.length > 0) {
    await log(`Running coverage check…`)
    try {
      coverageReport = await coverageCheck(anthropic, model, opts.moduleSlug, flat)
    } catch (err) {
      await log(`Coverage check failed (non-fatal): ${(err as Error).message}`)
    }
  }

  // Build result
  const byWeekCounts: Record<string, number> = {}
  for (const c of flat) {
    const key = c.week === null ? 'no-week' : `week-${c.week}`
    byWeekCounts[key] = (byWeekCounts[key] ?? 0) + 1
  }

  return {
    module: opts.moduleSlug,
    generated_at: new Date().toISOString(),
    total_concepts: flat.length,
    by_week: byWeekCounts,
    concepts: flat,
    coverage_report: coverageReport,
  }
}
