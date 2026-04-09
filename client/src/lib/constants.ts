// Spaced repetition decay rate
export const DECAY_LAMBDA = 0.05

// Confidence update rates
export const CORRECT_RATE = 0.3
export const PARTIAL_RATE = 0.15
export const INCORRECT_DECAY = 0.7

// Minimum floor per module (10% of total time)
export const MIN_MODULE_ALLOCATION = 0.1

// Module colours for UI
export const MODULE_COLOURS: Record<string, string> = {
  'Natural Language Processing': 'hsl(262 83% 58%)',
  'Neural Computation': 'hsl(200 80% 50%)',
  'Evolutionary Computation': 'hsl(150 60% 45%)',
  'Security of Real World Systems': 'hsl(25 90% 55%)',
  'Security and Networks': 'hsl(345 75% 55%)',
  'Computer Vision and Imaging': 'hsl(180 65% 45%)',
  'Advanced Networking': 'hsl(50 85% 55%)',
}

/**
 * Legacy short-name fallback. Module short_names now live on the exams row
 * (`exams.short_name`) and are set via the admin module form. This map is kept
 * as a fallback for the rare case where an exam row hasn't been backfilled,
 * and for callsites where only the module name is available (no full Exam row).
 *
 * Prefer `getModuleShortName(exam)` over reading this map directly.
 */
export const MODULE_SHORT_NAMES: Record<string, string> = {
  'Natural Language Processing': 'NLP',
  'Neural Computation': 'NC',
  'Evolutionary Computation': 'EC',
  'Security of Real World Systems': 'SRWS',
  'Security and Networks': 'SandN',
  'Computer Vision and Imaging': 'CVI',
  'Advanced Networking': 'AdvNet',
}

/**
 * Resolve a module's short name from an exam row, preferring the DB-backed
 * value, falling back to the legacy hardcoded map, then to the full name.
 * Always returns a non-empty string.
 */
export function getModuleShortName(exam: { name: string; short_name?: string | null } | null | undefined): string {
  if (!exam) return ''
  if (exam.short_name && exam.short_name.trim()) return exam.short_name.trim()
  return MODULE_SHORT_NAMES[exam.name] ?? exam.name
}

