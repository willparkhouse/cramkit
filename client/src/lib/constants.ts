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
}

export const MODULE_SHORT_NAMES: Record<string, string> = {
  'Natural Language Processing': 'NLP',
  'Neural Computation': 'NC',
  'Evolutionary Computation': 'EC',
  'Security of Real World Systems': 'SRWS',
}

