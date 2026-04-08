import { useAppStore } from '@/store/useAppStore'
import { selectNextConcept, getEffectiveScore } from '@/store/selectors'
import { DECAY_LAMBDA } from '@/lib/constants'
import { daysSince } from '@/lib/utils'
import type { Question, Concept } from '@/types'

// Two selection philosophies. Everything else (mistakes-only, untested-only,
// due-for-review) is now expressed as composable filter flags rather than
// mutually-exclusive modes — far less decision fatigue, and you can mix them.
export type QuizMode = 'chronological' | 'weakest'
export type DifficultyFilter = 'all' | 'easy' | 'medium' | 'hard'

export interface QuizFilters {
  moduleId: string | null
  questionType: 'all' | 'mcq' | 'free_form'
  week: number | null
  mode: QuizMode
  difficulty: DifficultyFilter
  /** When true, only show concepts where the user has answered at least one
   *  question wrong (or scored < 0.5 overall). Composes with mode. */
  onlyMistakes?: boolean
  /** When true, past-paper questions are excluded from selection. Default true. */
  excludePastPapers?: boolean
}

export function pickNextQuestion(
  filters: QuizFilters,
  /** Most-recent-first list of concept ids the user has just been shown.
   *  Used to suppress immediate repeats. Empty array = no anti-recency. */
  recentConceptIds: string[] = [],
): { concept: Concept; question: Question } | null {
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

  // Exclude past-paper questions unless the user has explicitly opted in.
  // Default behaviour protects users who want to keep past papers unseen for a
  // genuine mock attempt later.
  if (filters.excludePastPapers !== false) {
    questions = questions.filter((q) => !q.is_past_paper)
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

  // Compose filter flags. These run independently of the mode and apply
  // before the selection algorithm sees the candidate pool.
  if (filters.onlyMistakes) {
    concepts = concepts.filter((c) => {
      const k = knowledge[c.id]
      if (!k || k.history.length === 0) return false
      const hasWrong = k.history.some((h) => !h.correct)
      return hasWrong || k.score < 0.5
    })
  }

  if (concepts.length === 0) return null

  // Chronological mode: walk lectures in order, weight by a soft Gaussian
  // centred on the first under-confident lecture so the cursor drifts forward
  // organically as the student progresses. Best used with a module selected.
  if (filters.mode === 'chronological') {
    return pickChronological(concepts, questions, knowledge)
  }

  // Default: use priority-weighted selection with retries
  for (let attempt = 0; attempt < 5; attempt++) {
    const concept = selectNextConcept(concepts, knowledge, exams, recentConceptIds)
    if (!concept) return null

    const question = selectQuestion(concept.id, questions)
    if (question) return { concept, question }

    concepts = concepts.filter((c) => c.id !== concept.id)
    if (concepts.length === 0) return null
  }

  return null
}

// ----------------------------------------------------------------------------
// Chronological mode
// ----------------------------------------------------------------------------

/**
 * Bucket concepts by `(week, lecture)`, sort the buckets in chronological
 * order, then weight each bucket by:
 *
 *   weight(i) = exp(-((i - focus)² / σ²)) * (1 - readiness(i))
 *
 * where `focus` is the first bucket whose mean effective score is below
 * READINESS_GOAL. This produces a soft, drifting cursor — most questions come
 * from the focus lecture, with occasional teasers from the next lecture and
 * back-references to earlier ones. As the student gets more confident on the
 * focus lecture, its weight drops and the focus naturally shifts forward.
 */
function pickChronological(
  concepts: Concept[],
  questions: Question[],
  knowledge: Record<string, { score: number; last_tested: string | null; history: unknown[] }>,
): { concept: Concept; question: Question } | null {
  const READINESS_GOAL = 0.7
  const SIGMA = 1.5

  // Build buckets keyed by `${week}|${lecture}`. Concepts without a lecture
  // id are pooled into a final 'unscheduled' bucket so they don't disappear.
  type Bucket = { key: string; week: number; lecture: string; concepts: Concept[]; readiness: number }
  const bucketMap = new Map<string, Bucket>()
  for (const c of concepts) {
    const week = c.week ?? 9999
    const lecture = c.lecture ?? '__none'
    const key = `${week}|${lecture}`
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { key, week, lecture, concepts: [], readiness: 0 })
    }
    bucketMap.get(key)!.concepts.push(c)
  }

  // Compute readiness per bucket: mean effective score over its concepts.
  for (const b of bucketMap.values()) {
    const total = b.concepts.reduce((s, c) => {
      const k = knowledge[c.id]
      return s + (k ? getEffectiveScore(k.score, k.last_tested) : 0)
    }, 0)
    b.readiness = b.concepts.length > 0 ? total / b.concepts.length : 0
  }

  // Order buckets chronologically. Use a natural-numeric compare on the
  // lecture id so "1.2" sorts after "1" and before "2".
  const buckets = [...bucketMap.values()].sort((a, b) => {
    if (a.week !== b.week) return a.week - b.week
    return naturalCompare(a.lecture, b.lecture)
  })

  if (buckets.length === 0) return null

  // Find the focus bucket: first one whose readiness is below the goal.
  // If everything's "done", revert to a uniform weighted-random over the last
  // bucket (revision pass).
  let focusIndex = buckets.findIndex((b) => b.readiness < READINESS_GOAL)
  if (focusIndex === -1) focusIndex = buckets.length - 1

  // Build per-bucket weights. Multiply the bell curve by (1 - readiness) so
  // a lecture you've already grasped contributes less even if it's near the
  // focus.
  const weighted = buckets.map((b, i) => {
    const distance = i - focusIndex
    const bell = Math.exp(-(distance * distance) / (SIGMA * SIGMA))
    const weight = bell * (1 - Math.min(b.readiness, 0.95))
    return { bucket: b, weight }
  })

  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0)
  if (totalWeight === 0) {
    // Everything is at readiness ≥ 0.95. Just pick a random concept from any
    // bucket so the user doesn't see an empty state.
    const all = buckets.flatMap((b) => b.concepts)
    const concept = all[Math.floor(Math.random() * all.length)]
    const q = selectQuestion(concept.id, questions)
    return q ? { concept, question: q } : null
  }

  // Try a few times in case the chosen bucket has no questions.
  for (let attempt = 0; attempt < 5; attempt++) {
    let r = Math.random() * totalWeight
    let chosen = weighted[0].bucket
    for (const w of weighted) {
      r -= w.weight
      if (r <= 0) { chosen = w.bucket; break }
    }

    // Within the chosen bucket, pick the weakest concept (with some variation
    // — pick weighted-random from the 3 weakest).
    const sorted = [...chosen.concepts].sort((a, b) => {
      const ea = knowledge[a.id] ? getEffectiveScore(knowledge[a.id].score, knowledge[a.id].last_tested) : 0
      const eb = knowledge[b.id] ? getEffectiveScore(knowledge[b.id].score, knowledge[b.id].last_tested) : 0
      return ea - eb
    })
    const candidates = sorted.slice(0, Math.min(3, sorted.length))
    const concept = candidates[Math.floor(Math.random() * candidates.length)]
    const q = selectQuestion(concept.id, questions)
    if (q) return { concept, question: q }
  }
  return null
}

/** Natural-numeric compare so "13.1" < "13.2" < "14" and "1+2" sorts sanely. */
function naturalCompare(a: string, b: string): number {
  const ax = a.split(/(\d+)/).filter(Boolean)
  const bx = b.split(/(\d+)/).filter(Boolean)
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const aPart = ax[i] ?? ''
    const bPart = bx[i] ?? ''
    const aNum = parseInt(aPart)
    const bNum = parseInt(bPart)
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum
    } else {
      if (aPart !== bPart) return aPart < bPart ? -1 : 1
    }
  }
  return 0
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
