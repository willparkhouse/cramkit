/**
 * Hallucinated-concept audit.
 *
 * READ-ONLY. For every concept, embed `name + description + key_facts`,
 * retrieve the top source chunks for its module, and report the max cosine
 * similarity. Concepts where the best chunk match is weak are likely mentioned
 * only in passing in the user's notes (or hallucinated entirely) and probably
 * shouldn't be quizzed on.
 *
 * Run:
 *   cd server && npx tsx scripts/audit-concepts.ts
 *   cd server && npx tsx scripts/audit-concepts.ts --threshold 0.55
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_KEY = process.env.OPENAI_API_KEY!

if (!SUPABASE_URL || !SERVICE_KEY || !OPENAI_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const openai = new OpenAI({ apiKey: OPENAI_KEY })

const thresholdArgIdx = process.argv.indexOf('--threshold')
const FLAG_THRESHOLD = thresholdArgIdx >= 0 ? parseFloat(process.argv[thresholdArgIdx + 1]) : 0.55

interface ConceptRow {
  id: string
  name: string
  description: string
  key_facts: string[] | null
  module_ids: string[]
}

interface ExamRow { id: string; slug: string; name: string }

interface ChunkResult {
  source_code: string
  source_type: string
  chunk_text: string
  similarity: number
}

async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
}

async function matchChunks(embedding: number[], moduleSlug: string, count = 5): Promise<ChunkResult[]> {
  // Use the same RPC the rest of the app uses for source-chunk retrieval
  // so the audit reflects actual production retrieval behaviour.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_source_chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: count,
      module_filter: moduleSlug,
      source_types: null,
    }),
  })
  if (!res.ok) {
    throw new Error(`match_source_chunks failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as ChunkResult[]
}

interface AuditRow {
  conceptId: string
  conceptName: string
  moduleSlug: string
  maxSim: number
  topChunkPreview: string
  topChunkSource: string
  questionCount: number
}

async function main() {
  console.log('Loading concepts and exams…')
  const concepts = await fetchAll<ConceptRow>('concepts', 'id, name, description, key_facts, module_ids')
  const exams = await fetchAll<ExamRow>('exams', 'id, slug, name')
  const examById = new Map(exams.map((e) => [e.id, e]))

  // Question counts per concept (paginate to bypass 1000-row limit)
  const questions = await fetchAll<{ concept_id: string }>('questions', 'concept_id')
  const qPerConcept = new Map<string, number>()
  for (const q of questions) qPerConcept.set(q.concept_id, (qPerConcept.get(q.concept_id) ?? 0) + 1)

  console.log(`  ${concepts.length} concepts to audit`)
  console.log(`  flag threshold: max similarity < ${FLAG_THRESHOLD}\n`)

  const results: AuditRow[] = []
  let i = 0
  for (const c of concepts) {
    i++
    process.stdout.write(`  ${i}/${concepts.length}\r`)

    const exam = c.module_ids.map((mid) => examById.get(mid)).find(Boolean)
    if (!exam) continue
    const moduleSlug = exam.slug

    // Build the concept "fingerprint" used for matching. Mirrors what the
    // question generator embeds.
    const fingerprint = `${c.name}. ${c.description}. ${(c.key_facts ?? []).slice(0, 5).join('. ')}`
    let topChunks: ChunkResult[] = []
    try {
      const emb = await embed(fingerprint)
      topChunks = await matchChunks(emb, moduleSlug, 5)
    } catch (e) {
      console.warn(`\n  failed to match "${c.name}": ${(e as Error).message}`)
      continue
    }

    const maxSim = topChunks[0]?.similarity ?? 0
    const top = topChunks[0]
    results.push({
      conceptId: c.id,
      conceptName: c.name,
      moduleSlug,
      maxSim,
      topChunkPreview: top ? top.chunk_text.slice(0, 120).replace(/\s+/g, ' ') : '(no chunks returned)',
      topChunkSource: top ? `${top.source_code} (${top.source_type})` : '—',
      questionCount: qPerConcept.get(c.id) ?? 0,
    })
  }
  process.stdout.write('\n')

  // ---- Histogram --------------------------------------------------------
  console.log('\n=== Distribution of max-chunk similarity per concept ===')
  const bins = [
    { label: '< 0.30', test: (s: number) => s < 0.3 },
    { label: '0.30–0.40', test: (s: number) => s >= 0.3 && s < 0.4 },
    { label: '0.40–0.45', test: (s: number) => s >= 0.4 && s < 0.45 },
    { label: '0.45–0.50', test: (s: number) => s >= 0.45 && s < 0.5 },
    { label: '0.50–0.55', test: (s: number) => s >= 0.5 && s < 0.55 },
    { label: '0.55–0.60', test: (s: number) => s >= 0.55 && s < 0.6 },
    { label: '0.60–0.65', test: (s: number) => s >= 0.6 && s < 0.65 },
    { label: '0.65–0.70', test: (s: number) => s >= 0.65 && s < 0.7 },
    { label: '0.70–0.75', test: (s: number) => s >= 0.7 && s < 0.75 },
    { label: '0.75–0.80', test: (s: number) => s >= 0.75 && s < 0.8 },
    { label: '≥ 0.80',    test: (s: number) => s >= 0.8 },
  ]
  for (const bin of bins) {
    const n = results.filter((r) => bin.test(r.maxSim)).length
    const pct = ((n / results.length) * 100).toFixed(1)
    const bar = '█'.repeat(Math.round(n / Math.max(1, results.length / 100)))
    console.log(`  ${bin.label.padEnd(11)} ${n.toString().padStart(4)} (${pct.padStart(4)}%) ${bar}`)
  }

  // ---- Per-module breakdown --------------------------------------------
  console.log('\n=== Per-module summary ===')
  const byModule = new Map<string, AuditRow[]>()
  for (const r of results) {
    if (!byModule.has(r.moduleSlug)) byModule.set(r.moduleSlug, [])
    byModule.get(r.moduleSlug)!.push(r)
  }
  for (const [slug, rows] of [...byModule].sort()) {
    const flagged = rows.filter((r) => r.maxSim < FLAG_THRESHOLD).length
    const avg = rows.reduce((s, r) => s + r.maxSim, 0) / rows.length
    console.log(`  ${slug.padEnd(12)} ${rows.length.toString().padStart(4)} concepts · avg ${avg.toFixed(3)} · ${flagged} flagged`)
  }

  // ---- Worst offenders --------------------------------------------------
  results.sort((a, b) => a.maxSim - b.maxSim)

  console.log(`\n=== Concepts below threshold (${FLAG_THRESHOLD}) — sorted weakest first ===`)
  const flagged = results.filter((r) => r.maxSim < FLAG_THRESHOLD)
  if (flagged.length === 0) {
    console.log('  (none)')
  } else {
    for (const r of flagged) {
      console.log(`\n  [${r.maxSim.toFixed(3)}] ${r.moduleSlug} · ${r.conceptName}  (${r.questionCount} question${r.questionCount === 1 ? '' : 's'})`)
      console.log(`    best chunk: ${r.topChunkSource}`)
      console.log(`    "${r.topChunkPreview}…"`)
    }
  }

  console.log(`\n${flagged.length} concept(s) flagged out of ${results.length}.`)
  console.log('\nNote: max-similarity is a heuristic. Eyeball the chunk preview before deleting.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
