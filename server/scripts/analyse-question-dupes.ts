/**
 * Analyse near-duplicate questions across the bank.
 *
 * READ-ONLY: this script does not delete or modify anything. It embeds every
 * question, computes pairwise cosine similarity within each concept, and
 * prints a histogram + the worst offenders so we can pick a sensible
 * dedup threshold by hand.
 *
 * Run:
 *   cd server && npx tsx scripts/analyse-question-dupes.ts
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

interface QuestionRow {
  id: string
  concept_id: string
  question: string
  type: string
  difficulty: number
  created_at: string
}

interface ConceptRow {
  id: string
  name: string
  module_ids: string[]
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

async function embedBatch(texts: string[]): Promise<number[][]> {
  const BATCH = 100
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: slice })
    for (const item of res.data) out.push(item.embedding)
    process.stdout.write(`  embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}\r`)
  }
  process.stdout.write('\n')
  return out
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

interface Pair {
  conceptId: string
  conceptName: string
  moduleSlug: string
  qa: QuestionRow
  qb: QuestionRow
  sim: number
}

async function main() {
  console.log('Loading concepts and questions…')
  const concepts = await fetchAll<ConceptRow>('concepts', 'id, name, module_ids')
  const questions = await fetchAll<QuestionRow>('questions', 'id, concept_id, question, type, difficulty, created_at')
  const exams = await fetchAll<{ id: string; slug: string; name: string }>('exams', 'id, slug, name')
  const examById = new Map(exams.map((e) => [e.id, e]))
  const conceptById = new Map(concepts.map((c) => [c.id, c]))

  console.log(`  ${concepts.length} concepts, ${questions.length} questions`)

  // Group questions by concept
  const byConcept = new Map<string, QuestionRow[]>()
  for (const q of questions) {
    if (!byConcept.has(q.concept_id)) byConcept.set(q.concept_id, [])
    byConcept.get(q.concept_id)!.push(q)
  }

  // Only embed questions that belong to concepts with >1 question — singletons
  // can't have dupes.
  const toEmbed: QuestionRow[] = []
  for (const [, qs] of byConcept) {
    if (qs.length > 1) toEmbed.push(...qs)
  }
  console.log(`Embedding ${toEmbed.length} questions (concepts with ≥2 questions)…`)

  const embeddings = await embedBatch(toEmbed.map((q) => q.question))
  const embById = new Map<string, number[]>()
  for (let i = 0; i < toEmbed.length; i++) {
    embById.set(toEmbed[i].id, embeddings[i])
  }

  // Compute every within-concept pair
  console.log('Computing pairwise similarities…')
  const allPairs: Pair[] = []
  for (const [conceptId, qs] of byConcept) {
    if (qs.length < 2) continue
    const concept = conceptById.get(conceptId)
    if (!concept) continue
    const exam = concept.module_ids.map((mid) => examById.get(mid)).find(Boolean)
    const moduleSlug = exam?.slug ?? '?'
    for (let i = 0; i < qs.length; i++) {
      for (let j = i + 1; j < qs.length; j++) {
        const ea = embById.get(qs[i].id)
        const eb = embById.get(qs[j].id)
        if (!ea || !eb) continue
        const sim = cosine(ea, eb)
        allPairs.push({
          conceptId,
          conceptName: concept.name,
          moduleSlug,
          qa: qs[i],
          qb: qs[j],
          sim,
        })
      }
    }
  }
  console.log(`  ${allPairs.length} pairs total`)

  // ---- Histogram of pair similarities -------------------------------------
  console.log('\n=== Histogram of pair-wise cosine similarity ===')
  const bins = [
    { label: '< 0.50', test: (s: number) => s < 0.5 },
    { label: '0.50–0.60', test: (s: number) => s >= 0.5 && s < 0.6 },
    { label: '0.60–0.70', test: (s: number) => s >= 0.6 && s < 0.7 },
    { label: '0.70–0.75', test: (s: number) => s >= 0.7 && s < 0.75 },
    { label: '0.75–0.80', test: (s: number) => s >= 0.75 && s < 0.8 },
    { label: '0.80–0.85', test: (s: number) => s >= 0.8 && s < 0.85 },
    { label: '0.85–0.90', test: (s: number) => s >= 0.85 && s < 0.9 },
    { label: '0.90–0.93', test: (s: number) => s >= 0.9 && s < 0.93 },
    { label: '0.93–0.95', test: (s: number) => s >= 0.93 && s < 0.95 },
    { label: '0.95–0.97', test: (s: number) => s >= 0.95 && s < 0.97 },
    { label: '0.97–1.00', test: (s: number) => s >= 0.97 },
  ]
  for (const bin of bins) {
    const count = allPairs.filter((p) => bin.test(p.sim)).length
    const pct = ((count / allPairs.length) * 100).toFixed(1)
    const bar = '█'.repeat(Math.round(count / Math.max(1, allPairs.length / 100)))
    console.log(`  ${bin.label.padEnd(11)} ${count.toString().padStart(6)} (${pct}%) ${bar}`)
  }

  // ---- Cumulative count above each candidate threshold -------------------
  console.log('\n=== How many pairs would be flagged at each threshold ===')
  const thresholds = [0.80, 0.83, 0.85, 0.87, 0.88, 0.90, 0.92, 0.95]
  for (const t of thresholds) {
    const count = allPairs.filter((p) => p.sim >= t).length
    const concepts = new Set(allPairs.filter((p) => p.sim >= t).map((p) => p.conceptId)).size
    console.log(`  ≥ ${t.toFixed(2)} : ${count.toString().padStart(5)} pairs across ${concepts} concept(s)`)
  }

  // ---- Sample pairs at each threshold band so we can eyeball them --------
  function printSample(label: string, lo: number, hi: number, n = 6) {
    console.log(`\n=== Sample pairs in ${label} (sim ${lo.toFixed(2)}–${hi.toFixed(2)}) ===`)
    const eligible = allPairs.filter((p) => p.sim >= lo && p.sim < hi)
    if (eligible.length === 0) {
      console.log('  (none)')
      return
    }
    // Stratify by module so we don't only see one module's quirks.
    const shuffled = eligible.sort(() => Math.random() - 0.5).slice(0, n)
    for (const p of shuffled) {
      console.log(`  [${p.sim.toFixed(3)}] ${p.moduleSlug} · "${p.conceptName}"`)
      console.log(`    A (${p.qa.type}, d${p.qa.difficulty}): ${p.qa.question.slice(0, 140)}`)
      console.log(`    B (${p.qb.type}, d${p.qb.difficulty}): ${p.qb.question.slice(0, 140)}`)
    }
  }

  printSample('the suspicious zone',     0.95, 1.01, 8)
  printSample('the borderline-high',     0.90, 0.95, 8)
  printSample('the maybe-dupe',          0.85, 0.90, 8)
  printSample('the probably-not-dupe',   0.80, 0.85, 6)
  printSample('the just-related',        0.70, 0.75, 4)

  // ---- Worst-offending concepts ------------------------------------------
  console.log('\n=== Concepts with the most pairs ≥ 0.90 ===')
  const concept2HighPairs = new Map<string, number>()
  for (const p of allPairs) {
    if (p.sim >= 0.9) {
      concept2HighPairs.set(p.conceptId, (concept2HighPairs.get(p.conceptId) ?? 0) + 1)
    }
  }
  const ranked = [...concept2HighPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  for (const [cid, count] of ranked) {
    const c = conceptById.get(cid)
    if (!c) continue
    const total = byConcept.get(cid)?.length ?? 0
    console.log(`  ${count.toString().padStart(3)} dupe pairs · ${total} total questions · ${c.name}`)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
