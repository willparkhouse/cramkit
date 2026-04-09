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
import { streamSSE } from 'hono/streaming'
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
  rateLimit({ key: 'lesson', windowMs: 60_000, max: 30 })
)

app.use(
  '/lesson/context/*',
  requireAuth,
  rateLimit({ key: 'lesson-context', windowMs: 60_000, max: 60 })
)

app.use(
  '/lesson/cache',
  requireAuth,
  rateLimit({ key: 'lesson-cache', windowMs: 60_000, max: 30 })
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
- A set of SOURCE CHUNKS retrieved from the actual lectures and slides

Rules:
- Stay grounded in the source chunks. Don't invent examples or details that aren't there.
- Use the lecturer's exact phrasing and notation when the chunks have it. Students recognise their own course's terminology.
- Plain prose. No headings, no bullet points. Treat this like a textbook section, not a slide deck.
- For maths, use LaTeX in dollar signs: $x^2$ inline or $$\\sum_i x_i$$ on its own line for display.
- Aim for ~250-400 words. Long enough to actually teach, short enough to read in 2 minutes.
- Don't restate the concept name as a heading at the top. Start straight into prose.
- Don't add a "summary" or "in summary" closing line. The last paragraph IS the summary.

If the source chunks are sparse or off-topic, write what you can from the description and key facts and end with: "(This walkthrough uses limited source material — refer back to the lecture for the full treatment.)"`

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
}

// ----------------------------------------------------------------------------
// Shared lookup: returns cached body (if any) plus the concept and chunks.
// Used by /lesson (Pro proxy) and /lesson/context/:id (BYOK).
// ----------------------------------------------------------------------------
interface LessonContext {
  concept: { id: string; name: string; description: string; key_facts: string[] }
  chunks: Array<{ source_code: string; source_type: string; chunk_text: string }>
  cached: { body: string; generated_at: string } | null
}

async function loadLessonContext(
  conceptId: string,
  userId: string | null,
): Promise<LessonContext | { error: string; status: number }> {
  const sb = getServiceClient()

  const { data: cached, error: cacheErr } = await sb
    .from('lesson_explanations')
    .select('concept_id, body, model, generated_at')
    .eq('concept_id', conceptId)
    .maybeSingle<CacheRow>()
  if (cacheErr) console.error('lesson cache lookup failed:', cacheErr.message)

  const { data: concept, error: conceptErr } = await sb
    .from('concepts')
    .select('id, name, description, key_facts, module_ids')
    .eq('id', conceptId)
    .single<ConceptRow>()
  if (conceptErr || !concept) return { error: 'concept not found', status: 404 }

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
  const chunks: LessonContext['chunks'] = []
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
        source_code: ch.source_code,
        source_type: ch.source_type,
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
        .map((ch, i) => `[CHUNK ${i + 1}] (${ch.source_code}, ${ch.source_type})\n${ch.chunk_text}`)
        .join('\n\n---\n\n')
    : '(no chunks retrieved)'
  return `CONCEPT
Name: ${ctx.concept.name}
Description: ${ctx.concept.description}
Key facts: ${ctx.concept.key_facts.join('; ')}

SOURCE CHUNKS

${chunkBlock}`
}

async function persistLessonCache(conceptId: string, body: string, model: string): Promise<void> {
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

  await persistLessonCache(conceptId, text, model)
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
      await stream.writeSSE({ event: 'cached', data: ctx.cached!.generated_at })
      await stream.writeSSE({ event: 'delta', data: ctx.cached!.body })
      await stream.writeSSE({ event: 'done', data: '' })
    })
  }

  const userContent = buildLessonUserContent(ctx)

  return streamSSE(c, async (stream) => {
    let fullText = ''
    try {
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

      await persistLessonCache(conceptId, fullText, SONNET_MODEL)
      await stream.writeSSE({ event: 'done', data: '' })
    } catch (err) {
      console.error('lesson stream failed:', err)
      await stream.writeSSE({ event: 'error', data: (err as Error).message })
    }
  })
})

export default app
