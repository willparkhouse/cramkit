import { Hono } from 'hono'
import { anthropic, SONNET_MODEL } from '../lib/anthropic.js'
import { requireAuth, requireAdmin } from '../lib/auth.js'
import { retrieveChunks, type MatchedChunk } from '../lib/retrieval.js'
import { recordUsage } from '../lib/usage.js'
import { rateLimit } from '../lib/rateLimit.js'

type AppEnv = { Variables: { user: { id: string; email?: string } } }
const app = new Hono<AppEnv>()

// Ingestion is admin-only — these routes burn the platform's Anthropic credits
// so we can't expose them to arbitrary signed-in users. Even with admin auth,
// rate limits apply: a compromised / phished admin token shouldn't be able
// to spam thousands of generations and burn the monthly budget in seconds.
app.use('/extract-concepts', requireAuth, requireAdmin, rateLimit({ key: 'extract-concepts', windowMs: 60_000, max: 30 }))
app.use('/deduplicate', requireAuth, requireAdmin, rateLimit({ key: 'deduplicate', windowMs: 60_000, max: 10 }))
app.use('/generate-questions', requireAuth, requireAdmin, rateLimit({ key: 'generate-questions', windowMs: 60_000, max: 30 }))

// Defence-in-depth caps to prevent a malicious admin (or compromised admin
// account) from sending an arbitrarily large payload that runs up the bill.
const MAX_NOTES_BYTES = 200 * 1024       // 200 KB per file
const MAX_DEDUP_BYTES = 500 * 1024       // 500 KB combined
const MAX_GENERATE_CONCEPTS = 20         // batch ceiling for question gen

// Retry helper with exponential backoff for rate limits
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const isRateLimit = err instanceof Error && 'status' in err && (err as { status: number }).status === 429
      if (!isRateLimit || attempt === maxRetries) throw err

      // Parse retry-after header or use exponential backoff
      const retryAfter = err instanceof Error && 'headers' in err
        ? parseInt((err as { headers: Record<string, string> }).headers?.['retry-after'] || '0')
        : 0
      const waitMs = Math.max(retryAfter * 1000, (2 ** attempt) * 2000) + Math.random() * 1000
      console.log(`Rate limited, waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${maxRetries}`)
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }
  }
  throw new Error('Unreachable')
}

// Extract concepts from notes
app.post('/extract-concepts', async (c) => {
  const { notes, module_name, module_id, exam_paper } = await c.req.json()

  if (typeof notes !== 'string' || !notes.trim()) {
    return c.json({ error: 'notes (string) required' }, 400)
  }
  if (notes.length > MAX_NOTES_BYTES) {
    return c.json({ error: `notes too large (max ${MAX_NOTES_BYTES} bytes)` }, 413)
  }
  if (typeof module_name !== 'string' || module_name.length > 200) {
    return c.json({ error: 'module_name required (max 200 chars)' }, 400)
  }

  // Estimate content size to guide concept count
  const wordCount = notes.split(/\s+/).length

  // Skip trivially short files
  if (wordCount < 150) {
    return c.json({ concepts: [] })
  }

  // Scale: ~1 concept per 300 words, with wider range for larger files
  const minConcepts = Math.max(2, Math.round(wordCount / 400))
  const maxConcepts = Math.max(minConcepts + 2, Math.round(wordCount / 150))

  const systemPrompt = `You are an expert educator extracting key concepts from university lecture notes.
Extract the key concepts from the provided notes for the module "${module_name}".
Aim for roughly ${minConcepts}-${maxConcepts} concepts, but use your judgement — extract as many as the content warrants.
A short set of notes on a single topic might only have 2-3 concepts. Dense notes covering many topics could have 20+.
Each concept should represent roughly one exam question's worth of knowledge.

Return ONLY a JSON object with this shape:
{
  "concepts": [
    {
      "name": "Concept Name",
      "description": "2-3 sentence description of what this concept covers",
      "key_facts": ["atomic fact 1", "atomic fact 2", ...],
      "difficulty": 3,
      "source_excerpt": "relevant excerpt from the notes (keep under 500 chars)"
    }
  ]
}

Guidelines:
- Each concept should have as many key facts as needed to cover it (not a fixed number — a simple concept might have 2, a complex one might have 8+)
- Difficulty is 1-5 where 1 is basic recall and 5 requires deep understanding
- Source excerpt should be the most relevant snippet for grounding chatbot answers
- Don't create concepts for administrative/logistical content, only academic material`

  let userContent = `Here are the lecture notes:\n\n${notes}`
  if (exam_paper) {
    userContent += `\n\nHere is a past exam paper for reference on depth and style:\n\n${exam_paper}`
  }

  const response = await withRetry(() => anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  }))

  const user = c.get('user')
  void recordUsage({
    userId: user?.id ?? null,
    provider: 'anthropic',
    model: SONNET_MODEL,
    endpoint: 'extract-concepts',
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    meta: { module_name, module_id },
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return c.json({ error: 'Failed to parse concepts from response' }, 500)
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return c.json(parsed)
  } catch {
    return c.json({ error: 'Invalid JSON in response' }, 500)
  }
})

// Deduplicate concepts across modules
app.post('/deduplicate', async (c) => {
  const body = await c.req.text()
  if (body.length > MAX_DEDUP_BYTES) {
    return c.json({ error: `payload too large (max ${MAX_DEDUP_BYTES} bytes)` }, 413)
  }
  const { modules } = JSON.parse(body)
  if (!Array.isArray(modules)) {
    return c.json({ error: 'modules array required' }, 400)
  }

  // Build a compact representation — skip source_excerpt to save tokens
  const compactModules = modules.map((m: { module_name: string; module_id: string; concepts: { name: string; description: string; key_facts: string[]; difficulty: number; source_excerpt: string }[] }) => ({
    module_id: m.module_id,
    module_name: m.module_name,
    concepts: m.concepts.map((concept) => ({
      name: concept.name,
      description: concept.description,
      key_facts: concept.key_facts,
      difficulty: concept.difficulty,
    })),
  }))

  // Build a lookup to restore source_excerpts after dedup
  const excerptLookup = new Map<string, string>()
  for (const m of modules) {
    for (const concept of m.concepts) {
      excerptLookup.set(`${m.module_id}:${concept.name}`, concept.source_excerpt || '')
    }
  }

  const totalConcepts = modules.reduce((sum: number, m: { concepts: unknown[] }) => sum + m.concepts.length, 0)
  console.log(`Deduplicating ${totalConcepts} concepts across ${modules.length} modules`)

  const compactData = JSON.stringify(compactModules)

  const response = await withRetry(() => anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 16384,
    system: `You are deduplicating concepts extracted from multiple university modules.
Some modules share overlapping content (especially modules that cover neural networks, machine learning, etc.).

Your task:
1. Identify duplicate or near-duplicate concepts across modules
2. Merge them into a single concept tagged with all relevant module IDs
3. Keep unique concepts as-is but tag them with their module ID

Return ONLY a JSON object (no markdown, no explanation):
{"unique_concepts":[{"name":"...","module_ids":["id1"],"description":"...","key_facts":["..."],"difficulty":3}]}

Be aggressive about merging truly overlapping content but don't merge concepts that are just tangentially related.
IMPORTANT: Your response must be valid JSON. Do not truncate the output.`,
    messages: [
      {
        role: 'user',
        content: compactData,
      },
    ],
  }))

  const dedupUser = c.get('user')
  void recordUsage({
    userId: dedupUser?.id ?? null,
    provider: 'anthropic',
    model: SONNET_MODEL,
    endpoint: 'deduplicate',
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    meta: { module_count: modules.length, total_concepts: totalConcepts },
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  console.log(`Dedup response length: ${text.length} chars, stop_reason: ${response.stop_reason}`)

  if (response.stop_reason === 'max_tokens') {
    console.warn('Dedup response was truncated by max_tokens — skipping dedup, using all concepts as-is')
    // Fallback: return all concepts without dedup, tagging each with its module
    const allConcepts = modules.flatMap((m: { module_id: string; concepts: { name: string; description: string; key_facts: string[]; difficulty: number; source_excerpt: string }[] }) =>
      m.concepts.map((concept: { name: string; description: string; key_facts: string[]; difficulty: number; source_excerpt: string }) => ({
        name: concept.name,
        module_ids: [m.module_id],
        description: concept.description,
        key_facts: concept.key_facts,
        difficulty: concept.difficulty,
        source_excerpt: concept.source_excerpt || '',
      }))
    )
    return c.json({ unique_concepts: allConcepts })
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error('Dedup response was not JSON:', text.substring(0, 500))
    return c.json({ error: 'Failed to parse dedup response' }, 500)
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])

    // Restore source_excerpts from the lookup
    if (parsed.unique_concepts) {
      for (const concept of parsed.unique_concepts) {
        if (!concept.source_excerpt) {
          // Find the best excerpt from any module this concept belongs to
          for (const moduleId of concept.module_ids) {
            const excerpt = excerptLookup.get(`${moduleId}:${concept.name}`)
            if (excerpt) {
              concept.source_excerpt = excerpt
              break
            }
          }
          // If no exact match, try partial name match
          if (!concept.source_excerpt) {
            for (const [key, value] of excerptLookup) {
              if (key.includes(concept.name) || concept.name.includes(key.split(':')[1])) {
                concept.source_excerpt = value
                break
              }
            }
          }
          concept.source_excerpt = concept.source_excerpt || ''
        }
      }
    }

    return c.json(parsed)
  } catch (e) {
    console.error('Failed to parse dedup JSON:', (e as Error).message, text.substring(0, 500))
    return c.json({ error: 'Invalid JSON in dedup response' }, 500)
  }
})

// Normalise text for substring matching: collapse whitespace, lowercase.
function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

interface GeneratedQuestion {
  type: 'mcq' | 'free_form'
  difficulty: number
  question: string
  options: string[] | null
  correct_answer: string
  explanation: string
  evidence_quote: string
}

// Generate questions for a single concept, grounded in retrieved source chunks.
async function generateForConcept(
  concept: { name: string; description: string; key_facts: string[]; difficulty: number },
  moduleSlug: string | undefined,
  userId: string | null,
  /** Existing question stems for this concept — passed to the model as a
   *  "don't repeat these angles" hint, and used as a post-hoc filter so any
   *  generated question that exactly matches an existing one is dropped. */
  existingQuestions: string[] = []
): Promise<{
  concept_name: string
  questions: (GeneratedQuestion & { source_chunk_ids: string[] })[]
  retrieved_chunk_ids: string[]
  dropped: number
}> {
  // Build a richer retrieval query than just the concept name.
  const query = `${concept.name}. ${concept.description}. ${concept.key_facts.slice(0, 5).join('. ')}`
  let chunks: MatchedChunk[] = []
  try {
    chunks = await retrieveChunks({
      query,
      module: moduleSlug,
      matchCount: 6,
      userId,
      endpoint: 'generate-questions',
    })
  } catch (e) {
    console.error(`retrieveChunks failed for "${concept.name}":`, (e as Error).message)
  }

  if (chunks.length === 0) {
    console.warn(`No source chunks for concept "${concept.name}" — skipping question generation`)
    return { concept_name: concept.name, questions: [], retrieved_chunk_ids: [], dropped: 0 }
  }

  const chunkBlock = chunks
    .map((ch, i) => `[CHUNK ${i + 1}] (source: ${ch.source_code}, ${ch.source_type})\n${ch.chunk_text}`)
    .join('\n\n---\n\n')

  const systemPrompt = `You are writing low-stakes self-test questions to help a student check their understanding of a university course concept.

You will be given:
1. A concept (name, description, key facts) extracted from the student's notes
2. A set of SOURCE CHUNKS from the actual course material (lecture slides, transcripts)

STRICT GROUNDING RULES:
- Every question MUST be directly answerable from the SOURCE CHUNKS alone.
- Do NOT use any outside knowledge, textbook facts, or details that are not present in the chunks — even if they're "standard" for the topic.
- If a key fact in the concept is NOT supported by any chunk, do not write a question about it.
- For each question, you MUST include an "evidence_quote": a literal substring (5-30 words) copied verbatim from one of the SOURCE CHUNKS that justifies the correct answer. The substring must appear character-for-character in a chunk.
- If you cannot find verbatim evidence in the chunks for a question idea, DROP that question. It is far better to return 0 questions than to invent.

QUESTION STYLE:
- Frame these as a "litmus test" — does the student understand what was actually taught? Not as exam practice, not as gotchas.
- Mix recall and light application, but stay within the level of detail in the chunks.
- Roughly 60% MCQ (exactly 4 options, one correct) and 40% free-form (with a model answer).
- For MCQ: "correct_answer" MUST be the FULL TEXT of the correct option, character-for-character identical to one of the entries in "options". Never return just a letter like "A".
- Aim for 4-8 questions total for this concept, scaled to how much material the chunks actually cover. Quality over quantity.
- Difficulty 1-5 where 1 is direct recall and 5 requires connecting multiple ideas from the chunks.

Return ONLY a JSON object (no markdown):
{
  "questions": [
    {
      "type": "mcq",
      "difficulty": 2,
      "question": "...",
      "options": ["full text of option A", "full text of option B", "full text of option C", "full text of option D"],
      "correct_answer": "full text of option A",
      "explanation": "...",
      "evidence_quote": "verbatim substring from a chunk"
    }
  ]
}`

  // When this is a top-up call (the concept already has questions), tell
  // the model exactly what's already been asked so it picks fresh angles
  // instead of regenerating slight rewordings. Skipped for first-pass gen.
  const existingBlock = existingQuestions.length > 0
    ? `\n\nEXISTING QUESTIONS (DO NOT REPEAT)\nThese questions have already been written for this concept. Write questions about DIFFERENT angles, sub-topics, or details. Do not paraphrase or reword the questions below — if you find yourself rewording one of them, drop the question instead.\n\n${existingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : ''

  const userContent = `CONCEPT
Name: ${concept.name}
Description: ${concept.description}
Key facts: ${concept.key_facts.join('; ')}

SOURCE CHUNKS

${chunkBlock}${existingBlock}`

  const response = await withRetry(() => anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  }))

  void recordUsage({
    userId,
    provider: 'anthropic',
    model: SONNET_MODEL,
    endpoint: 'generate-questions',
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    meta: { concept: concept.name, module: moduleSlug ?? null },
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.warn(`No JSON in question gen response for "${concept.name}"`)
    return { concept_name: concept.name, questions: [], retrieved_chunk_ids: chunks.map(c => c.chunk_id), dropped: 0 }
  }

  let parsed: { questions?: GeneratedQuestion[] }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    console.warn(`Invalid JSON for "${concept.name}"`)
    return { concept_name: concept.name, questions: [], retrieved_chunk_ids: chunks.map(c => c.chunk_id), dropped: 0 }
  }

  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : []

  // Validate evidence_quote actually appears in one of the chunks.
  const normalisedChunks = chunks.map(ch => ({
    id: ch.chunk_id,
    text: normaliseForMatch(ch.chunk_text),
  }))

  // Pre-normalise existing questions for cheap fuzzy comparison.
  const normalisedExisting = new Set(existingQuestions.map(normaliseForMatch))

  const validated: (GeneratedQuestion & { source_chunk_ids: string[] })[] = []
  let dropped = 0
  for (const q of rawQuestions) {
    if (!q || typeof q.evidence_quote !== 'string' || !q.evidence_quote.trim()) {
      dropped++
      continue
    }
    // Required-field guard: Claude occasionally omits correct_answer or question.
    if (typeof q.question !== 'string' || !q.question.trim()) { dropped++; continue }
    if (typeof q.correct_answer !== 'string' || !q.correct_answer.trim()) { dropped++; continue }
    if (q.type !== 'mcq' && q.type !== 'free_form') { dropped++; continue }
    if (q.type === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2)) { dropped++; continue }
    if (q.type === 'mcq' && !q.options!.includes(q.correct_answer)) { dropped++; continue }
    const needle = normaliseForMatch(q.evidence_quote)
    if (needle.length < 10) {
      dropped++
      continue
    }
    const matchingChunkIds = normalisedChunks
      .filter(ch => ch.text.includes(needle))
      .map(ch => ch.id)
    if (matchingChunkIds.length === 0) {
      dropped++
      continue
    }
    // Belt-and-braces: drop any question whose normalised stem matches an
    // existing one verbatim. The semantic dedup script catches the more
    // subtle near-dupes; this just kills the obvious copies.
    if (normalisedExisting.has(normaliseForMatch(q.question))) {
      dropped++
      continue
    }
    validated.push({
      ...q,
      // Order: matching chunks first, then the rest of the retrieved set as supporting context.
      source_chunk_ids: [
        ...matchingChunkIds,
        ...chunks.map(c => c.chunk_id).filter(id => !matchingChunkIds.includes(id)),
      ],
    })
  }

  if (dropped > 0) {
    console.log(`Concept "${concept.name}": kept ${validated.length}, dropped ${dropped} for missing/invalid evidence`)
  }

  return {
    concept_name: concept.name,
    questions: validated,
    retrieved_chunk_ids: chunks.map(c => c.chunk_id),
    dropped,
  }
}

// Generate questions for concepts (per-concept RAG-grounded)
app.post('/generate-questions', async (c) => {
  const { concepts, module_name, module } = await c.req.json() as {
    concepts: {
      name: string
      description: string
      key_facts: string[]
      difficulty: number
      /** Optional: existing question stems for this concept. When present,
       *  the generator is told not to repeat them and any literal rewording
       *  is dropped post-hoc. Used by the "Top up sparse" admin action. */
      existing_questions?: string[]
    }[]
    module_name?: string
    module?: string
  }
  if (!Array.isArray(concepts)) {
    return c.json({ error: 'concepts array required' }, 400)
  }
  if (concepts.length > MAX_GENERATE_CONCEPTS) {
    return c.json({ error: `too many concepts in one batch (max ${MAX_GENERATE_CONCEPTS})` }, 413)
  }

  const genUser = c.get('user')
  const userId = genUser?.id ?? null

  // Run with limited concurrency to avoid hammering OpenAI + Anthropic + Supabase.
  const CONCURRENCY = 3
  const results: Awaited<ReturnType<typeof generateForConcept>>[] = []
  for (let i = 0; i < concepts.length; i += CONCURRENCY) {
    const batch = concepts.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((co) => generateForConcept(co, module, userId, co.existing_questions ?? []))
    )
    results.push(...batchResults)
  }

  // Reshape to match the existing client contract: { questions: [{ concept_name, questions: [...] }] }
  const out = results.map(r => ({
    concept_name: r.concept_name,
    questions: r.questions,
  }))

  const totalKept = results.reduce((s, r) => s + r.questions.length, 0)
  const totalDropped = results.reduce((s, r) => s + r.dropped, 0)
  console.log(`generate-questions[${module_name ?? module ?? '?'}]: ${totalKept} kept, ${totalDropped} dropped across ${concepts.length} concepts`)

  return c.json({ questions: out })
})

export default app
