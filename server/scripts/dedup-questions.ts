/**
 * Three-tier question dedup.
 *
 *   ≥ 0.92  → auto-delete
 *   0.85–0.92 → print for manual review (no action)
 *   < 0.85  → ignore
 *
 * Tie-breaker for "which one survives a dupe pair":
 *   1. Higher difficulty wins
 *   2. Longer evidence_quote wins
 *   3. Older created_at wins
 *
 * Within a single concept we may have multiple overlapping pairs (A~B,
 * B~C, A~C). We resolve this with a union-find: every pair ≥ AUTO_THRESHOLD
 * merges its two questions into the same cluster, then we keep one survivor
 * per cluster (chosen by the tie-breaker against every member of the cluster)
 * and delete the rest.
 *
 * Run:
 *   cd server && npx tsx scripts/dedup-questions.ts            # dry run
 *   cd server && npx tsx scripts/dedup-questions.ts --commit   # actually delete
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

const COMMIT = process.argv.includes('--commit')
const AUTO_THRESHOLD = 0.92
const REVIEW_THRESHOLD = 0.85

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const openai = new OpenAI({ apiKey: OPENAI_KEY })

interface QuestionRow {
  id: string
  concept_id: string
  question: string
  type: string
  difficulty: number
  evidence_quote: string | null
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

// ---- Union-find ----------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }
  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
  groups(items: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    for (const it of items) {
      const root = this.find(it)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root)!.push(it)
    }
    return groups
  }
}

// ---- Tie-breaker: pick the survivor of a cluster ------------------------

function pickSurvivor(qs: QuestionRow[]): QuestionRow {
  // Higher difficulty > longer evidence > older created_at.
  return [...qs].sort((a, b) => {
    if (b.difficulty !== a.difficulty) return b.difficulty - a.difficulty
    const la = a.evidence_quote?.length ?? 0
    const lb = b.evidence_quote?.length ?? 0
    if (lb !== la) return lb - la
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })[0]
}

async function main() {
  console.log(`Mode: ${COMMIT ? '\x1b[31mCOMMIT (will delete)\x1b[0m' : 'dry run'}`)
  console.log(`Auto-delete threshold:    ${AUTO_THRESHOLD}`)
  console.log(`Manual-review threshold:  ${REVIEW_THRESHOLD}`)
  console.log()

  console.log('Loading concepts and questions…')
  const concepts = await fetchAll<ConceptRow>('concepts', 'id, name, module_ids')
  const questions = await fetchAll<QuestionRow>('questions', 'id, concept_id, question, type, difficulty, evidence_quote, created_at')
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

  const toEmbed: QuestionRow[] = []
  for (const [, qs] of byConcept) {
    if (qs.length > 1) toEmbed.push(...qs)
  }
  console.log(`Embedding ${toEmbed.length} questions (concepts with ≥2 questions)…`)
  const embeddings = await embedBatch(toEmbed.map((q) => q.question))
  const embById = new Map<string, number[]>()
  for (let i = 0; i < toEmbed.length; i++) embById.set(toEmbed[i].id, embeddings[i])

  // ---- Pass 1: collect every pair, split into auto + review ------------
  interface Pair {
    conceptId: string
    conceptName: string
    moduleSlug: string
    qa: QuestionRow
    qb: QuestionRow
    sim: number
  }

  const autoPairs: Pair[] = []
  const reviewPairs: Pair[] = []

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
        const pair: Pair = { conceptId, conceptName: concept.name, moduleSlug, qa: qs[i], qb: qs[j], sim }
        if (sim >= AUTO_THRESHOLD) autoPairs.push(pair)
        else if (sim >= REVIEW_THRESHOLD) reviewPairs.push(pair)
      }
    }
  }

  console.log(`\n${autoPairs.length} pair(s) ≥ ${AUTO_THRESHOLD} (auto-delete)`)
  console.log(`${reviewPairs.length} pair(s) in [${REVIEW_THRESHOLD}, ${AUTO_THRESHOLD}) (manual review)`)

  // ---- Pass 2: cluster auto-delete pairs per concept via union-find ----
  // Build a per-concept UF and gather survivors + losers.
  const losers: { qid: string; survivorId: string; sim: number; reason: string }[] = []
  const perConceptPlans = new Map<string, {
    name: string
    moduleSlug: string
    clusters: { survivor: QuestionRow; deleted: QuestionRow[]; reason: string }[]
  }>()

  // Group auto pairs by concept so each UF only sees its own questions.
  const autoPairsByConcept = new Map<string, Pair[]>()
  for (const p of autoPairs) {
    if (!autoPairsByConcept.has(p.conceptId)) autoPairsByConcept.set(p.conceptId, [])
    autoPairsByConcept.get(p.conceptId)!.push(p)
  }

  for (const [conceptId, pairs] of autoPairsByConcept) {
    const uf = new UnionFind()
    for (const p of pairs) uf.union(p.qa.id, p.qb.id)

    const involvedIds = new Set<string>()
    for (const p of pairs) {
      involvedIds.add(p.qa.id)
      involvedIds.add(p.qb.id)
    }
    const involved = byConcept.get(conceptId)!.filter((q) => involvedIds.has(q.id))
    const groups = uf.groups([...involvedIds])

    const concept = conceptById.get(conceptId)!
    const exam = concept.module_ids.map((mid) => examById.get(mid)).find(Boolean)
    const moduleSlug = exam?.slug ?? '?'

    const plan: typeof perConceptPlans extends Map<string, infer V> ? V : never = {
      name: concept.name,
      moduleSlug,
      clusters: [],
    }

    for (const [, ids] of groups) {
      if (ids.length < 2) continue
      const members = involved.filter((q) => ids.includes(q.id))
      const survivor = pickSurvivor(members)
      const deleted = members.filter((q) => q.id !== survivor.id)
      // Use the highest sim against survivor as the "reason" for each loser
      for (const d of deleted) {
        // Find the pair sim between d and survivor (if it was a direct pair)
        // or note it was via transitive closure.
        const direct = pairs.find(
          (p) =>
            (p.qa.id === d.id && p.qb.id === survivor.id) ||
            (p.qb.id === d.id && p.qa.id === survivor.id),
        )
        const sim = direct?.sim ?? Math.max(
          ...pairs
            .filter((p) => p.qa.id === d.id || p.qb.id === d.id)
            .map((p) => p.sim),
        )
        const reason = direct ? 'direct dupe' : 'transitive cluster'
        losers.push({ qid: d.id, survivorId: survivor.id, sim, reason })
      }
      plan.clusters.push({
        survivor,
        deleted,
        reason: deleted.length === 1 ? 'pair' : `cluster of ${members.length}`,
      })
    }
    if (plan.clusters.length > 0) perConceptPlans.set(conceptId, plan)
  }

  // ---- Print the auto-delete plan --------------------------------------
  console.log('\n========================================================================')
  console.log('AUTO-DELETE PLAN')
  console.log('========================================================================')
  let totalDeletions = 0
  for (const [, plan] of perConceptPlans) {
    console.log(`\n[${plan.moduleSlug}] ${plan.name}`)
    for (const cluster of plan.clusters) {
      console.log(`  cluster of ${1 + cluster.deleted.length} (${cluster.reason}):`)
      console.log(`    ✔ keep   (d${cluster.survivor.difficulty}, ${cluster.survivor.evidence_quote?.length ?? 0}c evidence): ${cluster.survivor.question.slice(0, 130)}`)
      for (const d of cluster.deleted) {
        console.log(`    ✘ delete (d${d.difficulty}, ${d.evidence_quote?.length ?? 0}c evidence): ${d.question.slice(0, 130)}`)
        totalDeletions++
      }
    }
  }
  console.log(`\nTotal questions to delete: ${totalDeletions}`)

  // ---- Print the manual-review queue -----------------------------------
  console.log('\n========================================================================')
  console.log('MANUAL REVIEW QUEUE (0.85 ≤ sim < 0.92) — no action taken')
  console.log('========================================================================')
  // Sort by sim descending so the closest-but-not-auto are first.
  reviewPairs.sort((a, b) => b.sim - a.sim)
  for (const p of reviewPairs) {
    console.log(`\n  [${p.sim.toFixed(3)}] ${p.moduleSlug} · ${p.conceptName}`)
    console.log(`    A (${p.qa.id.slice(0, 8)}, d${p.qa.difficulty}): ${p.qa.question.slice(0, 140)}`)
    console.log(`    B (${p.qb.id.slice(0, 8)}, d${p.qb.difficulty}): ${p.qb.question.slice(0, 140)}`)
  }
  console.log(`\n${reviewPairs.length} pair(s) need a human eyeball.`)

  // ---- Apply (or not) ---------------------------------------------------
  if (!COMMIT) {
    console.log('\nDry run — no changes made. Re-run with --commit to apply the auto-delete plan.')
    return
  }

  console.log(`\nDeleting ${totalDeletions} question(s)…`)
  const ids = losers.map((l) => l.qid)
  // Chunked delete to stay within URL length limits.
  const CHUNK = 100
  let deleted = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { error } = await sb.from('questions').delete().in('id', slice)
    if (error) throw new Error(`delete failed at chunk starting ${i}: ${error.message}`)
    deleted += slice.length
    process.stdout.write(`  deleted ${deleted}/${ids.length}\r`)
  }
  process.stdout.write('\n')
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
