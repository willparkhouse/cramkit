import * as api from '@/lib/api'
import { useAppStore } from './useAppStore'
import type { KnowledgeEntry } from '@/types'

export async function hydrateStore(): Promise<void> {
  const store = useAppStore.getState()

  try {
    // First fetch exams + enrollments + slots + knowledge in parallel
    const [exams, enrollments, knowledgeRows, slots] = await Promise.all([
      api.fetchExams(),
      api.fetchEnrollments(),
      api.fetchKnowledge(),
      api.fetchSlots(),
    ])

    const enrolledModuleIds = enrollments.map((e) => e.module_id)
    store.setExams(exams)
    store.setEnrolledModuleIds(enrolledModuleIds)
    store.setRevisionSlots(slots)

    const knowledgeMap: Record<string, KnowledgeEntry> = {}
    for (const row of knowledgeRows) {
      knowledgeMap[row.concept_id] = row
    }
    store.setKnowledge(knowledgeMap)

    // Then fetch concepts (filtered by enrolled modules) and their questions
    const concepts = await api.fetchConcepts(enrolledModuleIds)
    store.setConcepts(concepts)

    const questions = await api.fetchQuestions(concepts.map((c) => c.id))
    store.setQuestions(questions)

    store.setHydrated(true)
  } catch (err) {
    console.error('Failed to hydrate store:', err)
    store.setHydrated(true)
  }
}

/**
 * Re-fetch concepts/questions after enrollment changes.
 * Called from the modules page after enroll/unenroll.
 */
export async function refreshEnrollments(): Promise<void> {
  const store = useAppStore.getState()
  try {
    const enrollments = await api.fetchEnrollments()
    const enrolledModuleIds = enrollments.map((e) => e.module_id)
    store.setEnrolledModuleIds(enrolledModuleIds)

    const concepts = await api.fetchConcepts(enrolledModuleIds)
    store.setConcepts(concepts)

    const questions = await api.fetchQuestions(concepts.map((c) => c.id))
    store.setQuestions(questions)
  } catch (err) {
    console.error('Failed to refresh enrollments:', err)
  }
}

export async function syncKnowledgeToServer(
  knowledge: Record<string, KnowledgeEntry>
): Promise<void> {
  const entries = Object.values(knowledge)
  if (entries.length === 0) return

  try {
    await api.syncKnowledge(entries)
  } catch (err) {
    console.error('Failed to sync knowledge:', err)
  }
}
