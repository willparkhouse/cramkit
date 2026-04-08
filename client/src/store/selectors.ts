import { useAppStore } from './useAppStore'
import { DECAY_LAMBDA, MIN_MODULE_ALLOCATION } from '@/lib/constants'
import { daysSince, daysUntil } from '@/lib/utils'
import type { Concept, Exam } from '@/types'

export function useEffectiveScore(conceptId: string): number {
  const knowledge = useAppStore((s) => s.knowledge[conceptId])
  if (!knowledge) return 0
  const days = daysSince(knowledge.last_tested)
  if (days === Infinity) return 0
  return knowledge.score * Math.exp(-DECAY_LAMBDA * days)
}

export function getEffectiveScore(
  score: number,
  lastTested: string | null
): number {
  const days = daysSince(lastTested)
  if (days === Infinity) return 0
  return score * Math.exp(-DECAY_LAMBDA * days)
}

export function useModuleConfidence(examId: string): number {
  const concepts = useAppStore((s) => s.concepts)
  const knowledge = useAppStore((s) => s.knowledge)

  const moduleConcepts = concepts.filter((c) => c.module_ids.includes(examId))
  if (moduleConcepts.length === 0) return 0

  const total = moduleConcepts.reduce((sum, c) => {
    const k = knowledge[c.id]
    if (!k) return sum
    return sum + getEffectiveScore(k.score, k.last_tested)
  }, 0)

  return total / moduleConcepts.length
}

export function useModulePriorities(): Map<string, number> {
  const allExams = useAppStore((s) => s.exams)
  const enrolledModuleIds = useAppStore((s) => s.enrolledModuleIds)
  const concepts = useAppStore((s) => s.concepts)
  const knowledge = useAppStore((s) => s.knowledge)

  const exams = allExams.filter((e) => enrolledModuleIds.includes(e.id))

  const priorities = new Map<string, number>()
  let totalPriority = 0

  for (const exam of exams) {
    const moduleConcepts = concepts.filter((c) =>
      c.module_ids.includes(exam.id)
    )
    const avgConfidence =
      moduleConcepts.length === 0
        ? 0
        : moduleConcepts.reduce((sum, c) => {
            const k = knowledge[c.id]
            if (!k) return sum
            return sum + getEffectiveScore(k.score, k.last_tested)
          }, 0) / moduleConcepts.length

    const days = Math.max(daysUntil(exam.date), 0.5)
    const priority = (exam.weight * (1 - avgConfidence)) / days
    priorities.set(exam.id, priority)
    totalPriority += priority
  }

  // Normalise to percentages, apply minimum floor
  if (totalPriority > 0) {
    for (const [id, priority] of priorities) {
      const normalised = Math.max(
        priority / totalPriority,
        MIN_MODULE_ALLOCATION
      )
      priorities.set(id, normalised)
    }
    // Re-normalise after floor
    const sum = Array.from(priorities.values()).reduce((a, b) => a + b, 0)
    for (const [id, val] of priorities) {
      priorities.set(id, val / sum)
    }
  }

  return priorities
}

export function selectNextConcept(
  concepts: Concept[],
  knowledge: Record<string, { score: number; last_tested: string | null }>,
  exams: Exam[],
  /** Recently-shown concept ids (most-recent-first). Concepts in this list
   *  get a heavy down-weight so the user isn't shown the same topic twice in
   *  a row. Empty array = no penalty. */
  recentConceptIds: string[] = [],
): Concept | null {
  if (concepts.length === 0) return null

  // Compute per-module priority
  const modulePriorities = new Map<string, number>()
  for (const exam of exams) {
    const moduleConcepts = concepts.filter((c) => c.module_ids.includes(exam.id))
    const avgConf =
      moduleConcepts.length === 0
        ? 0
        : moduleConcepts.reduce((sum, c) => {
            const k = knowledge[c.id]
            return sum + (k ? getEffectiveScore(k.score, k.last_tested) : 0)
          }, 0) / moduleConcepts.length
    const days = Math.max(daysUntil(exam.date), 0.5)
    modulePriorities.set(exam.id, (exam.weight * (1 - avgConf)) / days)
  }

  // Anti-recency penalty. Concepts seen in the last 8 picks get aggressively
  // down-weighted so we don't dwell on the same topic. The penalty decays
  // with position so the most-recent concept is hit hardest.
  const recentPenalty = new Map<string, number>()
  for (let i = 0; i < recentConceptIds.length && i < 8; i++) {
    // 0 → 1.0 (max penalty), 7 → ~0.125
    const factor = (i + 1) / 8
    recentPenalty.set(recentConceptIds[i], 0.05 + factor * 0.5)
  }

  // Weight each concept
  const weighted = concepts.map((c) => {
    const k = knowledge[c.id]
    const effectiveScore = k ? getEffectiveScore(k.score, k.last_tested) : 0
    const maxModulePriority = Math.max(
      ...c.module_ids.map((id) => modulePriorities.get(id) || 0)
    )
    const baseWeight = maxModulePriority * (1 - effectiveScore)
    const penalty = recentPenalty.get(c.id) ?? 1
    return { concept: c, weight: baseWeight * penalty }
  })

  // Weighted random across the top 15 (was top 5 — too narrow on a 400-concept
  // bank, the algorithm had nowhere to escape to once it locked onto a few).
  weighted.sort((a, b) => b.weight - a.weight)
  const top = weighted.slice(0, 15)
  const totalWeight = top.reduce((sum, w) => sum + w.weight, 0)
  if (totalWeight === 0) return top[0]?.concept || null

  let random = Math.random() * totalWeight
  for (const w of top) {
    random -= w.weight
    if (random <= 0) return w.concept
  }
  return top[0].concept
}
