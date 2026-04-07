import * as api from '@/lib/api'
import { useAppStore } from './useAppStore'
import type { KnowledgeEntry } from '@/types'

export async function hydrateStore(): Promise<void> {
  const store = useAppStore.getState()

  try {
    const [exams, concepts, questions, knowledgeRows, slots] =
      await Promise.all([
        api.fetchExams(),
        api.fetchConcepts(),
        api.fetchQuestions(),
        api.fetchKnowledge(),
        api.fetchSlots(),
      ])

    store.setExams(exams)
    store.setConcepts(concepts)
    store.setQuestions(questions)
    store.setRevisionSlots(slots)

    const knowledgeMap: Record<string, KnowledgeEntry> = {}
    for (const row of knowledgeRows) {
      knowledgeMap[row.concept_id] = row
    }
    store.setKnowledge(knowledgeMap)

    store.setHydrated(true)
  } catch (err) {
    console.error('Failed to hydrate store:', err)
    store.setHydrated(true)
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
