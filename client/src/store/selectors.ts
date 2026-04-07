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
  const exams = useAppStore((s) => s.exams)
  const concepts = useAppStore((s) => s.concepts)
  const knowledge = useAppStore((s) => s.knowledge)

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
  exams: Exam[]
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

  // Weight each concept
  const weighted = concepts.map((c) => {
    const k = knowledge[c.id]
    const effectiveScore = k ? getEffectiveScore(k.score, k.last_tested) : 0
    const maxModulePriority = Math.max(
      ...c.module_ids.map((id) => modulePriorities.get(id) || 0)
    )
    const weight = maxModulePriority * (1 - effectiveScore)
    return { concept: c, weight }
  })

  // Weighted random from top 5
  weighted.sort((a, b) => b.weight - a.weight)
  const top = weighted.slice(0, 5)
  const totalWeight = top.reduce((sum, w) => sum + w.weight, 0)
  if (totalWeight === 0) return top[0]?.concept || null

  let random = Math.random() * totalWeight
  for (const w of top) {
    random -= w.weight
    if (random <= 0) return w.concept
  }
  return top[0].concept
}
