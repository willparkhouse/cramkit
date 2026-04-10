/**
 * POST /api/lesson
 *
 * Streams a 2-3 paragraph "study this concept" walkthrough for the Study
 * page. Generic content (same for every user) so we cache by concept_id in
 * the lesson_explanations table — first request pays the LLM cost, every
 * subsequent request streams from the cache.
 *
 * Pro-gated. Rate-limited 30/min/user.
 *
 * Inputs (JSON body):
 *   concept_id      uuid of the concept to explain
 *
 * Stream events:
 *   event: cached   sent at the start when serving from cache (informational)
 *   event: delta    one chunk of text
 *   event: done     end of stream, no payload
 *   event: error    one-line error message, stream then closes
 */
import { Hono } from 'hono'
import { streamSSE, stream } from 'hono/streaming'
import { createClient } from '@supabase/supabase-js'
import { anthropic, SONNET_MODEL } from '../lib/anthropic.js'
import { requireAuth } from '../lib/auth.js'
import { requirePro } from '../lib/entitlement.js'
import { rateLimit } from '../lib/rateLimit.js'
import { retrieveChunks } from '../lib/retrieval.js'
import { recordUsage } from '../lib/usage.js'

type AppEnv = { Variables: { user: { id: string; email?: string } } }
const app = new Hono<AppEnv>()

// /lesson is the Pro proxy: server runs the Sonnet call on platform credit
// and writes the result to the shared cache. Free + BYOK users hit
// /lesson/context instead, build the prompt locally, call Anthropic with
// their own key, and POST the result back to /lesson/cache so the next
// reader benefits.
app.use(
  '/lesson',
  requireAuth,
  requirePro,
  rateLimit({ key: 'lesson', windowMs: 60_000, max: 10 })
)

app.use(
  '/lesson/context/*',
  requireAuth,
  rateLimit({ key: 'lesson-context', windowMs: 60_000, max: 15 })
)

app.use(
  '/lesson/cache',
  requireAuth,
  rateLimit({ key: 'lesson-cache', windowMs: 60_000, max: 10 })
)

// /lesson-chat is the Pro proxy for the inline "ask a follow-up about this
// concept" chat that hangs off the bottom of the lesson walkthrough. Same
// branch shape as /lesson — Pro hits this, BYOK reuses /lesson/context/:id
// to fetch the same chunks the walkthrough was grounded on, then calls
// Anthropic in the browser. 6/min is just above realistic human reading
// pace (one message every 10s) — anyone hitting it is spamming.
app.use(
  '/lesson-chat',
  requireAuth,
  requirePro,
  rateLimit({ key: 'lesson-chat', windowMs: 60_000, max: 6 })
)

function getServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  return createClient(url, key, { auth: { persistSession: false } })
}

const LESSON_SYSTEM_PROMPT = `You are a tutor walking a university student through one concept from their course. They're using this in a study session — they want to understand the topic from first principles, not be tested on it.

Write a 2-3 paragraph explanation that:
- Starts by stating what the concept is in plain language (one or two sentences)
- Then explains why it matters and how it fits into the broader topic
- Then walks through how it works, with the lecturer's terminology and notation where the chunks have it
- Closes with one practical implication or common pitfall the lecturer flagged

You will be given:
- The CONCEPT name and the lecturer's description of it
- The KEY FACTS the lecturer emphasised
- A set of SOURCE CHUNKS retrieved from the actual lectures and slides, listed as numbered sources [1], [2], …

Rules:
- Stay grounded in the source chunks. Don't invent examples or details that aren't there.
- Use the lecturer's exact phrasing and notation when the chunks have it. Students recognise their own course's terminology.
- When you state a specific fact, definition, formula, or example that comes from a chunk, cite it inline using the exact form [[CITE:N]] where N is the source number. You may cite multiple sources in one sentence ([[CITE:1]] [[CITE:3]]). Only cite numbers that actually appear in the SOURCE CHUNKS list — never invent citations. Aim for 3-6 citations across the whole walkthrough; cite where it adds value, don't sprinkle them.
- Plain prose. No headings, no bullet points. Treat this like a textbook section, not a slide deck.
- For maths, use LaTeX in dollar signs: $x^2$ inline or $$\\sum_i x_i$$ on its own line for display.
- Aim for ~250-400 words. Long enough to actually teach, short enough to read in 2 minutes.
- Don't restate the concept name as a heading at the top. Start straight into prose.
- Don't add a "summary" or "in summary" closing line. The last paragraph IS the summary.

If the source chunks are sparse or off-topic, write what you can from the description and key facts and end with: "(This walkthrough uses limited source material — refer back to the lecture for the full treatment.)"`

// Mirrored in client/src/lib/aiPrompts.ts. Update both sites if you change it.
const LESSON_CHAT_SYSTEM_PROMPT = `You are a tutor sitting next to a university student while they read a lesson walkthrough about ONE specific concept from their course. The walkthrough has just been generated for them; they have a follow-up question about something in it.

You will be given:
- The CONCEPT name and the lecturer's description of it
- The KEY FACTS the lecturer emphasised
- The WALKTHROUGH the student just read (treat this as the shared reference frame — they may say "this", "that bit", "the second paragraph")
- A set of SOURCE CHUNKS retrieved from the actual lectures and slides
- The chat HISTORY so far (if any), then their latest question

Rules:
- Stay focused on the concept the walkthrough is about. If the student asks something tangential, answer briefly and gently steer back.
- Treat the walkthrough as the shared context. Don't restate it — build on it. If they ask "what did you mean by X?", explain X without re-explaining the whole topic.
- Stay grounded in the walkthrough and the source chunks. Don't invent examples or details that aren't there.
- Use the lecturer's exact phrasing and notation when the chunks have it.
- The SOURCE CHUNKS are listed as numbered sources [1], [2], … — the SAME numbering the walkthrough already used. When you state a specific fact from a chunk, cite it inline using [[CITE:N]] where N is the source number. Only cite numbers that actually appear below; never invent citations.
- For maths, use LaTeX in dollar signs: $x^2$ inline or $$\\sum_i x_i$$ on its own line for display.
- Be concise. 1-3 short paragraphs is usually right. No headings. Bullets only if the question genuinely demands a list.
- If you genuinely don't know from the material in front of you, say so honestly rather than guessing.`

interface ConceptRow {
  id: string
  name: string
  description: string
  key_facts: string[] | null
  module_ids: string[]
}

interface CacheRow {
  concept_id: string
  body: string
  model: string
  generated_at: string
  source_chunk_ids: string[] | null
}

// ----------------------------------------------------------------------------
// Shared lookup: returns cached body (if any) plus the concept and chunks.
// Used by /lesson (Pro proxy) and /lesson/context/:id (BYOK).
//
// Chunks now carry the full grounding metadata the client needs to build deep
// links and render [[CITE:n]] tokens — chunk_id, source_id, url, locator,
// source_code, source_type, module, chunk_text. The client decorates url +
// locator into a Panopto ?start= or PDF #page= link.
// ----------------------------------------------------------------------------
export interface LessonChunkPayload {
  chunk_id: string
  source_id: string
  source_code: string
  source_type: string
  module: string
  url: string | null
  locator: Record<string, unknown>
  chunk_text: string
}

interface LessonContext {
  concept: { id: string; name: string; description: string; key_facts: string[] }
  chunks: LessonChunkPayload[]
  cached: { body: string; generated_at: string } | null
}

interface HydratedChunkRow {
  id: string
  text: string
  locator: Record<string, unknown> | null
  source_id: string
  sources: { code: string; source_type: string; module: string; url: string | null }
}

/**
 * Hydrate a list of chunk_ids back into LessonChunkPayloads, preserving the
 * input order. Used on cache hit so the [[CITE:n]] indices in the cached
 * walkthrough body still align with the chunks we return.
 */
async function hydrateChunksByIds(
  sb: ReturnType<typeof getServiceClient>,
  ids: string[],
): Promise<LessonChunkPayload[]> {
  if (ids.length === 0) return []
  const { data, error } = await sb
    .from('source_chunks')
    .select('id, text, locator, source_id, sources!inner(code, source_type, module, url)')
    .in('id', ids)
  if (error) {
    console.warn('lesson chunk hydration failed:', error.message)
    return []
  }
  const rows = (data ?? []) as unknown as HydratedChunkRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is HydratedChunkRow => !!r)
    .map((r) => ({
      chunk_id: r.id,
      source_id: r.source_id,
      source_code: r.sources.code,
      source_type: r.sources.source_type,
      module: r.sources.module,
      url: r.sources.url,
      locator: r.locator ?? {},
      chunk_text: r.text,
    }))
}

async function loadLessonContext(
  conceptId: string,
  userId: string | null,
): Promise<LessonContext | { error: string; status: number }> {
  const sb = getServiceClient()

  const { data: cached, error: cacheErr } = await sb
    .from('lesson_explanations')
    .select('concept_id, body, model, generated_at, source_chunk_ids')
    .eq('concept_id', conceptId)
    .maybeSingle<CacheRow>()
  if (cacheErr) console.error('lesson cache lookup failed:', cacheErr.message)

  const { data: concept, error: conceptErr } = await sb
    .from('concepts')
    .select('id, name, description, key_facts, module_ids')
    .eq('id', conceptId)
    .single<ConceptRow>()
  if (conceptErr || !concept) return { error: 'concept not found', status: 404 }

  // Cache hit with stored chunk_ids → hydrate those exact chunks so the
  // [[CITE:n]] indices in the cached body still align.
  if (cached?.body && cached.source_chunk_ids && cached.source_chunk_ids.length > 0) {
    const chunks = await hydrateChunksByIds(sb, cached.source_chunk_ids)
    return {
      concept: {
        id: concept.id,
        name: concept.name,
        description: concept.description,
        key_facts: concept.key_facts ?? [],
      },
      chunks,
      cached: { body: cached.body, generated_at: cached.generated_at },
    }
  }

  // Cache miss (or legacy row with no stored chunk_ids) → fresh retrieval.
  let moduleSlug: string | undefined
  if (concept.module_ids && concept.module_ids[0]) {
    const { data: exam } = await sb
      .from('exams')
      .select('slug')
      .eq('id', concept.module_ids[0])
      .single()
    moduleSlug = (exam?.slug as string | undefined) ?? undefined
  }

  const query = `${concept.name}. ${concept.description}. ${(concept.key_facts ?? []).slice(0, 5).join('. ')}`
  const chunks: LessonChunkPayload[] = []
  try {
    const retrieved = await retrieveChunks({
      query,
      module: moduleSlug,
      matchCount: 6,
      userId,
      endpoint: 'lesson',
    })
    for (const ch of retrieved) {
      chunks.push({
        chunk_id: ch.chunk_id,
        source_id: ch.source_id,
        source_code: ch.source_code,
        source_type: ch.source_type,
        module: ch.module,
        url: ch.url ?? null,
        locator: ch.locator ?? {},
        chunk_text: ch.chunk_text,
      })
    }
  } catch (e) {
    console.warn(`lesson retrieval failed for ${conceptId}:`, (e as Error).message)
  }

  return {
    concept: {
      id: concept.id,
      name: concept.name,
      description: concept.description,
      key_facts: concept.key_facts ?? [],
    },
    chunks,
    cached: cached?.body
      ? { body: cached.body, generated_at: cached.generated_at }
      : null,
  }
}

function buildLessonUserContent(ctx: LessonContext): string {
  const chunkBlock = ctx.chunks.length
    ? ctx.chunks
        .map((ch, i) => `[${i + 1}] (${ch.source_type}) ${ch.source_code}\n${ch.chunk_text}`)
        .join('\n\n---\n\n')
    : '(no chunks retrieved)'
  return `CONCEPT
Name: ${ctx.concept.name}
Description: ${ctx.concept.description}
Key facts: ${ctx.concept.key_facts.join('; ')}

SOURCE CHUNKS (cite as [[CITE:N]] using these numbers)

${chunkBlock}`
}

async function persistLessonCache(
  conceptId: string,
  body: string,
  model: string,
  chunkIds: string[],
): Promise<void> {
  if (!body.trim()) return
  const sb = getServiceClient()
  const { error: upsertErr } = await sb
    .from('lesson_explanations')
    .upsert(
      {
        concept_id: conceptId,
        body,
        model,
        generated_at: new Date().toISOString(),
        source_chunk_ids: chunkIds.length > 0 ? chunkIds : null,
      },
      { onConflict: 'concept_id' }
    )
  if (upsertErr) console.error('lesson cache upsert failed:', upsertErr.message)
}

// ----------------------------------------------------------------------------
// /lesson/context/:concept_id — auth-only retrieval used by BYOK clients.
// Returns the concept, chunks, and cached body (if any). The client renders
// the cache hit instantly; on miss it builds the prompt locally and calls
// Anthropic with the user's own key.
// ----------------------------------------------------------------------------
app.get('/lesson/context/:concept_id', async (c) => {
  const conceptId = c.req.param('concept_id')
  if (!conceptId) return c.json({ error: 'concept_id required' }, 400)
  const user = c.get('user')
  const result = await loadLessonContext(conceptId, user?.id ?? null)
  if ('error' in result) return c.json({ error: result.error }, result.status as 404)
  return c.json(result)
})

// ----------------------------------------------------------------------------
// /lesson/cache — BYOK clients post their generated body back here so the
// shared cache benefits everyone. No Anthropic call. Auth-only, basic
// length validation, no entitlement check.
// ----------------------------------------------------------------------------
const MAX_CACHED_BODY_BYTES = 16_000

app.post('/lesson/cache', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const conceptId = typeof body.concept_id === 'string' ? body.concept_id : null
  const text = typeof body.body === 'string' ? body.body : null
  const model = typeof body.model === 'string' ? body.model : 'unknown'
  const chunkIdsRaw = body.source_chunk_ids
  const chunkIds: string[] = Array.isArray(chunkIdsRaw)
    ? chunkIdsRaw.filter((s): s is string => typeof s === 'string')
    : []
  if (!conceptId || !text || !text.trim()) {
    return c.json({ error: 'concept_id and non-empty body required' }, 400)
  }
  if (text.length > MAX_CACHED_BODY_BYTES) {
    return c.json({ error: 'body too large' }, 413)
  }
  // Don't overwrite an existing cache entry — first writer wins. This stops
  // a malicious BYOK client from clobbering a known-good Pro-generated body
  // with garbage.
  const sb = getServiceClient()
  const { data: existing } = await sb
    .from('lesson_explanations')
    .select('concept_id')
    .eq('concept_id', conceptId)
    .maybeSingle()
  if (existing) return c.json({ ok: true, skipped: 'already cached' })

  await persistLessonCache(conceptId, text, model, chunkIds)
  return c.json({ ok: true })
})

// ----------------------------------------------------------------------------
// /lesson — Pro proxy. Server runs the Sonnet call on platform credit.
// ----------------------------------------------------------------------------
app.post('/lesson', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const conceptId = typeof body.concept_id === 'string' ? body.concept_id : null
  if (!conceptId) return c.json({ error: 'concept_id required' }, 400)

  const user = c.get('user')
  const ctx = await loadLessonContext(conceptId, user?.id ?? null)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status as 404)

  // Cache hit → stream the existing body in one event for protocol consistency.
  if (ctx.cached) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'chunks', data: JSON.stringify(ctx.chunks) })
      await stream.writeSSE({ event: 'cached', data: ctx.cached!.generated_at })
      await stream.writeSSE({ event: 'delta', data: ctx.cached!.body })
      await stream.writeSSE({ event: 'done', data: '' })
    })
  }

  const userContent = buildLessonUserContent(ctx)

  return streamSSE(c, async (stream) => {
    let fullText = ''
    try {
      // Send chunks up front so the client can render the citation strip
      // and resolve [[CITE:n]] tokens as they stream in.
      await stream.writeSSE({ event: 'chunks', data: JSON.stringify(ctx.chunks) })
      const response = await anthropic.messages.stream({
        model: SONNET_MODEL,
        max_tokens: 1200,
        system: LESSON_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      })

      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text
          await stream.writeSSE({ event: 'delta', data: event.delta.text })
        }
      }

      const final = await response.finalMessage()
      void recordUsage({
        userId: user?.id ?? null,
        provider: 'anthropic',
        model: SONNET_MODEL,
        endpoint: 'lesson',
        inputTokens: final.usage?.input_tokens ?? 0,
        outputTokens: final.usage?.output_tokens ?? 0,
        meta: { concept_id: conceptId },
      })

      await persistLessonCache(
        conceptId,
        fullText,
        SONNET_MODEL,
        ctx.chunks.map((c) => c.chunk_id),
      )
      await stream.writeSSE({ event: 'done', data: '' })
    } catch (err) {
      console.error('lesson stream failed:', err)
      await stream.writeSSE({ event: 'error', data: (err as Error).message })
    }
  })
})

// ----------------------------------------------------------------------------
// /lesson-chat — Pro proxy for the inline follow-up chat. Plain text stream
// (no SSE framing) — same wire shape as /chat and /source-chat in aiProxy.
//
// Body: { concept_id, walkthrough, history: [{role, content}], question }
// ----------------------------------------------------------------------------
const MAX_CHAT_HISTORY_TURNS = 12         // 6 user + 6 assistant
const MAX_CHAT_MESSAGE_BYTES = 4_000      // per turn
const MAX_CHAT_QUESTION_BYTES = 4_000
const MAX_CHAT_WALKTHROUGH_BYTES = 16_000

interface ChatTurn { role: 'user' | 'assistant'; content: string }

function validateChatHistory(raw: unknown): ChatTurn[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_CHAT_HISTORY_TURNS) return null
  const out: ChatTurn[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') return null
    const obj = m as Record<string, unknown>
    if (obj.role !== 'user' && obj.role !== 'assistant') return null
    if (typeof obj.content !== 'string' || !obj.content) return null
    if (obj.content.length > MAX_CHAT_MESSAGE_BYTES) return null
    out.push({ role: obj.role, content: obj.content })
  }
  return out
}

function buildLessonChatUserContent(
  ctx: LessonContext,
  walkthrough: string,
  question: string,
): string {
  const chunkBlock = ctx.chunks.length
    ? ctx.chunks
        .map((ch, i) => `[${i + 1}] (${ch.source_type}) ${ch.source_code}\n${ch.chunk_text}`)
        .join('\n\n---\n\n')
    : '(no chunks retrieved)'
  return `CONCEPT
Name: ${ctx.concept.name}
Description: ${ctx.concept.description}
Key facts: ${ctx.concept.key_facts.join('; ')}

WALKTHROUGH (the student is currently reading this — already cited as [[CITE:N]] using the same source numbers below)

${walkthrough}

SOURCE CHUNKS (cite as [[CITE:N]] using these numbers)

${chunkBlock}

STUDENT QUESTION
${question}`
}

app.post('/lesson-chat', async (c) => {
  const body = await c.req.json().catch(() => null) as
    | { concept_id?: unknown; walkthrough?: unknown; history?: unknown; question?: unknown }
    | null
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const conceptId = typeof body.concept_id === 'string' ? body.concept_id : null
  const walkthrough = typeof body.walkthrough === 'string' ? body.walkthrough : null
  const question = typeof body.question === 'string' ? body.question.trim() : null
  if (!conceptId || !walkthrough || !question) {
    return c.json({ error: 'concept_id, walkthrough, question required' }, 400)
  }
  if (walkthrough.length > MAX_CHAT_WALKTHROUGH_BYTES) {
    return c.json({ error: 'walkthrough too large' }, 413)
  }
  if (question.length > MAX_CHAT_QUESTION_BYTES) {
    return c.json({ error: 'question too large' }, 413)
  }

  const history = validateChatHistory(body.history ?? [])
  if (history === null) return c.json({ error: 'invalid history' }, 400)

  const user = c.get('user')
  const ctx = await loadLessonContext(conceptId, user?.id ?? null)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status as 404)

  const userContent = buildLessonChatUserContent(ctx, walkthrough, question)
  // History becomes prior turns; the current question is the latest user turn
  // and carries the full grounded user content.
  const messages: ChatTurn[] = [...history, { role: 'user', content: userContent }]

  return stream(c, async (s) => {
    let inputTokens = 0
    let outputTokens = 0
    try {
      const anthropicStream = anthropic.messages.stream({
        model: SONNET_MODEL,
        max_tokens: 1500,
        system: LESSON_CHAT_SYSTEM_PROMPT,
        messages,
      })
      for await (const event of anthropicStream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          await s.write(event.delta.text)
        }
      }
      const final = await anthropicStream.finalMessage()
      inputTokens = final.usage?.input_tokens ?? 0
      outputTokens = final.usage?.output_tokens ?? 0
    } catch (err) {
      console.error('lesson-chat stream failed:', err)
      try { await s.write('\n\n[Error: upstream failure]') } catch { /* ignore */ }
    }
    void recordUsage({
      userId: user?.id ?? null,
      provider: 'anthropic',
      model: SONNET_MODEL,
      endpoint: 'lesson-chat',
      inputTokens,
      outputTokens,
      meta: { concept_id: conceptId },
    })
  })
})

export default app
