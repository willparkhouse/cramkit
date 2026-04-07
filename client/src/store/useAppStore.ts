import { create } from 'zustand'
import type { Exam, Concept, Question, KnowledgeEntry, RevisionSlot, IngestionStatus } from '@/types'
import { CORRECT_RATE, PARTIAL_RATE, INCORRECT_DECAY } from '@/lib/constants'

interface AppState {
  // Data
  exams: Exam[]
  concepts: Concept[]
  questions: Question[]
  knowledge: Record<string, KnowledgeEntry>
  revisionSlots: RevisionSlot[]

  // UI state
  hydrated: boolean
  ingestionStatus: IngestionStatus

  // Actions
  setHydrated: (hydrated: boolean) => void
  setExams: (exams: Exam[]) => void
  setConcepts: (concepts: Concept[]) => void
  addConcepts: (concepts: Concept[]) => void
  setQuestions: (questions: Question[]) => void
  addQuestions: (questions: Question[]) => void
  setKnowledge: (knowledge: Record<string, KnowledgeEntry>) => void
  setRevisionSlots: (slots: RevisionSlot[]) => void
  setIngestionStatus: (status: IngestionStatus) => void

  // Quiz actions
  updateKnowledge: (conceptId: string, questionId: string, result: 'correct' | 'partial' | 'incorrect') => void
  markQuestionUsed: (questionId: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  exams: [],
  concepts: [],
  questions: [],
  knowledge: {},
  revisionSlots: [],
  hydrated: false,
  ingestionStatus: 'idle',

  setHydrated: (hydrated) => set({ hydrated }),
  setExams: (exams) => set({ exams }),
  setConcepts: (concepts) => set({ concepts }),
  addConcepts: (newConcepts) => set((state) => ({
    concepts: [...state.concepts, ...newConcepts],
  })),
  setQuestions: (questions) => set({ questions }),
  addQuestions: (newQuestions) => set((state) => ({
    questions: [...state.questions, ...newQuestions],
  })),
  setKnowledge: (knowledge) => set({ knowledge }),
  setRevisionSlots: (slots) => set({ revisionSlots: slots }),
  setIngestionStatus: (status) => set({ ingestionStatus: status }),

  updateKnowledge: (conceptId, questionId, result) => {
    const state = get()
    const existing = state.knowledge[conceptId] || {
      concept_id: conceptId,
      score: 0,
      last_tested: null,
      history: [],
      updated_at: new Date().toISOString(),
    }

    const scoreBefore = existing.score
    let scoreAfter: number

    switch (result) {
      case 'correct':
        scoreAfter = scoreBefore + (1 - scoreBefore) * CORRECT_RATE
        break
      case 'partial':
        scoreAfter = scoreBefore + (0.5 - scoreBefore) * PARTIAL_RATE
        break
      case 'incorrect':
        scoreAfter = scoreBefore * INCORRECT_DECAY
        break
    }

    const now = new Date().toISOString()
    const updated: KnowledgeEntry = {
      ...existing,
      score: scoreAfter,
      last_tested: now,
      updated_at: now,
      history: [
        ...existing.history,
        {
          timestamp: now,
          question_id: questionId,
          correct: result === 'correct',
          score_before: scoreBefore,
          score_after: scoreAfter,
        },
      ],
    }

    set({
      knowledge: { ...state.knowledge, [conceptId]: updated },
    })
  },

  markQuestionUsed: (questionId) => {
    set((state) => ({
      questions: state.questions.map((q) =>
        q.id === questionId ? { ...q, times_used: q.times_used + 1 } : q
      ),
    }))
  },
}))
