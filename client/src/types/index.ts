export interface Exam {
  id: string
  name: string
  slug: string
  date: string // ISO timestamp
  weight: number
  semester: number
}

export interface Concept {
  id: string
  name: string
  description: string
  key_facts: string[]
  module_ids: string[] // references exam IDs
  difficulty: number // 1-5
  source_excerpt: string
  week: number | null
  lecture: string | null
  created_at: string
}

export interface Question {
  id: string
  concept_id: string
  type: 'mcq' | 'free_form'
  difficulty: number // 1-5
  question: string
  options: string[] | null // for MCQ
  correct_answer: string
  explanation: string
  source: 'batch' | 'runtime'
  times_used: number
  created_at: string
  is_past_paper?: boolean
  source_chunk_ids?: string[]
  evidence_quote?: string | null
}

export interface KnowledgeEntry {
  concept_id: string
  score: number // 0-1
  last_tested: string | null
  history: QuizAttempt[]
  updated_at: string
}

export interface QuizAttempt {
  timestamp: string
  question_id: string
  correct: boolean
  score_before: number
  score_after: number
}

export interface ModuleEnrollment {
  user_id: string
  module_id: string
  enrolled_at: string
}

export interface ModuleRequest {
  id: string
  name: string
  description: string | null
  requested_by: string | null
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}

export interface ModuleRequestVote {
  request_id: string
  user_id: string
  voted_at: string
}

export type SlotStatus = 'pending' | 'completed' | 'skipped'

export interface RevisionSlot {
  id: string
  start_time: string
  end_time: string
  allocated_module_id: string | null
  calendar_event_id: string | null
  status: SlotStatus
  created_at: string
}

// API request/response types
export interface ExtractConceptsRequest {
  notes: string
  module_name: string
  module_id: string
  exam_paper?: string
}

export interface ExtractConceptsResponse {
  concepts: Omit<Concept, 'id' | 'created_at' | 'module_ids'>[]
}

export interface GenerateQuestionsRequest {
  concepts: Pick<Concept, 'name' | 'description' | 'key_facts' | 'difficulty'>[]
  module_name: string
  /** Module slug for the source-chunk RAG retrieval (e.g. "neuralcomp"). */
  module?: string
}

export interface GeneratedQuestion {
  type: 'mcq' | 'free_form'
  difficulty: number
  question: string
  options: string[] | null
  correct_answer: string
  explanation: string
  evidence_quote: string
  source_chunk_ids: string[]
}

export interface GenerateQuestionsResponse {
  questions: {
    concept_name: string
    questions: GeneratedQuestion[]
  }[]
}

export interface EvaluateAnswerRequest {
  question: string
  correct_answer: string
  student_answer: string
}

export interface EvaluateAnswerResponse {
  correct: boolean
  partial_credit: boolean
  feedback: string
}

export interface DeduplicateRequest {
  modules: {
    module_id: string
    module_name: string
    concepts: Omit<Concept, 'id' | 'created_at' | 'module_ids'>[]
  }[]
}

export interface MergePlan {
  keep: string
  merge: string[]
  combined_module_ids: string[]
}

export interface DeduplicateResponse {
  merge_plan: MergePlan[]
  unique_concepts: {
    name: string
    module_ids: string[]
    description: string
    key_facts: string[]
    difficulty: number
    source_excerpt: string
  }[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// Store types
export type IngestionStatus = 'idle' | 'uploading' | 'extracting' | 'deduplicating' | 'reviewing' | 'generating' | 'done'
