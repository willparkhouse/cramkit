import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getApiKey } from './apiKey'
import type {
  ExtractConceptsRequest,
  ExtractConceptsResponse,
  GenerateQuestionsRequest,
  GenerateQuestionsResponse,
  EvaluateAnswerRequest,
  EvaluateAnswerResponse,
  DeduplicateRequest,
  DeduplicateResponse,
  Exam,
  Concept,
  Question,
  KnowledgeEntry,
  RevisionSlot,
  ModuleEnrollment,
  ModuleRequest,
  ModuleRequestVote,
} from '@/types'

// Use Sonnet 4.6 for everything realtime — eval quality on technical
// material is meaningfully better than Haiku, and the cost delta on a
// ~200-token eval is negligible.
const SONNET_MODEL = 'claude-sonnet-4-6'
const EVAL_MODEL = SONNET_MODEL
const CHAT_MODEL = SONNET_MODEL

// ============================================================================
// Server-side ingestion (uses platform Anthropic key)
// JWT from Supabase session is sent for user identification
// ============================================================================

async function authedPost<T>(url: string, body: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`API error ${res.status}: ${error}`)
  }
  return res.json()
}

export async function extractConcepts(req: ExtractConceptsRequest): Promise<ExtractConceptsResponse> {
  return authedPost('/api/extract-concepts', req)
}

export async function deduplicateConcepts(req: DeduplicateRequest): Promise<DeduplicateResponse> {
  return authedPost('/api/deduplicate', req)
}

export async function generateQuestions(req: GenerateQuestionsRequest): Promise<GenerateQuestionsResponse> {
  return authedPost('/api/generate-questions', req)
}

// ============================================================================
// Browser-side AI calls (BYOK — uses user's own Anthropic key)
// ============================================================================

/**
 * Shared formatting rules appended to chat system prompts so the assistant
 * produces output that our markdown renderer can actually display.
 */
const FORMATTING_RULES = `Formatting rules — your output is rendered through a markdown renderer with KaTeX math and GFM tables, so:
- Wrap inline math in single dollar signs: $x^2 + y^2$. Wrap display math in double dollar signs on their own line: $$\\frac{1}{n} \\sum_i x_i$$.
- NEVER put math inside backticks or code fences. Backticks are for actual code only.
- For variables, equations, Greek letters, vectors, subscripts, superscripts, fractions, sums, integrals, etc — always use LaTeX in dollar signs.
- Use proper markdown tables (with pipes) for tabular comparisons. Don't try to align columns with spaces.
- Keep responses tight: short paragraphs, lists where appropriate, avoid horizontal rules unless genuinely separating sections.`

class MissingApiKeyError extends Error {
  constructor() {
    super('No Anthropic API key configured. Add one in Settings.')
    this.name = 'MissingApiKeyError'
  }
}

function getAnthropicClient(): Anthropic {
  const apiKey = getApiKey()
  if (!apiKey) throw new MissingApiKeyError()
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
}

export { MissingApiKeyError }

export async function evaluateAnswer(req: EvaluateAnswerRequest): Promise<EvaluateAnswerResponse> {
  const client = getAnthropicClient()
  const response = await client.messages.create({
    model: EVAL_MODEL,
    max_tokens: 400,
    system: `You are evaluating a university student's exam answer for them, in real time.

Speak DIRECTLY to the student in second person ("you", "your answer") — never refer to them as "the student" or in third person. Be warm but honest, like a tutor giving quick feedback.

Be generous with partial credit: if the student demonstrates partial understanding of the key idea, mark partial_credit true. If they got the gist right even with imperfect wording, mark correct true.

Return ONLY a JSON object with this exact shape (no markdown, no code fences):
{ "correct": boolean, "partial_credit": boolean, "feedback": "1-2 sentences addressing the student directly" }`,
    messages: [
      {
        role: 'user',
        content: `Question: ${req.question}\nCorrect answer: ${req.correct_answer}\nMy answer: ${req.student_answer}`,
      },
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { correct: false, partial_credit: false, feedback: 'Could not evaluate answer.' }
  }
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return { correct: false, partial_credit: false, feedback: 'Could not evaluate answer.' }
  }
}

export async function streamChat(
  messages: { role: string; content: string }[],
  conceptContext: string,
  onChunk: (text: string) => void,
): Promise<void> {
  const client = getAnthropicClient()
  const systemPrompt = `You are a helpful tutor helping a student revise for their university exams.
You are currently helping them learn about a specific concept. Use the context below to ground your answers
in the actual course material. Be concise, clear, and focused on helping them understand.

${FORMATTING_RULES}

Context from course notes:
${conceptContext}`

  const stream = await client.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  })

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onChunk(event.delta.text)
    }
  }
}

// ============================================================================
// Source RAG: retrieves chunks across lecture transcripts and slides from
// the server, then streams Claude in the browser (BYOK) with citation
// protocol [[CITE:n]].
// ============================================================================

export interface SourceChunk {
  chunk_id: string
  source_code: string
  source_type: 'lecture' | 'slides' | string
  module: string
  url: string
  locator: Record<string, unknown>
  chunk_text: string
  similarity: number
  deep_link: string
  position_label: string
}

export async function searchSources(
  query: string,
  module?: string,
  sourceTypes?: string[],
  matchCount?: number,
): Promise<SourceChunk[]> {
  const { chunks } = await authedPost<{ chunks: SourceChunk[] }>('/api/source-search', {
    query,
    module,
    source_types: sourceTypes,
    match_count: matchCount,
  })
  return chunks
}

export async function streamSourceChat(
  messages: { role: string; content: string }[],
  chunks: SourceChunk[],
  onChunk: (text: string) => void,
): Promise<void> {
  const client = getAnthropicClient()

  const sources = chunks
    .map(
      (c, i) =>
        `[${i + 1}] (${c.source_type}) ${c.source_code} ${c.position_label}\n${c.chunk_text}`
    )
    .join('\n\n')

  const systemPrompt = `You are a tutor helping a student revise. You have access to retrieved excerpts from their course materials — both lecture transcripts and slide decks — listed below as numbered sources.

Ground your answers in these excerpts. When you reference something specific, cite it inline using the exact form [[CITE:N]] where N is the source number. You may cite multiple sources. Only cite sources that actually appear below — never invent citations.

If the sources don't contain enough to answer, say so honestly rather than guessing.

${FORMATTING_RULES}

Sources:
${sources}`

  const stream = await client.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  })

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onChunk(event.delta.text)
    }
  }
}

// ============================================================================
// CRUD via Supabase (client-side, RLS enforces ownership)
// ============================================================================

export async function fetchExams(): Promise<Exam[]> {
  const { data, error } = await supabase.from('exams').select('*').order('date')
  if (error) throw error
  return (data || []) as Exam[]
}

// ============================================================================
// Module enrollments
// ============================================================================

export async function fetchEnrollments(): Promise<ModuleEnrollment[]> {
  const { data, error } = await supabase.from('module_enrollments').select('*')
  if (error) throw error
  return (data || []) as ModuleEnrollment[]
}

export async function enrollInModule(moduleId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('module_enrollments')
    .insert({ user_id: user.id, module_id: moduleId })
  if (error && error.code !== '23505') throw error // ignore unique violation
}

export async function unenrollFromModule(moduleId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('module_enrollments')
    .delete()
    .eq('user_id', user.id)
    .eq('module_id', moduleId)
  if (error) throw error
}

// ============================================================================
// Module requests + votes
// ============================================================================

export async function fetchModuleRequests(): Promise<ModuleRequest[]> {
  const { data, error } = await supabase
    .from('module_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as ModuleRequest[]
}

export async function fetchRequestVotes(): Promise<ModuleRequestVote[]> {
  const { data, error } = await supabase.from('module_request_votes').select('*')
  if (error) throw error
  return (data || []) as ModuleRequestVote[]
}

export async function createModuleRequest(name: string, description: string): Promise<ModuleRequest> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('module_requests')
    .insert({
      name: name.trim(),
      description: description.trim() || null,
      requested_by: user.id,
    })
    .select()
    .single()
  if (error) throw error
  return data as ModuleRequest
}

export async function voteForRequest(requestId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('module_request_votes')
    .insert({ request_id: requestId, user_id: user.id })
  if (error && error.code !== '23505') throw error
}

export async function unvoteRequest(requestId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase
    .from('module_request_votes')
    .delete()
    .eq('request_id', requestId)
    .eq('user_id', user.id)
  if (error) throw error
}

// ============================================================================
// Concepts (filtered by user's enrolled modules)
// ============================================================================

export async function fetchConcepts(enrolledModuleIds: string[]): Promise<Concept[]> {
  if (enrolledModuleIds.length === 0) return []

  const { data, error } = await supabase
    .from('concepts')
    .select('*')
    .overlaps('module_ids', enrolledModuleIds)
    .order('name')
  if (error) throw error
  return (data || []) as Concept[]
}

export async function fetchConceptsMissingQuestions(): Promise<Concept[]> {
  const { data, error } = await supabase
    .from('concepts')
    .select('*, questions(id)')
  if (error) throw error
  return ((data || []) as Array<Concept & { questions: { id: string }[] }>)
    .filter((c) => !c.questions || c.questions.length === 0)
    .map((c) => {
      const { questions, ...rest } = c
      void questions
      return rest as Concept
    })
}

export async function saveConcepts(concepts: Partial<Concept>[]): Promise<Concept[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const rows = concepts.map((c) => ({
    user_id: user.id,
    name: c.name,
    description: c.description,
    key_facts: c.key_facts || [],
    module_ids: c.module_ids || [],
    difficulty: c.difficulty,
    source_excerpt: c.source_excerpt || null,
    week: c.week ?? null,
    lecture: c.lecture ?? null,
  }))

  const { data, error } = await supabase.from('concepts').insert(rows).select()
  if (error) throw error
  return (data || []) as Concept[]
}

export async function fetchQuestions(conceptIds: string[]): Promise<Question[]> {
  if (conceptIds.length === 0) return []

  // Postgres has a limit on `in` clause size — chunk if needed
  const CHUNK = 200
  const all: Question[] = []
  for (let i = 0; i < conceptIds.length; i += CHUNK) {
    const chunk = conceptIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('questions')
      .select('*')
      .in('concept_id', chunk)
    if (error) throw error
    all.push(...((data || []) as Question[]))
  }
  return all
}

export async function saveQuestions(questions: Partial<Question>[]): Promise<Question[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const rows = questions.map((q) => ({
    user_id: user.id,
    concept_id: q.concept_id,
    type: q.type,
    difficulty: q.difficulty,
    question: q.question,
    options: q.options || null,
    correct_answer: q.correct_answer,
    explanation: q.explanation || null,
    source: q.source || 'batch',
    times_used: q.times_used || 0,
  }))

  const { data, error } = await supabase.from('questions').insert(rows).select()
  if (error) throw error
  return (data || []) as Question[]
}

export async function updateQuestion(id: string, updates: Partial<Question>): Promise<void> {
  const { error } = await supabase.from('questions').update(updates).eq('id', id)
  if (error) throw error
}

export async function fetchKnowledge(): Promise<KnowledgeEntry[]> {
  const { data, error } = await supabase.from('knowledge').select('*')
  if (error) throw error
  return (data || []) as KnowledgeEntry[]
}

export async function syncKnowledge(entries: KnowledgeEntry[]): Promise<void> {
  if (entries.length === 0) return
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const rows = entries.map((k) => ({
    user_id: user.id,
    concept_id: k.concept_id,
    score: k.score,
    last_tested: k.last_tested,
    history: k.history,
    updated_at: k.updated_at,
  }))

  const { error } = await supabase
    .from('knowledge')
    .upsert(rows, { onConflict: 'user_id,concept_id' })
  if (error) throw error
}

export async function fetchSlots(): Promise<RevisionSlot[]> {
  const { data, error } = await supabase
    .from('revision_slots')
    .select('*')
    .order('start_time')
  if (error) throw error
  return (data || []) as RevisionSlot[]
}

export async function createSlot(slot: Partial<RevisionSlot>): Promise<RevisionSlot> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('revision_slots')
    .insert({
      user_id: user.id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      allocated_module_id: slot.allocated_module_id || null,
      calendar_event_id: slot.calendar_event_id || null,
      status: slot.status || 'pending',
    })
    .select()
    .single()
  if (error) throw error
  return data as RevisionSlot
}

export async function updateSlot(id: string, updates: Partial<RevisionSlot>): Promise<void> {
  const { error } = await supabase.from('revision_slots').update(updates).eq('id', id)
  if (error) throw error
}

export async function deleteSlot(id: string): Promise<void> {
  const { error } = await supabase.from('revision_slots').delete().eq('id', id)
  if (error) throw error
}
