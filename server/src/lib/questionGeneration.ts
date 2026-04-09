/**
 * Batch question generation for the admin content pipeline.
 *
 * Walks every concept in a module that has zero questions (or all of them
 * with --replace), runs the existing per-concept grounded generator, and
 * persists the results into the `questions` table.
 *
 * The per-concept work happens in `generateForConcept` over in
 * server/src/routes/ingestion.ts — that's the same function the existing
 * browser-side admin UI uses, so the question quality and grounding rules
 * are identical. This wrapper just runs it in a server-side loop with
 * progress callbacks for the admin UI.
 *
 * Cost-wise: this uses the server-side Anthropic key (or OpenRouter if
 * OPENROUTER_API_KEY is set). Admin pays, not BYOK users.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { generateForConcept } from '../routes/ingestion.js'

function getServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  return createClient(url, key, { auth: { persistSession: false } })
}

interface ConceptRow {
  id: string
  name: string
  description: string
  key_facts: string[]
  difficulty: number
  module_ids: string[]
}

interface QuestionCount {
  concept_id: string
}

export interface GenerationProgress {
  concepts_total: number
  concepts_done: number
  questions_generated: number
  failures: number
  current?: string
}

export interface GenerationOptions {
  /** Module slug — only concepts belonging to this module are processed. */
  moduleSlug: string
  /** Admin user id whose concepts should be targeted. */
  ownerUserId: string
  /** 'missing' (default) only generates for concepts with 0 questions; 'all' regenerates everything. */
  scope?: 'missing' | 'all'
  onProgress?: (p: GenerationProgress) => void | Promise<void>
  onLog?: (line: string) => void | Promise<void>
}

export interface GenerationResult {
  module: string
  concepts_processed: number
  questions_generated: number
  failures: number
}

export async function runQuestionGeneration(opts: GenerationOptions): Promise<GenerationResult> {
  const sb = getServiceClient()
  const log = opts.onLog ?? (() => {})
  const reportProgress = opts.onProgress ?? (() => {})
  const scope = opts.scope ?? 'missing'

  await log(`Question generation: module=${opts.moduleSlug} scope=${scope}`)

  const { data: exam, error: examErr } = await sb
    .from('exams')
    .select('id, name')
    .eq('slug', opts.moduleSlug)
    .single()
  if (examErr || !exam) {
    throw new Error(`No exam row for slug "${opts.moduleSlug}": ${examErr?.message ?? 'not found'}`)
  }

  // Load all concepts for this module under the admin user, paginated.
  const PAGE = 1000
  const concepts: ConceptRow[] = []
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('concepts')
      .select('id, name, description, key_facts, difficulty, module_ids')
      .eq('user_id', opts.ownerUserId)
      .contains('module_ids', [exam.id])
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as ConceptRow[]
    concepts.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  await log(`Loaded ${concepts.length} concept(s) for ${opts.moduleSlug}`)

  // Filter to concepts with no questions (default scope)
  let toProcess = concepts
  if (scope === 'missing') {
    const conceptIds = concepts.map((c) => c.id)
    const counts = new Map<string, number>()
    if (conceptIds.length > 0) {
      const QPAGE = 1000
      let qFrom = 0
      while (true) {
        const { data, error } = await sb
          .from('questions')
          .select('concept_id')
          .in('concept_id', conceptIds)
          .range(qFrom, qFrom + QPAGE - 1)
        if (error) throw error
        const rows = (data ?? []) as QuestionCount[]
        for (const r of rows) counts.set(r.concept_id, (counts.get(r.concept_id) ?? 0) + 1)
        if (rows.length < QPAGE) break
        qFrom += QPAGE
      }
    }
    toProcess = concepts.filter((c) => (counts.get(c.id) ?? 0) === 0)
    await log(`${toProcess.length} concept(s) have zero questions and will be processed`)
  }

  if (toProcess.length === 0) {
    await log(`Nothing to do.`)
    return {
      module: opts.moduleSlug,
      concepts_processed: 0,
      questions_generated: 0,
      failures: 0,
    }
  }

  await reportProgress({
    concepts_total: toProcess.length,
    concepts_done: 0,
    questions_generated: 0,
    failures: 0,
  })

  let done = 0
  let totalQuestions = 0
  let failures = 0

  // Sequential — generateForConcept is heavy (one Sonnet call per concept,
  // plus a vector search). Running 4-8 in parallel would saturate both rate
  // limits and our DB connection pool.
  for (const concept of toProcess) {
    await log(`[${done + 1}/${toProcess.length}] ${concept.name}`)
    try {
      const result = await generateForConcept(
        {
          name: concept.name,
          description: concept.description,
          key_facts: concept.key_facts ?? [],
          difficulty: concept.difficulty ?? 3,
        },
        opts.moduleSlug,
        opts.ownerUserId,
        [],
      )
      const generated = result.questions
      if (generated.length > 0) {
        const rows = generated.map((q) => ({
          user_id: opts.ownerUserId,
          concept_id: concept.id,
          type: q.type,
          difficulty: q.difficulty,
          question: q.question,
          options: q.options ?? null,
          correct_answer: q.correct_answer,
          explanation: q.explanation,
          source: 'batch',
          times_used: 0,
          is_past_paper: false,
          source_chunk_ids: q.source_chunk_ids,
          evidence_quote: q.evidence_quote,
        }))
        const { error } = await sb.from('questions').insert(rows)
        if (error) {
          await log(`  insert failed: ${error.message}`)
          failures++
        } else {
          totalQuestions += generated.length
          await log(`  → ${generated.length} question(s)`)
        }
      } else {
        await log(`  → 0 question(s) (no grounded evidence)`)
      }
    } catch (err) {
      failures++
      await log(`  FAILED: ${(err as Error).message}`)
    }
    done++
    await reportProgress({
      concepts_total: toProcess.length,
      concepts_done: done,
      questions_generated: totalQuestions,
      failures,
      current: concept.name,
    })
  }

  await log(`Done. ${totalQuestions} questions generated across ${done} concept(s), ${failures} failures.`)
  return {
    module: opts.moduleSlug,
    concepts_processed: done,
    questions_generated: totalQuestions,
    failures,
  }
}
