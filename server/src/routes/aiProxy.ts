/**
 * Pro AI proxy routes — server-side equivalents of the browser-direct
 * Anthropic calls in client/src/lib/api.ts. Pro users hit these instead of
 * needing their own API key. Free users keep going browser-direct.
 *
 * Streaming endpoints write plain UTF-8 text chunks (no SSE framing) so the
 * client can read them with a fetch() ReadableStream reader and call the
 * existing onChunk() callback unchanged.
 */
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { anthropic, SONNET_MODEL } from '../lib/anthropic.js'
import { requireAuth } from '../lib/auth.js'
import { requirePro } from '../lib/entitlement.js'
import { recordUsage } from '../lib/usage.js'
import { rateLimit } from '../lib/rateLimit.js'

type AppEnv = { Variables: { user: { id: string; email?: string } } }
const app = new Hono<AppEnv>()

// Mirror of client FORMATTING_RULES — kept here so the system prompt can't
// be injected by clients. Update both sites if you tweak it.
const FORMATTING_RULES = `Formatting rules — your output is rendered through a markdown renderer with KaTeX math and GFM tables, so:
- Wrap inline math in single dollar signs: $x^2 + y^2$. Wrap display math in double dollar signs on their own line: $$\\frac{1}{n} \\sum_i x_i$$.
- NEVER put math inside backticks or code fences. Backticks are for actual code only.
- For variables, equations, Greek letters, vectors, subscripts, superscripts, fractions, sums, integrals, etc — always use LaTeX in dollar signs.
- Use proper markdown tables (with pipes) for tabular comparisons. Don't try to align columns with spaces.
- Keep responses tight: short paragraphs, lists where appropriate, avoid horizontal rules unless genuinely separating sections.`

// Hard payload caps so a malicious client can't burn the platform's quota.
const MAX_MESSAGES = 40
const MAX_MESSAGE_BYTES = 16_000        // per message content
const MAX_CONTEXT_BYTES = 32_000        // concept context / chunks block
const MAX_BODY_BYTES = 200_000          // total request body cap (defence in depth)

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface SourceChunkPayload {
  source_code: string
  source_type: string
  position_label: string
  chunk_text: string
}

function validateMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') return null
    const obj = m as Record<string, unknown>
    if (obj.role !== 'user' && obj.role !== 'assistant') return null
    if (typeof obj.content !== 'string' || !obj.content) return null
    if (obj.content.length > MAX_MESSAGE_BYTES) return null
    out.push({ role: obj.role, content: obj.content })
  }
  return out
}

// Rate limits are per-user and apply to ALL three Pro proxy endpoints. The
// streaming endpoints (chat / source-chat) are the most expensive — a 20/min
// cap means even if a user holds the throttle wide open, the worst-case
// monthly burn is bounded to roughly 20 × 60 × 24 × 30 = ~860k requests, of
// which only a fraction will hit the model (most will be empty/short).
app.use('/chat', requireAuth, requirePro, rateLimit({ key: 'proxy-chat', windowMs: 60_000, max: 20 }))
app.use('/source-chat', requireAuth, requirePro, rateLimit({ key: 'proxy-source-chat', windowMs: 60_000, max: 20 }))
app.use('/evaluate', requireAuth, requirePro, rateLimit({ key: 'proxy-evaluate', windowMs: 60_000, max: 60 }))

/**
 * Reject obviously oversized request bodies before parsing them. Hono parses
 * the body lazily on c.req.json(), so checking Content-Length up front is the
 * cheapest way to reject a multi-MB DoS attempt without buffering it.
 */
function bodyTooLarge(c: { req: { header: (k: string) => string | undefined } }): boolean {
  const len = parseInt(c.req.header('content-length') || '0', 10)
  return Number.isFinite(len) && len > MAX_BODY_BYTES
}

// ---------- /api/chat (concept-context fallback chat) ----------
app.post('/chat', async (c) => {
  if (bodyTooLarge(c)) return c.json({ error: 'request too large' }, 413)
  const body = await c.req.json().catch(() => null) as { messages?: unknown; context?: unknown } | null
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const messages = validateMessages(body.messages)
  if (!messages) return c.json({ error: 'invalid messages' }, 400)

  const context = typeof body.context === 'string' ? body.context : ''
  if (context.length > MAX_CONTEXT_BYTES) return c.json({ error: 'context too large' }, 413)

  const systemPrompt = `You are a helpful tutor helping a student revise for their university exams.
You are currently helping them learn about a specific concept. Use the context below to ground your answers
in the actual course material. Be concise, clear, and focused on helping them understand.

${FORMATTING_RULES}

Context from course notes:
${context}`

  const user = c.get('user')
  return stream(c, async (s) => {
    let inputTokens = 0
    let outputTokens = 0
    try {
      const anthropicStream = anthropic.messages.stream({
        model: SONNET_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
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
      console.error('proxy /chat failed:', err)
      try { await s.write('\n\n[Error: upstream failure]') } catch { /* ignore */ }
    }
    void recordUsage({
      userId: user?.id ?? null,
      provider: 'anthropic',
      model: SONNET_MODEL,
      endpoint: 'proxy-chat',
      inputTokens,
      outputTokens,
    })
  })
})

// ---------- /api/source-chat (RAG-grounded chat with citations) ----------
app.post('/source-chat', async (c) => {
  if (bodyTooLarge(c)) return c.json({ error: 'request too large' }, 413)
  const body = await c.req.json().catch(() => null) as { messages?: unknown; chunks?: unknown } | null
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const messages = validateMessages(body.messages)
  if (!messages) return c.json({ error: 'invalid messages' }, 400)

  if (!Array.isArray(body.chunks)) return c.json({ error: 'chunks required' }, 400)
  const chunks: SourceChunkPayload[] = []
  for (const ch of body.chunks) {
    if (!ch || typeof ch !== 'object') continue
    const obj = ch as Record<string, unknown>
    chunks.push({
      source_code: typeof obj.source_code === 'string' ? obj.source_code : '',
      source_type: typeof obj.source_type === 'string' ? obj.source_type : '',
      position_label: typeof obj.position_label === 'string' ? obj.position_label : '',
      chunk_text: typeof obj.chunk_text === 'string' ? obj.chunk_text : '',
    })
  }
  if (chunks.length === 0 || chunks.length > 30) return c.json({ error: 'invalid chunks' }, 400)

  const sourcesBlock = chunks
    .map((ch, i) => `[${i + 1}] (${ch.source_type}) ${ch.source_code} ${ch.position_label}\n${ch.chunk_text}`)
    .join('\n\n')

  if (sourcesBlock.length > MAX_CONTEXT_BYTES * 2) return c.json({ error: 'chunks too large' }, 413)

  const systemPrompt = `You are a tutor helping a student revise. You have access to retrieved excerpts from their course materials — both lecture transcripts and slide decks — listed below as numbered sources.

Ground your answers in these excerpts. When you reference something specific, cite it inline using the exact form [[CITE:N]] where N is the source number. You may cite multiple sources. Only cite sources that actually appear below — never invent citations.

If the sources don't contain enough to answer, say so honestly rather than guessing.

${FORMATTING_RULES}

Sources:
${sourcesBlock}`

  const user = c.get('user')
  return stream(c, async (s) => {
    let inputTokens = 0
    let outputTokens = 0
    try {
      const anthropicStream = anthropic.messages.stream({
        model: SONNET_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
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
      console.error('proxy /source-chat failed:', err)
      try { await s.write('\n\n[Error: upstream failure]') } catch { /* ignore */ }
    }
    void recordUsage({
      userId: user?.id ?? null,
      provider: 'anthropic',
      model: SONNET_MODEL,
      endpoint: 'proxy-source-chat',
      inputTokens,
      outputTokens,
      meta: { chunks: chunks.length },
    })
  })
})

// ---------- /api/evaluate (free-form answer eval — non-streaming) ----------
app.post('/evaluate', async (c) => {
  if (bodyTooLarge(c)) return c.json({ error: 'request too large' }, 413)
  const body = await c.req.json().catch(() => null) as
    | { question?: unknown; correct_answer?: unknown; student_answer?: unknown }
    | null
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const question = typeof body.question === 'string' ? body.question : ''
  const correct = typeof body.correct_answer === 'string' ? body.correct_answer : ''
  const student = typeof body.student_answer === 'string' ? body.student_answer : ''
  if (!question || !correct || !student) return c.json({ error: 'fields required' }, 400)
  if (question.length + correct.length + student.length > MAX_CONTEXT_BYTES) {
    return c.json({ error: 'payload too large' }, 413)
  }

  const systemPrompt = `You are evaluating a university student's exam answer for them, in real time.

Speak DIRECTLY to the student in second person ("you", "your answer") — never refer to them as "the student" or in third person. Be warm but honest, like a tutor giving quick feedback.

Be generous with partial credit: if the student demonstrates partial understanding of the key idea, mark partial_credit true. If they got the gist right even with imperfect wording, mark correct true.

Return ONLY a JSON object with this exact shape (no markdown, no code fences):
{ "correct": boolean, "partial_credit": boolean, "feedback": "1-2 sentences addressing the student directly" }`

  try {
    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Question: ${question}\nCorrect answer: ${correct}\nMy answer: ${student}`,
        },
      ],
    })

    const user = c.get('user')
    void recordUsage({
      userId: user?.id ?? null,
      provider: 'anthropic',
      model: SONNET_MODEL,
      endpoint: 'proxy-evaluate',
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return c.json({ correct: false, partial_credit: false, feedback: 'Could not evaluate answer.' })
    try {
      return c.json(JSON.parse(match[0]))
    } catch {
      return c.json({ correct: false, partial_credit: false, feedback: 'Could not evaluate answer.' })
    }
  } catch (err) {
    console.error('proxy /evaluate failed:', err)
    return c.json({ error: 'evaluation failed' }, 500)
  }
})

export default app
