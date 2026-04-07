import { useAppStore } from '@/store/useAppStore'
import { selectNextConcept, getEffectiveScore } from '@/store/selectors'
import { DECAY_LAMBDA } from '@/lib/constants'
import { daysSince } from '@/lib/utils'
import type { Question, Concept } from '@/types'

export type QuizMode = 'weakest' | 'untested' | 'mistakes' | 'spaced'
export type DifficultyFilter = 'all' | 'easy' | 'medium' | 'hard'

export interface QuizFilters {
  moduleId: string | null
  questionType: 'all' | 'mcq' | 'free_form'
  week: number | null
  mode: QuizMode
  difficulty: DifficultyFilter
}

export function pickNextQuestion(filters: QuizFilters): { concept: Concept; question: Question } | null {
  const state = useAppStore.getState()
  let { concepts, questions } = state
  const { knowledge, enrolledModuleIds } = state

  // Restrict the exam pool to enrolled modules so the priority algorithm
  // doesn't allocate weight to modules the user isn't taking.
  const exams = state.exams.filter((e) => enrolledModuleIds.includes(e.id))

  if (concepts.length === 0 || questions.length === 0) return null

  // Filter by module
  if (filters.moduleId) {
    concepts = concepts.filter((c) => c.module_ids.includes(filters.moduleId!))
  }

  // Filter by week
  if (filters.week !== null && filters.week !== undefined) {
    concepts = concepts.filter((c) => c.week === filters.week)
  }

  // Filter questions by type
  if (filters.questionType !== 'all') {
    questions = questions.filter((q) => q.type === filters.questionType)
  }

  // Filter questions by difficulty band
  // Easy = 1-2, Medium = 3, Hard = 4-5
  if (filters.difficulty !== 'all') {
    questions = questions.filter((q) => {
      if (filters.difficulty === 'easy') return q.difficulty <= 2
      if (filters.difficulty === 'medium') return q.difficulty === 3
      if (filters.difficulty === 'hard') return q.difficulty >= 4
      return true
    })
  }

  if (questions.length === 0) return null

  // Only concepts that have matching questions
  const conceptIdsWithQuestions = new Set(questions.map((q) => q.concept_id))
  concepts = concepts.filter((c) => conceptIdsWithQuestions.has(c.id))

  if (concepts.length === 0) return null

  // Apply mode-specific concept filtering
  switch (filters.mode) {
    case 'untested':
      concepts = concepts.filter((c) => !knowledge[c.id] || knowledge[c.id].history.length === 0)
      break

    case 'mistakes':
      concepts = concepts.filter((c) => {
        const k = knowledge[c.id]
        if (!k || k.history.length === 0) return false
        // Has at least one wrong answer, or score is below 0.5
        const hasWrong = k.history.some((h) => !h.correct)
        return hasWrong || k.score < 0.5
      })
      break

    case 'spaced': {
      // Concepts that have been tested but are "due" — their effective score
      // has decayed significantly from their raw score (meaning time has passed)
      concepts = concepts.filter((c) => {
        const k = knowledge[c.id]
        if (!k || k.history.length === 0) return false
        const effective = getEffectiveScore(k.score, k.last_tested)
        const decay = k.score - effective
        // Due if decayed by at least 15% from raw score, or last tested > 2 days ago
        return decay > 0.15 || daysSince(k.last_tested) > 2
      })
      break
    }

    case 'weakest':
    default:
      // No extra filtering — selectNextConcept already prioritises weak concepts
      break
  }

  if (concepts.length === 0) return null

  // For spaced repetition, sort by how overdue they are instead of using priority algorithm
  if (filters.mode === 'spaced') {
    concepts.sort((a, b) => {
      const ka = knowledge[a.id]
      const kb = knowledge[b.id]
      const decayA = ka ? ka.score - getEffectiveScore(ka.score, ka.last_tested) : 0
      const decayB = kb ? kb.score - getEffectiveScore(kb.score, kb.last_tested) : 0
      return decayB - decayA // Most decayed first
    })
    // Pick from top 3 randomly
    const top = concepts.slice(0, 3)
    const concept = top[Math.floor(Math.random() * top.length)]
    const question = selectQuestion(concept.id, questions)
    return question ? { concept, question } : null
  }

  // Default: use priority-weighted selection with retries
  for (let attempt = 0; attempt < 5; attempt++) {
    const concept = selectNextConcept(concepts, knowledge, exams)
    if (!concept) return null

    const question = selectQuestion(concept.id, questions)
    if (question) return { concept, question }

    concepts = concepts.filter((c) => c.id !== concept.id)
    if (concepts.length === 0) return null
  }

  return null
}

function selectQuestion(conceptId: string, questions: Question[]): Question | null {
  const conceptQuestions = questions.filter((q) => q.concept_id === conceptId)
  if (conceptQuestions.length === 0) return null

  const unused = conceptQuestions.filter((q) => q.times_used === 0)
  if (unused.length > 0) {
    return unused[Math.floor(Math.random() * unused.length)]
  }

  const minUsed = Math.min(...conceptQuestions.map((q) => q.times_used))
  const leastUsed = conceptQuestions.filter((q) => q.times_used === minUsed)
  return leastUsed[Math.floor(Math.random() * leastUsed.length)]
}
