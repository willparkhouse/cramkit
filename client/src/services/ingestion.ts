import * as api from '@/lib/api'
import { useAppStore } from '@/store/useAppStore'
import { supabase } from '@/lib/supabase'
import type { Concept, Question } from '@/types'
import type { UploadedFile } from '@/components/ingestion/FileUploader'

/**
 * Parse the leading lecture id from a notes filename.
 *
 * Conventions seen across modules:
 *   "1. Topic.md"           -> "1"
 *   "7.1 Topic.md"          -> "7.1"
 *   "13. EMV Lecture.md"    -> "13"
 *   "1+2. Intro.md"         -> "1+2"
 *   "Topic.md"              -> null
 */
function parseLectureId(filename: string): string | null {
  const stem = filename.replace(/\.(md|txt)$/i, '')
  const m = stem.match(/^([\d.+]+)[.\s]+/)
  if (!m) return null
  return m[1].replace(/\.$/, '')
}

/**
 * Build a `lecture id → canonical week` map by querying the `sources` table
 * for the given module slug. `sources` is populated from the CSV manifest and
 * is the authoritative truth for "which lecture is in which week" — far more
 * reliable than parsing it out of notes filenames, which use mixed conventions
 * across modules (NC names by week, SRWS names by lecture id, etc).
 */
async function buildLectureToWeekMap(moduleSlug: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('sources')
    .select('lecture, week, source_type')
    .eq('module', moduleSlug)
  if (error) {
    console.warn(`Failed to load sources for module ${moduleSlug}:`, error.message)
    return new Map()
  }
  const map = new Map<string, number>()
  // Insert slides first, then lectures, so lecture rows win on collision.
  const sorted = [...(data ?? [])].sort((a, b) => (a.source_type === 'lecture' ? 1 : -1))
  for (const row of sorted) {
    if (!row.lecture || row.week === null) continue
    const key = String(row.lecture).replace(/\.$/, '').trim()
    if (key) map.set(key, row.week)
  }
  return map
}

export interface IngestionCallbacks {
  onStageChange: (stage: string) => void
  onProgress: (current: number, total: number, detail?: string) => void
}

export type ReviewConcept = {
  name: string
  module_ids: string[]
  description: string
  key_facts: string[]
  difficulty: number
  source_excerpt: string
  week: number | null
  lecture: string | null
}

/**
 * Phase 1: Extract concepts from files and optionally deduplicate.
 * Returns the concepts for the user to review before question generation.
 */
export async function extractConcepts(
  files: UploadedFile[],
  callbacks: IngestionCallbacks
): Promise<ReviewConcept[]> {
  const store = useAppStore.getState()
  const exams = store.exams

  // Step 1: Extract concepts per file
  callbacks.onStageChange('Extracting concepts...')

  type ExtractedConcept = { name: string; description: string; key_facts: string[]; difficulty: number; source_excerpt: string; week: number | null; lecture: string | null }
  const moduleConceptMap = new Map<string, { module_id: string; module_name: string; concepts: ExtractedConcept[] }>()

  // Per-module lecture→week lookup, lazily built once per module on first use.
  // The map's key is a normalised lecture id (e.g. "13.1") and the value is
  // the canonical week from `sources`.
  const moduleLectureMaps = new Map<string, Map<string, number>>()
  async function getLectureMap(slug: string | undefined): Promise<Map<string, number>> {
    if (!slug) return new Map()
    let m = moduleLectureMaps.get(slug)
    if (!m) {
      m = await buildLectureToWeekMap(slug)
      moduleLectureMaps.set(slug, m)
    }
    return m
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const exam = exams.find((e) => e.id === file.moduleId)
    const moduleName = exam?.name || 'Unknown'
    callbacks.onProgress(i, files.length, `Extracting from ${file.filename}`)

    // Look up the canonical (week, lecture id) for this file by joining the
    // parsed lecture id from its filename against the `sources` table for
    // this module. This replaces the old leading-number-as-week heuristic,
    // which was wrong for any module that names notes by lecture id (SRWS).
    const lectureId = parseLectureId(file.filename)
    const lectureMap = await getLectureMap(exam?.slug)
    const week = lectureId ? (lectureMap.get(lectureId) ?? null) : null
    // Store the lecture id (e.g. "13.1") rather than the topic title — that's
    // the join key with `sources` and lets us build a stable filter UI.
    const lecture = lectureId

    const result = await api.extractConcepts({
      notes: file.content,
      module_name: moduleName,
      module_id: file.moduleId,
    })

    const existing = moduleConceptMap.get(file.moduleId)
    const mapped = result.concepts.map((c) => ({
      name: c.name,
      description: c.description,
      key_facts: c.key_facts,
      difficulty: c.difficulty,
      source_excerpt: c.source_excerpt,
      week,
      lecture,
    }))

    if (existing) {
      existing.concepts.push(...mapped)
    } else {
      moduleConceptMap.set(file.moduleId, {
        module_id: file.moduleId,
        module_name: moduleName,
        concepts: mapped,
      })
    }
  }
  callbacks.onProgress(files.length, files.length)

  const allModuleConcepts = Array.from(moduleConceptMap.values())

  // Step 2: Deduplicate across modules (only if multiple modules)
  if (allModuleConcepts.length > 1) {
    callbacks.onStageChange('Deduplicating across modules...')
    callbacks.onProgress(0, 1)
    try {
      const dedupResult = await api.deduplicateConcepts({ modules: allModuleConcepts })
      callbacks.onProgress(1, 1)
      // Dedup response strips week/lecture — re-attach by name lookup
      const lookup = new Map<string, { week: number | null; lecture: string | null }>()
      for (const m of allModuleConcepts) {
        for (const c of m.concepts) {
          lookup.set(c.name, { week: c.week, lecture: c.lecture })
        }
      }
      return dedupResult.unique_concepts.map((c) => ({
        ...c,
        week: lookup.get(c.name)?.week ?? null,
        lecture: lookup.get(c.name)?.lecture ?? null,
      }))
    } catch (err) {
      console.warn('Dedup failed, using all concepts as-is:', err)
    }
  }

  // No dedup needed or dedup failed — just tag each with its module
  return allModuleConcepts.flatMap((m) =>
    m.concepts.map((c) => ({ ...c, module_ids: [m.module_id] }))
  )
}

/**
 * Phase 2: Save confirmed concepts and generate questions.
 * Called after the user reviews and approves concepts.
 */
export async function generateAllQuestions(
  concepts: ReviewConcept[],
  callbacks: IngestionCallbacks
): Promise<void> {
  const store = useAppStore.getState()

  // Save concepts to server
  callbacks.onStageChange('Saving concepts...')
  callbacks.onProgress(0, 1)
  const savedConcepts = await api.saveConcepts(concepts)
  store.addConcepts(savedConcepts)
  callbacks.onProgress(1, 1)

  // Generate questions — one API call per concept for accurate progress
  callbacks.onStageChange('Generating questions...')
  const total = savedConcepts.length
  let completed = 0
  const concurrency = 1 // Sequential to respect rate limits

  async function processOne(concept: Concept) {
    const exam = store.exams.find((e) => concept.module_ids.includes(e.id))
    const moduleSlug = exam?.slug

    const result = await api.generateQuestions({
      concepts: [{
        name: concept.name,
        description: concept.description,
        key_facts: concept.key_facts,
        difficulty: concept.difficulty,
      }],
      module_name: exam?.name || 'General',
      module: moduleSlug,
    })

    const questionRows: Partial<Question>[] = []
    for (const cq of result.questions) {
      for (const q of cq.questions) {
        questionRows.push({
          concept_id: concept.id,
          type: q.type,
          difficulty: q.difficulty,
          question: q.question,
          options: q.options || null,
          correct_answer: q.correct_answer,
          explanation: q.explanation,
          source: 'batch',
          times_used: 0,
          is_past_paper: false,
          source_chunk_ids: q.source_chunk_ids ?? [],
          evidence_quote: q.evidence_quote ?? null,
        })
      }
    }

    if (questionRows.length > 0) {
      const saved = await api.saveQuestions(questionRows)
      store.addQuestions(saved)
    }

    completed++
    callbacks.onProgress(completed, total, `${concept.name} — ${questionRows.length} questions`)
  }

  // Run with concurrency limit
  const queue = [...savedConcepts]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const concept = queue.shift()!
      try {
        await processOne(concept)
      } catch (err) {
        console.error(`Question gen failed for "${concept.name}":`, err)
        completed++
        callbacks.onProgress(completed, total, `${concept.name} — failed`)
      }
    }
  })
  await Promise.all(workers)

  store.setIngestionStatus('done')
  callbacks.onStageChange('Done!')
}

/**
 * Retry question generation for concepts that have no questions.
 *
 * If `moduleId` is provided, only concepts that belong to that module are
 * considered — used by the per-module Retry buttons on the admin status page.
 *
 * Logs every step to the console with [retry] prefix so you can verify exactly
 * what's happening — which concepts were found, which module they map to,
 * how long the server call took, how many questions came back, how many were
 * successfully persisted, and which concepts (if any) failed.
 */
export async function retryFailedQuestions(
  callbacks: IngestionCallbacks,
  moduleId?: string,
): Promise<number> {
  const store = useAppStore.getState()
  console.log(`[retry] fetching concepts with zero questions${moduleId ? ` for module ${moduleId}` : ''}…`)
  const fetchStart = performance.now()
  const all = await api.fetchConceptsMissingQuestions()
  const missing = moduleId ? all.filter((c) => c.module_ids.includes(moduleId)) : all
  console.log(`[retry] fetched ${missing.length} concept(s) in ${Math.round(performance.now() - fetchStart)}ms`)

  if (missing.length === 0) {
    callbacks.onStageChange('All concepts have questions!')
    console.log('[retry] nothing to do')
    return 0
  }

  console.group('[retry] concepts to process')
  for (const c of missing) {
    const exam = store.exams.find((e) => c.module_ids.includes(e.id))
    console.log(`  • ${c.name}  →  ${exam?.name ?? '?'} (${exam?.slug ?? 'no-slug'})`)
  }
  console.groupEnd()

  callbacks.onStageChange('Generating questions for failed concepts...')
  const total = missing.length
  let completed = 0
  let totalKept = 0
  const overallStart = performance.now()

  for (const concept of missing) {
    callbacks.onProgress(completed, total, concept.name)
    const exam = store.exams.find((e) => concept.module_ids.includes(e.id))
    const moduleSlug = exam?.slug
    const conceptStart = performance.now()
    console.log(`[retry] (${completed + 1}/${total}) "${concept.name}" — module=${moduleSlug ?? 'none'} — calling /generate-questions…`)

    try {
      const apiStart = performance.now()
      const result = await api.generateQuestions({
        concepts: [{
          name: concept.name,
          description: concept.description,
          key_facts: concept.key_facts,
          difficulty: concept.difficulty,
        }],
        module_name: exam?.name || 'General',
        module: moduleSlug,
      })
      const apiMs = Math.round(performance.now() - apiStart)
      const returnedCount = result.questions.reduce((s, cq) => s + cq.questions.length, 0)
      console.log(`[retry]   ↳ server returned ${returnedCount} question(s) in ${apiMs}ms`)

      const questionRows: Partial<Question>[] = []
      for (const cq of result.questions) {
        for (const q of cq.questions) {
          questionRows.push({
            concept_id: concept.id,
            type: q.type,
            difficulty: q.difficulty,
            question: q.question,
            options: q.options || null,
            correct_answer: q.correct_answer,
            explanation: q.explanation,
            source: 'batch',
            times_used: 0,
            is_past_paper: false,
            source_chunk_ids: q.source_chunk_ids ?? [],
            evidence_quote: q.evidence_quote ?? null,
          })
        }
      }

      if (questionRows.length > 0) {
        const saveStart = performance.now()
        const saved = await api.saveQuestions(questionRows)
        store.addQuestions(saved)
        totalKept += saved.length
        console.log(`[retry]   ↳ persisted ${saved.length} question(s) in ${Math.round(performance.now() - saveStart)}ms`)
      } else {
        console.warn(`[retry]   ↳ 0 questions to persist — server dropped them all (likely missing/invalid evidence quotes)`)
      }
    } catch (err) {
      console.error(`[retry]   ↳ FAILED for "${concept.name}":`, err)
    }

    console.log(`[retry]   ↳ concept done in ${Math.round(performance.now() - conceptStart)}ms`)
    completed++
    callbacks.onProgress(completed, total, concept.name)
  }

  const totalMs = Math.round(performance.now() - overallStart)
  console.log(`[retry] all done — ${totalKept} question(s) added across ${total} concept(s) in ${totalMs}ms (avg ${Math.round(totalMs / total)}ms/concept)`)
  callbacks.onStageChange('Done!')
  return missing.length
}

/**
 * Top up question generation for concepts whose existing question count is
 * below `threshold` (default 3). Same flow as retryFailedQuestions but
 * targets sparse concepts rather than empty ones — appends to whatever's
 * already there. Use sparingly: this can introduce near-duplicates if the
 * generator hits the same angles as existing questions.
 */
export async function topUpSparseQuestions(
  callbacks: IngestionCallbacks,
  moduleId?: string,
  threshold = 3,
): Promise<number> {
  const store = useAppStore.getState()
  console.log(`[topup] fetching concepts with <${threshold} questions${moduleId ? ` for module ${moduleId}` : ''}…`)
  const all = await api.fetchConceptsBelowQuestionThreshold(threshold)
  // Drop concepts with zero questions — those are retry-failed's job. Top up
  // is specifically for the sparse-but-non-empty case.
  const sparse = all.filter((c) => moduleId ? c.module_ids.includes(moduleId) : true)

  if (sparse.length === 0) {
    callbacks.onStageChange('No sparse concepts to top up!')
    return 0
  }

  callbacks.onStageChange(`Topping up ${sparse.length} sparse concept(s)…`)
  let completed = 0
  let totalKept = 0
  const overallStart = performance.now()

  for (const concept of sparse) {
    callbacks.onProgress(completed, sparse.length, concept.name)
    const exam = store.exams.find((e) => concept.module_ids.includes(e.id))
    const moduleSlug = exam?.slug

    // Fetch the existing question stems for this concept and pass them to
    // the generator so it explicitly avoids repeating angles. This is the
    // generation-time half of the dedup story (the cleanup script is the
    // post-hoc half).
    const existingStems = useAppStore.getState().questions
      .filter((q) => q.concept_id === concept.id)
      .map((q) => q.question)

    console.log(`[topup] (${completed + 1}/${sparse.length}) "${concept.name}" — module=${moduleSlug ?? 'none'} · ${existingStems.length} existing`)

    try {
      const result = await api.generateQuestions({
        concepts: [{
          name: concept.name,
          description: concept.description,
          key_facts: concept.key_facts,
          difficulty: concept.difficulty,
          existing_questions: existingStems,
        }],
        module_name: exam?.name || 'General',
        module: moduleSlug,
      })

      const questionRows: Partial<Question>[] = []
      for (const cq of result.questions) {
        for (const q of cq.questions) {
          questionRows.push({
            concept_id: concept.id,
            type: q.type,
            difficulty: q.difficulty,
            question: q.question,
            options: q.options || null,
            correct_answer: q.correct_answer,
            explanation: q.explanation,
            source: 'batch',
            times_used: 0,
            is_past_paper: false,
            source_chunk_ids: q.source_chunk_ids ?? [],
            evidence_quote: q.evidence_quote ?? null,
          })
        }
      }

      if (questionRows.length > 0) {
        const saved = await api.saveQuestions(questionRows)
        store.addQuestions(saved)
        totalKept += saved.length
        console.log(`[topup]   ↳ added ${saved.length} question(s)`)
      } else {
        console.warn(`[topup]   ↳ generator dropped everything`)
      }
    } catch (err) {
      console.error(`[topup]   ↳ FAILED for "${concept.name}":`, err)
    }

    completed++
    callbacks.onProgress(completed, sparse.length, concept.name)
  }

  console.log(`[topup] done — added ${totalKept} question(s) across ${sparse.length} concept(s) in ${Math.round(performance.now() - overallStart)}ms`)
  callbacks.onStageChange('Done!')
  return sparse.length
}
