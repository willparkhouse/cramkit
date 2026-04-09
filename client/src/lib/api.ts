import Anthropic from '@anthropic-ai/sdk'
import { supabase } from './supabase'
import { getApiKey } from './apiKey'
import { getCurrentTier } from './subscription'
import {
  HINT_TERSE_PROMPT,
  HINT_DETAILED_PROMPT,
  LESSON_SYSTEM_PROMPT,
  buildHintUserContent,
  buildLessonUserContent,
  type HintContextPayload,
} from './aiPrompts'
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
// Admin API: module + source ingest management
// ============================================================================

export interface AdminModule extends Exam {
  coverage: { slide_decks: number; lectures: number; chunks: number }
  questions: {
    concepts: number
    /** concepts with 0 questions */
    with_zero: number
    /** concepts with 1–2 questions (sparse) */
    with_low: number
    /** concepts with ≥3 questions (healthy) */
    with_ok: number
  }
}

export interface AdminSource {
  id: string
  code: string
  source_type: 'slides' | 'lecture' | string
  week: number | null
  lecture: string | null
  title: string | null
  url: string
  created_at: string
}

export async function adminListModules(): Promise<AdminModule[]> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch('/api/admin/modules', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const { modules } = await res.json()
  return modules as AdminModule[]
}

export async function adminCreateModule(input: {
  name: string
  slug: string
  short_name: string
  date: string
  weight: number
  semester: number
}): Promise<Exam> {
  const { module } = await authedPost<{ module: Exam }>('/api/admin/modules', input)
  return module
}

export interface AdminModuleRequest {
  id: string
  name: string
  description: string | null
  requested_by: string | null
  status: string
  created_at: string
  linked_exam_id: string | null
  vote_count: number
}

export async function adminListModuleRequests(): Promise<AdminModuleRequest[]> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch('/api/admin/module-requests', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const { requests } = await res.json()
  return requests as AdminModuleRequest[]
}

export async function adminLinkModuleRequest(id: string, examId: string | null): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(`/api/admin/module-requests/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ linked_exam_id: examId }),
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
}

export async function adminUpdateModule(
  id: string,
  patch: Partial<{
    name: string
    slug: string
    short_name: string
    date: string
    weight: number
    semester: number
    is_published: boolean
  }>
): Promise<Exam> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(`/api/admin/modules/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const { module } = await res.json()
  return module as Exam
}

export async function adminDeleteModule(id: string, confirmSlug: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(`/api/admin/modules/${id}?confirm=${encodeURIComponent(confirmSlug)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
}

export async function adminListSources(moduleSlug: string): Promise<AdminSource[]> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(`/api/admin/sources?module=${encodeURIComponent(moduleSlug)}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const { sources } = await res.json()
  return sources as AdminSource[]
}

export async function adminDeleteSource(id: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(`/api/admin/sources/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
}

export async function adminUploadSlides(input: {
  moduleSlug: string
  week: number
  lecture?: string
  title?: string
  file: File
}): Promise<{ source_id: string; code: string; pages: number; chunks_inserted: number }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const form = new FormData()
  form.append('module', input.moduleSlug)
  form.append('week', String(input.week))
  if (input.lecture) form.append('lecture', input.lecture)
  if (input.title) form.append('title', input.title)
  form.append('file', input.file)

  const res = await fetch('/api/admin/sources/slides', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: form,
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function adminUploadTranscript(input: {
  module: string
  week: number
  lecture: string
  panopto_url: string
  transcript_text: string
}): Promise<{ source_id: string; code: string; lines: number; chunks_inserted: number }> {
  return authedPost('/api/admin/sources/transcript', input)
}

// ----------------------------------------------------------------------------
// Per-week lecture titles — see admin.ts for the underlying endpoint.
// ----------------------------------------------------------------------------
export interface WeekTitle {
  week: number
  concept_count: number
  current_title: string | null
}

export async function adminListWeekTitles(moduleId: string): Promise<WeekTitle[]> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(`/api/admin/modules/${moduleId}/week-titles`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  const { weeks } = await res.json()
  return weeks as WeekTitle[]
}

export async function adminUpdateWeekTitles(
  moduleId: string,
  titles: Record<number, string | null>,
): Promise<{ updated: number; weeks_set: number }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(`/api/admin/modules/${moduleId}/week-titles`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ titles }),
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  return res.json()
}

// ============================================================================
// Admin content pipeline (extract → review → promote → generate questions)
// ============================================================================

export interface PipelineDraft {
  id: string
  module: string
  status: 'pending' | 'running' | 'ready' | 'failed' | 'promoted' | 'discarded'
  generated_at: string
  promoted_at: string | null
  error_message: string | null
  progress: { weeks_total?: number; weeks_done?: number; last_week?: number | null; failures?: number[] } | null
  total_concepts: number
  by_week: Record<string, number>
  has_coverage_report: boolean
}

export interface PipelineDraftFull {
  id: string
  module: string
  status: PipelineDraft['status']
  generated_at: string
  promoted_at: string | null
  error_message: string | null
  progress: PipelineDraft['progress']
  payload: {
    module: string
    generated_at: string
    total_concepts: number
    by_week: Record<string, number>
    concepts: Array<{
      name: string
      description: string
      key_facts: string[]
      difficulty: number
      source_chunk_ids: string[]
      week: number | null
      lecture: string | null
    }>
    coverage_report: string | null
  }
  coverage_report: string | null
}

export interface PipelineJob {
  id: string
  kind: 'extract' | 'promote' | 'generate-questions'
  module: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at: string
  finished_at?: string
  progress?: Record<string, unknown>
  logs: string[]
  result?: Record<string, unknown>
  error?: string
}

async function authedGet<T>(url: string): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function pipelineListDrafts(moduleSlug?: string): Promise<PipelineDraft[]> {
  const url = moduleSlug
    ? `/api/admin/pipeline/drafts?module=${encodeURIComponent(moduleSlug)}`
    : '/api/admin/pipeline/drafts'
  const { drafts } = await authedGet<{ drafts: PipelineDraft[] }>(url)
  return drafts
}

export async function pipelineGetDraft(id: string): Promise<PipelineDraftFull> {
  const { draft } = await authedGet<{ draft: PipelineDraftFull }>(`/api/admin/pipeline/drafts/${id}`)
  return draft
}

export async function pipelineDiscardDraft(id: string): Promise<void> {
  await authedPost(`/api/admin/pipeline/drafts/${id}/discard`, {})
}

export async function pipelineGetJob(id: string): Promise<PipelineJob> {
  const { job } = await authedGet<{ job: PipelineJob }>(`/api/admin/pipeline/jobs/${id}`)
  return job
}

export async function pipelineExtract(input: {
  module: string
  skip_coverage?: boolean
  model?: 'sonnet' | 'haiku'
}): Promise<{ job_id: string; draft_id: string }> {
  return authedPost('/api/admin/pipeline/extract', input)
}

export async function pipelinePromote(input: {
  draft_id: string
  mode?: 'skip' | 'replace'
  dry_run?: boolean
}): Promise<{ result: { module: string; inserted: number; skipped: number; deleted: number; draft_id: string; dry_run: boolean } }> {
  return authedPost('/api/admin/pipeline/promote', input)
}

export async function pipelineGenerateQuestions(input: {
  module: string
  scope?: 'missing' | 'all'
}): Promise<{ job_id: string }> {
  return authedPost('/api/admin/pipeline/generate-questions', input)
}

// ============================================================================
// Question hint — see server/src/routes/hint.ts for the route shape.
//
// Two paths, mirroring the lesson + chat features:
//   - Pro    → POST /api/question-hint (server proxy, SSE).
//   - BYOK   → POST /api/question-hint/context to fetch question + concept
//              + chunks, then call Anthropic from the browser with the
//              user's key.
//
// The hint server prompt is mirrored in client/src/lib/aiPrompts.ts so the
// BYOK browser path generates an identical hint.
// ============================================================================

export interface HintStreamHandlers {
  /** Called for every streamed delta. Caller appends to a running buffer. */
  onDelta: (chunk: string) => void
  onDone?: () => void
  onError?: (message: string) => void
  /** Free user with no BYOK key configured. Caller should open setup. */
  onMissingKey?: () => void
}

export interface HintOptions {
  questionId: string
  level: 'terse' | 'detailed'
  /** For 'detailed' level: the prior terse text the model should continue from. */
  previous: string
}

export async function streamHint(
  opts: HintOptions,
  handlers: HintStreamHandlers,
): Promise<void> {
  if (getCurrentTier() === 'pro') {
    return streamHintViaProxy(opts, handlers)
  }
  return streamHintViaBYOK(opts, handlers)
}

async function streamHintViaProxy(
  opts: HintOptions,
  handlers: HintStreamHandlers,
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch('/api/question-hint', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      question_id: opts.questionId,
      level: opts.level,
      previous: opts.previous,
    }),
  })
  if (!res.ok || !res.body) {
    handlers.onError?.(`Hint request failed: ${res.status}`)
    return
  }
  await consumeSSE(res.body, handlers)
}

async function streamHintViaBYOK(
  opts: HintOptions,
  handlers: HintStreamHandlers,
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  // Fetch question + concept + grounded chunks (no Anthropic call)
  const ctxRes = await fetch('/api/question-hint/context', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ question_id: opts.questionId }),
  })
  if (!ctxRes.ok) {
    handlers.onError?.(`Hint context failed: ${ctxRes.status}`)
    return
  }
  const ctx = (await ctxRes.json()) as HintContextPayload

  let client: Anthropic
  try {
    client = getAnthropicClient()
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      handlers.onMissingKey?.()
      return
    }
    throw err
  }

  const userContent = buildHintUserContent(ctx, opts.previous)
  const systemPrompt = opts.level === 'detailed' ? HINT_DETAILED_PROMPT : HINT_TERSE_PROMPT
  const maxTokens = opts.level === 'detailed' ? 500 : 200

  try {
    const stream = await client.messages.stream({
      model: SONNET_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        handlers.onDelta(event.delta.text)
      }
    }
    handlers.onDone?.()
  } catch (err) {
    handlers.onError?.((err as Error).message ?? 'Hint stream failed')
  }
}

// Shared SSE consumer for the hint Pro proxy. The lesson Pro proxy reuses
// the same wire format but with an extra 'cached' event, so it has its own
// inline parser. Hint never sends 'cached' so this simpler version is fine.
async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  handlers: HintStreamHandlers,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const evt of events) {
      const lines = evt.split('\n')
      let eventName = 'message'
      const dataLines: string[] = []
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          // Strip exactly one optional space after `data:` per SSE framing
          // — preserves payload tokens that begin with whitespace.
          const raw = line.slice(5)
          dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw)
        }
      }
      const data = dataLines.join('\n')
      if (eventName === 'delta') {
        handlers.onDelta(data)
      } else if (eventName === 'done') {
        handlers.onDone?.()
      } else if (eventName === 'error') {
        handlers.onError?.(data || 'Stream failed')
        return
      }
    }
  }
}

// ============================================================================
// Lesson walkthrough — see server/src/routes/lesson.ts for the route shape.
//
// Two paths, mirroring the existing chat features:
//   - Pro    → POST /api/lesson, server runs Sonnet on platform credit and
//              writes the result to the shared cache.
//   - BYOK   → GET  /api/lesson/context/:id (cache hit or grounded chunks),
//              call Anthropic from the browser with the user's key, POST
//              the result back to /api/lesson/cache so the next reader
//              benefits from the work.
//
// The same SONNET_MODEL + LESSON_SYSTEM_PROMPT is used in both paths so a
// BYOK-generated body is interchangeable with a Pro-generated one in the
// shared cache.
// ============================================================================

export interface LessonStreamHandlers {
  onDelta: (chunk: string) => void
  onCached?: (generatedAt: string) => void
  onDone?: () => void
  onError?: (message: string) => void
  /** Free user with no BYOK key configured. Caller should open setup. */
  onMissingKey?: () => void
}

interface LessonContextResponse {
  concept: { id: string; name: string; description: string; key_facts: string[] }
  chunks: Array<{ source_code: string; source_type: string; chunk_text: string }>
  cached: { body: string; generated_at: string } | null
}

export async function streamLesson(
  conceptId: string,
  handlers: LessonStreamHandlers,
): Promise<void> {
  if (getCurrentTier() === 'pro') {
    return streamLessonViaProxy(conceptId, handlers)
  }
  return streamLessonViaBYOK(conceptId, handlers)
}

// Pro path: server SSE stream from /api/lesson. Same parser shape as the
// hint route — events are 'cached' (informational), 'delta', 'done', 'error'.
async function streamLessonViaProxy(
  conceptId: string,
  handlers: LessonStreamHandlers,
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch('/api/lesson', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ concept_id: conceptId }),
  })

  if (!res.ok || !res.body) {
    handlers.onError?.(`Lesson request failed: ${res.status}`)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const evt of events) {
      const lines = evt.split('\n')
      let eventName = 'message'
      const dataLines: string[] = []
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          // Strip exactly one optional space after `data:` per SSE framing
          // — preserves payload that begins with whitespace.
          const raw = line.slice(5)
          dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw)
        }
      }
      const data = dataLines.join('\n')
      if (eventName === 'delta') {
        handlers.onDelta(data)
      } else if (eventName === 'cached') {
        handlers.onCached?.(data)
      } else if (eventName === 'done') {
        handlers.onDone?.()
      } else if (eventName === 'error') {
        handlers.onError?.(data || 'Lesson failed')
        return
      }
    }
  }
}

// BYOK path: fetch context from server (no Anthropic call), render the
// cached body if present, otherwise stream Anthropic directly with the
// user's key and POST the result back to the shared cache.
async function streamLessonViaBYOK(
  conceptId: string,
  handlers: LessonStreamHandlers,
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  // 1. Fetch context (chunks + concept + maybe-cached body)
  const ctxRes = await fetch(`/api/lesson/context/${encodeURIComponent(conceptId)}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!ctxRes.ok) {
    handlers.onError?.(`Lesson context failed: ${ctxRes.status}`)
    return
  }
  const ctx = (await ctxRes.json()) as LessonContextResponse

  // 2. Cache hit → render the existing body in one call
  if (ctx.cached) {
    handlers.onCached?.(ctx.cached.generated_at)
    handlers.onDelta(ctx.cached.body)
    handlers.onDone?.()
    return
  }

  // 3. Cache miss → BYOK key required to generate
  let client: Anthropic
  try {
    client = getAnthropicClient()
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      handlers.onMissingKey?.()
      return
    }
    throw err
  }

  const userContent = buildLessonUserContent(ctx)
  let fullText = ''
  try {
    const stream = await client.messages.stream({
      model: SONNET_MODEL,
      max_tokens: 1200,
      system: LESSON_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    })
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text
        handlers.onDelta(event.delta.text)
      }
    }
    handlers.onDone?.()
  } catch (err) {
    handlers.onError?.((err as Error).message ?? 'Lesson stream failed')
    return
  }

  // 4. Best-effort: contribute to the shared cache so the next reader
  //    (Pro or BYOK) gets it instantly. Non-fatal if it fails.
  if (fullText.trim()) {
    void fetch('/api/lesson/cache', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        concept_id: conceptId,
        body: fullText,
        model: SONNET_MODEL,
      }),
    }).catch(() => {
      // Cache contribution is opportunistic — failure shouldn't surface to the user.
    })
  }
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
    super('No Anthropic API key configured. Add one in Settings or upgrade to Pro.')
    this.name = 'MissingApiKeyError'
  }
}

function getAnthropicClient(): Anthropic {
  const apiKey = getApiKey()
  if (!apiKey) throw new MissingApiKeyError()
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
}

export { MissingApiKeyError }

/**
 * Stream the body of a server proxy response (plain UTF-8 chunks, no SSE
 * framing) into the existing onChunk callback. Throws on non-OK status so
 * callers can handle 402 / 401 the same way as MissingApiKeyError.
 */
async function streamProxyResponse(
  url: string,
  body: unknown,
  onChunk: (text: string) => void
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })

  if (res.status === 402) throw new MissingApiKeyError()
  if (!res.ok) throw new Error(`proxy ${res.status}: ${await res.text()}`)
  if (!res.body) throw new Error('proxy returned empty body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) onChunk(decoder.decode(value, { stream: true }))
  }
}

export async function evaluateAnswer(req: EvaluateAnswerRequest): Promise<EvaluateAnswerResponse> {
  // Pro users go through the server proxy so they don't need their own key.
  if (getCurrentTier() === 'pro') {
    return authedPost<EvaluateAnswerResponse>('/api/evaluate', req)
  }

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
  if (getCurrentTier() === 'pro') {
    await streamProxyResponse('/api/chat', { messages, context: conceptContext }, onChunk)
    return
  }

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

/**
 * Source material that grounded a single question. No LLM, no embedding —
 * each question stores the chunk ids it was generated from
 * (`questions.source_chunk_ids`), so we just hydrate them with a join.
 *
 * Used by the quiz post-answer "Source from lectures" disclosure so students
 * can see the lecture passage their question came from.
 */
export interface QuestionSourceChunk {
  chunk_id: string
  chunk_text: string
  source_code: string
  source_type: string
  module: string
  url: string | null
  locator: Record<string, unknown>
  /** Type-aware deep link: Panopto ?start= for lectures, #page= for slides. */
  deep_link: string | null
  /** Human label like "3:42" or "slide 7". Empty for unknown source types. */
  position_label: string
}

function formatChunkTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function decorateQuestionChunk(
  url: string | null,
  sourceType: string,
  locator: Record<string, unknown>,
): { deep_link: string | null; position_label: string } {
  if (!url) return { deep_link: null, position_label: '' }
  if (sourceType === 'lecture') {
    const start = Number(locator.start_seconds || 0)
    const sep = url.includes('?') ? '&' : '?'
    return { deep_link: `${url}${sep}start=${start}`, position_label: formatChunkTimestamp(start) }
  }
  if (sourceType === 'slides') {
    const startPage = Number(locator.start_page || 1)
    const endPage = Number(locator.end_page || startPage)
    return {
      deep_link: `${url}#page=${startPage}`,
      position_label: startPage === endPage ? `slide ${startPage}` : `slides ${startPage}–${endPage}`,
    }
  }
  return { deep_link: url, position_label: '' }
}

export async function fetchQuestionSourceChunks(
  chunkIds: string[],
): Promise<QuestionSourceChunk[]> {
  if (!chunkIds || chunkIds.length === 0) return []
  const { data, error } = await supabase
    .from('source_chunks')
    .select('id, text, locator, sources!inner(code, source_type, module, url)')
    .in('id', chunkIds)
  if (error) throw error
  // Preserve the order in which chunk ids were stored on the question — that
  // order is meaningful (the generator put the most relevant chunk first).
  type Row = {
    id: string
    text: string
    locator: Record<string, unknown>
    sources: { code: string; source_type: string; module: string; url: string | null }
  }
  const rows = (data ?? []) as unknown as Row[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  return chunkIds
    .map((id) => byId.get(id))
    .filter((r): r is Row => !!r)
    .map((r) => {
      const locator = r.locator ?? {}
      const decorated = decorateQuestionChunk(r.sources.url, r.sources.source_type, locator)
      return {
        chunk_id: r.id,
        chunk_text: r.text,
        source_code: r.sources.code,
        source_type: r.sources.source_type,
        module: r.sources.module,
        url: r.sources.url,
        locator,
        deep_link: decorated.deep_link,
        position_label: decorated.position_label,
      }
    })
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
  if (getCurrentTier() === 'pro') {
    // Server only needs the fields it'll embed in the system prompt.
    const slim = chunks.map((c) => ({
      source_code: c.source_code,
      source_type: c.source_type,
      position_label: c.position_label,
      chunk_text: c.chunk_text,
    }))
    await streamProxyResponse('/api/source-chat', { messages, chunks: slim }, onChunk)
    return
  }

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

/**
 * Express interest in an unpublished module that already exists. Looks for
 * an existing request linked to this exam — if none, creates one — then
 * casts the user's vote on it. When the admin publishes the module, the
 * publish trigger auto-enrolls everyone who voted.
 */
export async function expressInterestInModule(exam: Exam): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Find an existing request for this exam.
  const { data: existing } = await supabase
    .from('module_requests')
    .select('id')
    .eq('linked_exam_id', exam.id)
    .maybeSingle()

  let requestId: string
  if (existing) {
    requestId = existing.id as string
  } else {
    const { data: created, error: createErr } = await supabase
      .from('module_requests')
      .insert({
        name: exam.name,
        description: `Auto-created from in-app interest in unpublished module ${exam.slug}`,
        requested_by: user.id,
        linked_exam_id: exam.id,
      })
      .select('id')
      .single()
    if (createErr) throw createErr
    requestId = created.id as string
  }

  // Cast the vote (idempotent — ignore unique violation).
  const { error: voteErr } = await supabase
    .from('module_request_votes')
    .insert({ request_id: requestId, user_id: user.id })
  if (voteErr && voteErr.code !== '23505') throw voteErr
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

/**
 * Page through all concepts (with their question id list) to bypass the
 * default 1000-row PostgREST limit. We have ~400 concepts and ~1800 questions
 * across the bank — without paging, the second page silently disappears and
 * any concept past row 1000 looks like it has no questions.
 */
async function fetchAllConceptsWithQuestionIds(): Promise<Array<Concept & { questions: { id: string }[] }>> {
  const PAGE = 1000
  const out: Array<Concept & { questions: { id: string }[] }> = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('concepts')
      .select('*, questions(id)')
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data || []) as Array<Concept & { questions: { id: string }[] }>
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

export async function fetchConceptsMissingQuestions(): Promise<Concept[]> {
  const all = await fetchAllConceptsWithQuestionIds()
  return all
    .filter((c) => !c.questions || c.questions.length === 0)
    .map((c) => {
      const { questions, ...rest } = c
      void questions
      return rest as Concept
    })
}

/**
 * Fetch concepts whose question count is below a threshold (default <3).
 * Used by the admin status page's "Top up sparse" action.
 */
export async function fetchConceptsBelowQuestionThreshold(threshold = 3): Promise<Concept[]> {
  const all = await fetchAllConceptsWithQuestionIds()
  return all
    .filter((c) => (c.questions?.length ?? 0) < threshold)
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
    is_past_paper: q.is_past_paper ?? false,
    source_chunk_ids: q.source_chunk_ids ?? [],
    evidence_quote: q.evidence_quote ?? null,
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
