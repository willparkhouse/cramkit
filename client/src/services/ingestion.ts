import * as api from '@/lib/api'
import { useAppStore } from '@/store/useAppStore'
import type { Concept, Question } from '@/types'
import type { UploadedFile } from '@/components/ingestion/FileUploader'

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

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const exam = exams.find((e) => e.id === file.moduleId)
    const moduleName = exam?.name || 'Unknown'
    callbacks.onProgress(i, files.length, `Extracting from ${file.filename}`)

    // Auto-detect week number and lecture title from filename
    // Matches patterns like "1. Topic.md", "7.1 Topic.md", "11. Topic.md"
    const weekMatch = file.filename.match(/^(\d+)[\.\s]/)
    const week = weekMatch ? parseInt(weekMatch[1]) : null
    const lecture = file.filename.replace(/^\d+[\.\d]*[\.\s]+/, '').replace(/\.md$/i, '') || null

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

    const result = await api.generateQuestions({
      concepts: [{
        name: concept.name,
        description: concept.description,
        key_facts: concept.key_facts,
        difficulty: concept.difficulty,
      }],
      module_name: exam?.name || 'General',
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
 */
export async function retryFailedQuestions(
  callbacks: IngestionCallbacks
): Promise<number> {
  const store = useAppStore.getState()
  const missing = await api.fetchConceptsMissingQuestions()

  if (missing.length === 0) {
    callbacks.onStageChange('All concepts have questions!')
    return 0
  }

  callbacks.onStageChange('Generating questions for failed concepts...')
  const total = missing.length
  let completed = 0

  for (const concept of missing) {
    callbacks.onProgress(completed, total, concept.name)
    const exam = store.exams.find((e) => concept.module_ids.includes(e.id))

    try {
      const result = await api.generateQuestions({
        concepts: [{
          name: concept.name,
          description: concept.description,
          key_facts: concept.key_facts,
          difficulty: concept.difficulty,
        }],
        module_name: exam?.name || 'General',
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
          })
        }
      }

      if (questionRows.length > 0) {
        const saved = await api.saveQuestions(questionRows)
        store.addQuestions(saved)
      }
    } catch (err) {
      console.error(`Retry failed for "${concept.name}":`, err)
    }

    completed++
    callbacks.onProgress(completed, total, concept.name)
  }

  callbacks.onStageChange('Done!')
  return missing.length
}
