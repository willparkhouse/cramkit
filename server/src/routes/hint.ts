/**
 * POST /api/question-hint
 *
 * Streams a context-grounded "what's this question even asking" explanation
 * for a quiz question, without revealing the answer. The intended UX is a
 * "More context" button on the question card while it's still unanswered —
 * the student presses it when the question assumes terminology or concepts
 * they don't immediately recall.
 *
 * Inputs (JSON body):
 *   question_id      uuid of the question
 *
 * The route looks up the question + concept + retrieves the top source
 * chunks for grounding, then streams a single Sonnet response.
 *
 * Server credits, not BYOK. Rate limited per user to avoid runaway use.
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

// /question-hint is the Pro proxy path: server makes the Sonnet call on
// the platform's credit. requirePro gates this route — free + BYOK users
// hit /question-hint/context instead, build the prompt in the browser,
// and call Anthropic with their own key.
//
// 10 hints per minute per user — one every 6s, well above how fast a stuck
// student would actually click the hint button.
app.use(
  '/question-hint',
  requireAuth,
  requirePro,
  rateLimit({ key: 'question-hint', windowMs: 60_000, max: 10 })
)

// /question-hint/context is the auth-only retrieval endpoint that BYOK
// users hit to get the question + concept + grounded chunks back, then
// call Anthropic from the browser themselves. No Anthropic call here.
app.use(
  '/question-hint/context',
  requireAuth,
  rateLimit({ key: 'question-hint-context', windowMs: 60_000, max: 15 })
)

function getServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  return createClient(url, key, { auth: { persistSession: false } })
}

// ----------------------------------------------------------------------------
// Two-tier hint prompts.
//
// Tier 1 (terse) is the default click. ONE sentence orientation, no fluff.
// Tier 2 (more) is the user clicking "Tell me more" — 2-4 sentences elaborating.
//
// CRITICAL design point: the model SEES the options including the correct
// answer. This is counterintuitive but necessary. If the model doesn't see
// the options, it can't tell whether its orientation accidentally walks the
// student straight to the right one. We explicitly tell it: "your hint must
// not give a student enough information to pick the right option from these."
// The model uses the options as a no-go list, not as raw material.
// ----------------------------------------------------------------------------
const HINT_RULES_COMMON = `You will be given:
- The QUESTION the student is looking at
- The full set of OPTIONS for that question, INCLUDING which one is correct
- The CONCEPT name and description from their lecture material
- Source CHUNKS retrieved from the actual lectures and slides

Why you're given the correct answer: so you can avoid revealing it. The options are a NO-GO LIST. Your hint must be vague enough that a student reading it could not confidently pick the correct option from the four (or rule out enough wrong ones to do so).

Use this self-test before responding: "If a student read my hint and then looked at these four options for the first time, would they be able to figure out which one is right?" If yes, your hint is too informative — make it more general, more abstract, or talk about a different aspect of the concept.

CRITICAL — what you must NOT do:
- Do NOT state the correct answer.
- Do NOT use any of the distinctive vocabulary that appears in the correct answer (e.g. if the correct answer is "they are population based", do NOT say "population" in your hint).
- Do NOT describe the unique property that makes the correct answer correct.
- Do NOT construct your hint as process of elimination ("it's not X, so it must be Y").
- Do NOT explain why an answer is correct — that's a different feature.
- Do NOT use bullet points or headings.
- Do NOT reference the options at all in your output. The student doesn't know you've seen them.

Stay grounded in the source chunks. For maths, use LaTeX in dollar signs ($x^2$ inline, $$\\sum_i x_i$$ on its own line for display).

If you genuinely cannot say anything useful without giving the answer away, output exactly: "This is essentially a recall question — try to remember what the lecturer said about [topic]." Filling in [topic] with the broadest framing you can.`

const HINT_TERSE_PROMPT = `You are giving a university student a single short hint about what a quiz question is asking. They've pressed a "More context" button because they don't immediately recall the topic.

Your output: ONE concise sentence that names the broader topic the question sits inside. Be deliberately vague about which aspect of that topic the question is testing.

${HINT_RULES_COMMON}

Examples of the right shape:
- "This question is about how loss functions are chosen for classification problems."
- "This question is about properties of n-gram language models."
- "This question is about characteristics that distinguish evolutionary algorithms from other search methods."

Notice these say WHAT the topic is but NOT which property/characteristic/aspect is being asked about. That's the level of vagueness you're aiming for.

One sentence. No more.`

const HINT_DETAILED_PROMPT = `You are EXPANDING on a hint a university student has already seen. They pressed "Tell me more" because the first sentence wasn't enough.

You will be given the PRIOR HINT they're already looking at. Your output is a CONTINUATION that will be appended directly after it on screen — the student will see them as one paragraph. So:
- Do NOT repeat what the prior hint already said.
- Do NOT start with "This question is..." or any other restatement.
- Start with a connecting word/phrase that flows from the prior hint ("Specifically,", "More precisely,", "In particular,", "The key vocabulary here is..." — pick whatever fits).
- Output 1-3 additional sentences. The combined hint (prior + your continuation) should still feel tight.

You can be slightly more specific than the prior hint was — define vocabulary the student might not recall, point at the relevant section of the lecture material, name the sub-topic. But all the no-go rules below still apply absolutely.

${HINT_RULES_COMMON}

The student should still need to recall the actual answer themselves — your continuation just adds scaffolding.`

interface QuestionRow {
  id: string
  question: string
  type: string
  options: string[] | null
  correct_answer: string
  concept_id: string
}

interface ConceptRow {
  id: string
  name: string
  description: string
  key_facts: string[] | null
  module_ids: string[]
}

// ----------------------------------------------------------------------------
// Shared lookup: load the question, concept, retrieved chunks, and resolve
// the module slug. Used by both the Pro proxy route and the BYOK context
// endpoint so the prompt construction stays in one place.
// ----------------------------------------------------------------------------
interface HintContext {
  question: { id: string; text: string; type: string; options: string[] | null; correct_answer: string }
  concept: { id: string; name: string; description: string; key_facts: string[] }
  chunks: Array<{ source_code: string; source_type: string; chunk_text: string }>
}

async function loadHintContext(
  questionId: string,
  userId: string | null,
): Promise<HintContext | { error: string; status: number }> {
  const sb = getServiceClient()

  const { data: question, error: qErr } = await sb
    .from('questions')
    .select('id, question, type, options, correct_answer, concept_id')
    .eq('id', questionId)
    .single<QuestionRow>()
  if (qErr || !question) return { error: 'question not found', status: 404 }

  const { data: concept, error: cErr } = await sb
    .from('concepts')
    .select('id, name, description, key_facts, module_ids')
    .eq('id', question.concept_id)
    .single<ConceptRow>()
  if (cErr || !concept) return { error: 'concept not found', status: 404 }

  let moduleSlug: string | undefined
  if (concept.module_ids && concept.module_ids[0]) {
    const { data: exam } = await sb
      .from('exams')
      .select('slug')
      .eq('id', concept.module_ids[0])
      .single()
    moduleSlug = (exam?.slug as string | undefined) ?? undefined
  }

  const query = `${concept.name}. ${concept.description}. ${(concept.key_facts ?? []).slice(0, 3).join('. ')}`
  const chunks: HintContext['chunks'] = []
  try {
    const retrieved = await retrieveChunks({
      query,
      module: moduleSlug,
      matchCount: 5,
      userId,
      endpoint: 'question-hint',
    })
    for (const ch of retrieved) {
      chunks.push({
        source_code: ch.source_code,
        source_type: ch.source_type,
        chunk_text: ch.chunk_text,
      })
    }
  } catch (e) {
    console.warn(`question-hint retrieval failed for ${questionId}:`, (e as Error).message)
  }

  return {
    question: {
      id: question.id,
      text: question.question,
      type: question.type,
      options: question.options,
      correct_answer: question.correct_answer,
    },
    concept: {
      id: concept.id,
      name: concept.name,
      description: concept.description,
      key_facts: concept.key_facts ?? [],
    },
    chunks,
  }
}

// ----------------------------------------------------------------------------
// /question-hint/context — auth-only retrieval used by BYOK clients. Returns
// everything the browser needs to build the prompt and call Anthropic
// directly with the user's own key. No Anthropic call here.
// ----------------------------------------------------------------------------
app.post('/question-hint/context', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const questionId = typeof body.question_id === 'string' ? body.question_id : null
  if (!questionId) return c.json({ error: 'question_id required' }, 400)
  const user = c.get('user')
  const result = await loadHintContext(questionId, user?.id ?? null)
  if ('error' in result) return c.json({ error: result.error }, result.status as 404)
  return c.json(result)
})

// ----------------------------------------------------------------------------
// /question-hint — Pro proxy. Server makes the Sonnet call on platform credit.
// ----------------------------------------------------------------------------
app.post('/question-hint', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const questionId = typeof body.question_id === 'string' ? body.question_id : null
  // 'terse' (default) — one-sentence orientation. 'detailed' — continuation.
  const level: 'terse' | 'detailed' = body.level === 'detailed' ? 'detailed' : 'terse'
  // For detailed mode, the previous (terse) hint text the student already
  // sees on screen. The continuation must NOT repeat it.
  const previous = typeof body.previous === 'string' ? body.previous : ''
  if (!questionId) return c.json({ error: 'question_id required' }, 400)

  const user = c.get('user')
  const ctx = await loadHintContext(questionId, user?.id ?? null)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status as 404)

  const userContent = buildHintUserContent(ctx, level, previous)
  const systemPrompt = level === 'detailed' ? HINT_DETAILED_PROMPT : HINT_TERSE_PROMPT
  const maxTokens = level === 'detailed' ? 500 : 200

  return streamSSE(c, async (stream) => {
    try {
      const response = await anthropic.messages.stream({
        model: SONNET_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      })

      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          await stream.writeSSE({ event: 'delta', data: event.delta.text })
        }
      }

      const final = await response.finalMessage()
      void recordUsage({
        userId: user?.id ?? null,
        provider: 'anthropic',
        model: SONNET_MODEL,
        endpoint: 'question-hint',
        inputTokens: final.usage?.input_tokens ?? 0,
        outputTokens: final.usage?.output_tokens ?? 0,
        meta: { question_id: questionId, concept_id: ctx.concept.id, level },
      })

      await stream.writeSSE({ event: 'done', data: '' })
    } catch (err) {
      console.error('question-hint stream failed:', err)
      await stream.writeSSE({ event: 'error', data: (err as Error).message })
    }
  })
})

// ----------------------------------------------------------------------------
// Builds the user-facing prompt content from a hint context. The BYOK client
// path duplicates this logic in the browser (so the prompt is built locally
// and the user's key isn't shipped to our server). Update both sites if you
// change the format.
// ----------------------------------------------------------------------------
function buildHintUserContent(
  ctx: HintContext,
  _level: 'terse' | 'detailed',
  previous: string,
): string {
  const optionsBlock =
    ctx.question.type === 'mcq' && Array.isArray(ctx.question.options) && ctx.question.options.length > 0
      ? `OPTIONS (the student can see these — the model uses them as a NO-GO list):
${ctx.question.options
  .map((o) => {
    const isCorrect =
      o.trim().toLowerCase() === ctx.question.correct_answer.trim().toLowerCase()
    return `  ${isCorrect ? '✓ CORRECT' : '✗ wrong  '}  ${o}`
  })
  .join('\n')}`
      : `CORRECT ANSWER (the student must NOT be walked to this — use as a NO-GO list):
${ctx.question.correct_answer}`

  const chunkBlock = ctx.chunks.length
    ? ctx.chunks
        .map((ch, i) => `[CHUNK ${i + 1}] (${ch.source_code}, ${ch.source_type})\n${ch.chunk_text}`)
        .join('\n\n---\n\n')
    : '(no chunks retrieved)'

  const previousBlock = previous.trim()
    ? `\n\nPRIOR HINT (already on screen — do NOT repeat, write a continuation that flows from this):
${previous.trim()}`
    : ''

  return `QUESTION
${ctx.question.text}

${optionsBlock}

CONCEPT
Name: ${ctx.concept.name}
Description: ${ctx.concept.description}
Key facts: ${ctx.concept.key_facts.join('; ')}

SOURCE CHUNKS

${chunkBlock}${previousBlock}`
}

export default app
