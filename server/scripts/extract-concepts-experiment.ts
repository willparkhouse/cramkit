/**
 * Prompt experiment harness for concept extraction.
 *
 * Runs multiple prompt/strategy variants over the SAME input (week 1 of a
 * module by default) so you can eyeball them side-by-side without burning
 * the cost of full-module runs.
 *
 * Each variant gets its own output file:
 *   data/extracted-concepts/experiments/{module}-w{week}-{variant}.json
 *
 * Run:
 *   npm run extract:experiment --workspace=server -- --module neuralcomp --week 1
 *   npm run extract:experiment --workspace=server -- --module neuralcomp --week 1 --variant tight
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY

if (!SUPABASE_URL || !SERVICE_KEY || (!ANTHROPIC_KEY && !OPENROUTER_KEY)) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY or OPENROUTER_API_KEY')
  process.exit(1)
}

const USE_OPENROUTER = !!OPENROUTER_KEY
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const anthropic = USE_OPENROUTER
  ? new Anthropic({
      apiKey: OPENROUTER_KEY!,
      baseURL: 'https://openrouter.ai/api',
      defaultHeaders: { 'HTTP-Referer': 'https://cramkit.app', 'X-Title': 'cramkit' },
    })
  : new Anthropic({ apiKey: ANTHROPIC_KEY! })

const MODEL = USE_OPENROUTER ? 'anthropic/claude-sonnet-4-6' : 'claude-sonnet-4-6'
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = join(REPO_ROOT, 'data', 'extracted-concepts', 'experiments')

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const MODULE_SLUG = arg('--module')
const WEEK = parseInt(arg('--week') ?? '1')
const ONLY_VARIANT = arg('--variant') // optional: run just one

if (!MODULE_SLUG) {
  console.error('Usage: tsx scripts/extract-concepts-experiment.ts --module <slug> [--week N] [--variant <name>]')
  process.exit(1)
}

// ----------------------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------------------
interface SourceRow {
  id: string
  source_type: 'lecture' | 'slides' | string
  code: string
  week: number | null
  lecture: string | null
}

interface ChunkRow {
  id: string
  source_id: string
  chunk_index: number
  text: string
}

interface SourceWithChunks {
  source: SourceRow
  chunks: ChunkRow[]
}

async function loadWeek(moduleSlug: string, week: number): Promise<SourceWithChunks[]> {
  const { data: sources, error } = await sb
    .from('sources')
    .select('id, source_type, code, week, lecture')
    .eq('module', moduleSlug)
    .eq('week', week)
    .order('source_type', { ascending: true })
    .order('lecture', { ascending: true })
  if (error) throw error

  const out: SourceWithChunks[] = []
  for (const s of (sources ?? []) as SourceRow[]) {
    const { data: chunks, error: chErr } = await sb
      .from('source_chunks')
      .select('id, source_id, chunk_index, text')
      .eq('source_id', s.id)
      .order('chunk_index')
    if (chErr) throw chErr
    out.push({ source: s, chunks: (chunks ?? []) as ChunkRow[] })
  }
  return out
}

// ----------------------------------------------------------------------------
// Claude call wrapper
// ----------------------------------------------------------------------------
async function callClaude<T>(systemPrompt: string, userContent: string, label: string, maxTokens = 8192): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      })
      const text = res.content[0].type === 'text' ? res.content[0].text : ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) throw new Error(`${label}: no JSON found`)
      return JSON.parse(m[0]) as T
    } catch (err) {
      attempt++
      if (attempt > 3) throw err
      const wait = 2000 * attempt
      console.warn(`  ${label} retry ${attempt} after ${wait}ms — ${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

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

// ----------------------------------------------------------------------------
// VARIANTS
// Each variant is a different strategy. Some change only the prompt; others
// change the structure (single call vs per-lecture, with or without a
// consolidation pass).
// ----------------------------------------------------------------------------

// === A: BASELINE (current production prompt, per-lecture + consolidation) ===
const A_LECTURE_PROMPT = `You are an expert educator extracting concepts from a university lecture transcript.

Your job is to identify EVERY distinct concept the lecturer discussed, no matter how small. Be granular, not abstract — separate concepts even when they're related. A typical 50-minute lecture should yield 8-20 concepts.

The transcript is presented as a numbered list of chunks. Each chunk has an id (UUID) and the text the lecturer said in that ~60-second window. When you identify a concept, return the chunk IDs where it was discussed in source_chunk_ids.

Return ONLY a JSON object:
{
  "concepts": [
    {
      "name": "Short concept name (3-6 words)",
      "description": "2-3 sentences explaining what this concept is and why it matters",
      "key_facts": ["atomic fact 1", "atomic fact 2", "..."],
      "difficulty": 3,
      "source_chunk_ids": ["uuid1", "uuid2"]
    }
  ]
}

Guidelines:
- Each concept should be the size of one exam question's worth of knowledge
- Key facts should be atomic — one claim per fact, the kind of thing you could quiz a student on
- Difficulty: 1 = basic recall, 3 = applying it, 5 = deep understanding / proofs / non-obvious implications
- Skip administrative content (housekeeping, exam logistics, breaks, "any questions?")
- Skip pure repetitions of points already covered
- Use the exact terminology the lecturer uses
- source_chunk_ids must reference real IDs from the input — never invent UUIDs
- Be thorough. Missing concepts is worse than including borderline ones.`

// === B: TIGHT (4-8 per lecture, drop examples and asides) ===
const B_LECTURE_PROMPT = `You are an expert educator building a revision concept list from a university lecture transcript.

Extract 4-8 concepts from this lecture. Each concept should be the size of ONE FULL EXAM QUESTION worth 5-10 marks — the kind of thing a student would be asked to explain, derive, or apply.

The transcript is presented as numbered chunks. Each has an id (UUID) and ~60s of speech. When you identify a concept, return source_chunk_ids of the chunks that ground it.

Return ONLY a JSON object:
{
  "concepts": [
    {
      "name": "Canonical concept name (3-7 words, like a textbook chapter heading)",
      "description": "2-3 sentences explaining what this concept is and why it matters",
      "key_facts": ["atomic fact 1", "atomic fact 2", "..."],
      "difficulty": 3,
      "source_chunk_ids": ["uuid1", "uuid2"]
    }
  ]
}

CRITICAL — what to SKIP:
- Course logistics: curriculum overviews, prerequisites, "what we'll cover", office hours
- Historical context and named examples (Viola-Jones, Minimax, AlphaGo, "in 2012...") — these are illustrations, not concepts a student must master unless the lecturer is teaching the technique itself
- Mathematical asides (e.g. "monotonic functions preserve argmin") — fold these into the parent concept's key_facts
- Single sentences that don't sustain 5 minutes of explanation

When in doubt, MERGE adjacent ideas into one concept with more key_facts. Better one concept "Loss Functions for Regression" with MSE, MAE, and their estimator implications as facts, than three separate concepts.

Use canonical naming from the field, not paraphrases. "Backpropagation Algorithm" not "How gradients flow backward through networks".

source_chunk_ids must be real UUIDs from the input — never invent.`

// === C: TARGET-COUNT ANCHORED (explicit count target with reasoning) ===
const C_LECTURE_PROMPT = `You are extracting concepts from a single university lecture (~50 minutes).

A typical 50-minute lecture in a UK MSc-level CS course covers between 3 and 6 distinct concepts that students will be examined on. Your task is to identify those concepts.

INPUT: numbered chunks of transcript text, each with a UUID and ~60s of speech.

OUTPUT: ONLY a JSON object of this shape:
{
  "concepts": [
    {
      "name": "...",
      "description": "2-3 sentences",
      "key_facts": ["...", "..."],
      "difficulty": 3,
      "source_chunk_ids": ["..."]
    }
  ]
}

Process:
1. Read the entire transcript first to understand what the lecture is about.
2. Identify 3-6 concepts. Each must be substantial enough that the lecturer spent at least 5 minutes on it AND would survive as an exam question.
3. For each concept, extract the chunk IDs where it was discussed, the canonical name, a brief description, and 4-8 atomic key facts.

Things that are NOT concepts:
- Administrative content (anything about the course itself rather than the subject)
- Examples and analogies the lecturer used to illustrate a concept (these are key_facts, not their own concepts)
- Mathematical asides made in passing
- Historical anecdotes ("when this was invented...")
- Names of past systems or papers, unless the lecturer is teaching the technique they introduced

If a lecture really only covers 2 concepts (rare but possible), return 2. If it covers 6 (also rare), return 6. Don't pad. Don't fragment.

Use canonical, textbook-style names. source_chunk_ids must be real UUIDs from the input.`

// === D: WHOLE-WEEK SINGLE CALL ===
// Send all of week's chunks at once and ask for the week-level concept list directly.
// Skips the per-lecture extract + consolidation entirely.
const D_WEEK_PROMPT = `You are extracting concepts from one week of a university course (typically 2-3 lectures, ~3 hours of teaching).

A typical week of a UK MSc-level CS course covers 5-10 distinct concepts that students will be examined on. Your task is to identify those concepts from all the lecture transcripts and slide chunks below.

INPUT: numbered chunks from multiple sources (transcripts and slides). Each has a UUID, a source label (e.g. "nc1.1", "neuralcomp-slides-w1"), and the content text.

OUTPUT: ONLY a JSON object:
{
  "concepts": [
    {
      "name": "Canonical textbook-style name",
      "description": "2-3 sentences",
      "key_facts": ["atomic fact 1", "atomic fact 2", "..."],
      "difficulty": 3,
      "source_chunk_ids": ["uuid1", "uuid2", "..."]
    }
  ]
}

Rules:
- Aim for 5-10 concepts for the week. Don't fragment closely related ideas.
- Each concept must be substantial enough to be an exam question worth 5-10 marks.
- source_chunk_ids should include EVERY chunk where the concept appears (across both transcripts and slides) — typically 3-15 chunk ids per concept.
- SKIP: course logistics, historical anecdotes, named example systems used purely as illustration, mathematical asides.
- USE canonical naming. "Backpropagation" not "How gradients flow backwards".
- When you see the same concept in both a slide and a transcript, merge them and union the chunk IDs.`

// ----------------------------------------------------------------------------
// Variant runners
// ----------------------------------------------------------------------------
type VariantFn = (sources: SourceWithChunks[]) => Promise<{ concepts: ExtractedConcept[]; raw_count?: number; calls: number }>

// Per-lecture extract → flatten (variants A, B, C). No consolidation pass for
// the experiment — we want to see the raw per-lecture output too. The week-level
// merge can be evaluated separately.
function makePerLectureVariant(systemPrompt: string): VariantFn {
  return async (sources) => {
    const lectures = sources.filter((s) => s.source.source_type === 'lecture')
    let calls = 0
    const all: ExtractedConcept[] = []
    for (const { source, chunks } of lectures) {
      if (chunks.length === 0) continue
      const userContent = chunks.map((c) => `[chunk_id=${c.id}] ${c.text}`).join('\n\n')
      console.log(`    extracting ${source.code} (${chunks.length} chunks)`)
      const res = await callClaude<ExtractResponse>(systemPrompt, userContent, source.code)
      calls++
      all.push(...res.concepts)
    }
    return { concepts: all, raw_count: all.length, calls }
  }
}

// Whole-week single call (variant D)
const variantD: VariantFn = async (sources) => {
  const userParts: string[] = []
  for (const { source, chunks } of sources) {
    for (const ch of chunks) {
      userParts.push(`[chunk_id=${ch.id}] (${source.code}) ${ch.text}`)
    }
  }
  const userContent = userParts.join('\n\n')
  console.log(`    single call with ${userParts.length} chunks (~${Math.round(userContent.length / 4)} tokens)`)
  // Bigger output budget — week-level concepts can be long
  const res = await callClaude<ExtractResponse>(D_WEEK_PROMPT, userContent, 'whole-week', 16384)
  return { concepts: res.concepts, raw_count: res.concepts.length, calls: 1 }
}

const VARIANTS: Record<string, { description: string; run: VariantFn }> = {
  a_baseline: {
    description: 'Current production prompt (per-lecture, 8-20 target). No consolidation in this experiment.',
    run: makePerLectureVariant(A_LECTURE_PROMPT),
  },
  b_tight: {
    description: 'Tightened per-lecture prompt: 4-8 target, explicit skip rules, merge guidance.',
    run: makePerLectureVariant(B_LECTURE_PROMPT),
  },
  c_target_count: {
    description: 'Anchored at 3-6 per lecture with a "read first, then identify" process and harder skip rules.',
    run: makePerLectureVariant(C_LECTURE_PROMPT),
  },
  d_whole_week: {
    description: 'Single call covering all lectures + slides for the whole week. No per-lecture step, no consolidation.',
    run: variantD,
  },
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  console.log(`\nExperiment: ${MODULE_SLUG} week ${WEEK}`)
  console.log(`Provider: ${USE_OPENROUTER ? 'OpenRouter' : 'Anthropic direct'}`)
  console.log(`Model: ${MODEL}\n`)

  const sources = await loadWeek(MODULE_SLUG!, WEEK)
  const lectures = sources.filter((s) => s.source.source_type === 'lecture')
  const slides = sources.filter((s) => s.source.source_type === 'slides')
  console.log(`Loaded ${lectures.length} lectures and ${slides.length} slide deck(s)`)
  for (const { source, chunks } of sources) {
    console.log(`  ${source.code} (${source.source_type}): ${chunks.length} chunks`)
  }

  mkdirSync(OUT_DIR, { recursive: true })

  const variantNames = ONLY_VARIANT ? [ONLY_VARIANT] : Object.keys(VARIANTS)
  const summary: Array<{ variant: string; count: number; calls: number; names: string[] }> = []

  for (const name of variantNames) {
    const variant = VARIANTS[name]
    if (!variant) {
      console.warn(`\n⚠ Unknown variant: ${name}`)
      continue
    }
    console.log(`\n=== ${name} ===`)
    console.log(`  ${variant.description}`)
    const start = Date.now()
    try {
      const result = await variant.run(sources)
      const elapsed = Math.round((Date.now() - start) / 1000)
      console.log(`  → ${result.concepts.length} concepts in ${result.calls} call(s), ${elapsed}s`)

      const outFile = join(OUT_DIR, `${MODULE_SLUG}-w${WEEK}-${name}.json`)
      writeFileSync(
        outFile,
        JSON.stringify(
          {
            module: MODULE_SLUG,
            week: WEEK,
            variant: name,
            description: variant.description,
            generated_at: new Date().toISOString(),
            calls: result.calls,
            total_concepts: result.concepts.length,
            concepts: result.concepts,
          },
          null,
          2,
        ),
      )
      console.log(`  ✓ wrote ${outFile}`)

      summary.push({
        variant: name,
        count: result.concepts.length,
        calls: result.calls,
        names: result.concepts.map((c) => c.name),
      })
    } catch (err) {
      console.error(`  ✗ failed: ${(err as Error).message}`)
    }
  }

  // ─── Summary ───
  console.log('\n\n=== SUMMARY ===')
  for (const s of summary) {
    console.log(`\n${s.variant}: ${s.count} concepts (${s.calls} calls)`)
    for (const n of s.names) console.log(`  · ${n}`)
  }
  console.log('\nReview the JSON files in data/extracted-concepts/experiments/')
}

main().catch((err) => {
  console.error('\nFatal:', err)
  process.exit(1)
})
