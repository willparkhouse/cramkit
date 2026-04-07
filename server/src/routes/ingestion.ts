import { Hono } from 'hono'
import { anthropic, SONNET_MODEL } from '../lib/anthropic.js'
import { requireAuth, requireAdmin } from '../lib/auth.js'

const app = new Hono()

// Ingestion is admin-only — these routes burn the platform's Anthropic credits
// so we can't expose them to arbitrary signed-in users.
app.use('/extract-concepts', requireAuth, requireAdmin)
app.use('/deduplicate', requireAuth, requireAdmin)
app.use('/generate-questions', requireAuth, requireAdmin)

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

// Generate questions for concepts
app.post('/generate-questions', async (c) => {
  const { concepts, exam_paper_excerpt, module_name } = await c.req.json()
  if (!Array.isArray(concepts)) {
    return c.json({ error: 'concepts array required' }, 400)
  }
  if (concepts.length > MAX_GENERATE_CONCEPTS) {
    return c.json({ error: `too many concepts in one batch (max ${MAX_GENERATE_CONCEPTS})` }, 413)
  }

  let systemPrompt = `You are generating quiz questions for university exam revision.
For each concept, generate an appropriate number of questions based on its complexity:
- Concepts with few key facts (1-3): generate 2-3 questions
- Concepts with moderate key facts (4-6): generate 4-6 questions
- Concepts with many key facts (7+): generate 7-10 questions
- Higher difficulty concepts should get more questions, especially at varying difficulty levels

Mix approximately 60% multiple choice (MCQ) and 40% free-form questions.
For MCQ questions, provide exactly 4 options where only one is correct.
For free-form questions, provide a model answer.
Vary question difficulty — include some easy recall AND some that require deeper understanding or application.`

  if (exam_paper_excerpt) {
    systemPrompt += `\n\nHere's an example of the exam style to match:\n${exam_paper_excerpt}`
  }

  systemPrompt += `\n\nReturn ONLY a JSON object:
{
  "questions": [
    {
      "concept_name": "Concept Name",
      "questions": [
        {
          "type": "mcq",
          "difficulty": 2,
          "question": "What is...?",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correct_answer": "Option A",
          "explanation": "Brief explanation of why this is correct"
        },
        {
          "type": "free_form",
          "difficulty": 4,
          "question": "Explain how...",
          "options": null,
          "correct_answer": "Model answer text",
          "explanation": "Key points that a good answer should cover"
        }
      ]
    }
  ]
}`

  const conceptsText = concepts
    .map(
      (c: { name: string; description: string; key_facts: string[]; difficulty: number }) =>
        `Concept: ${c.name}\nDescription: ${c.description}\nKey Facts (${c.key_facts.length}): ${c.key_facts.join('; ')}\nDifficulty: ${c.difficulty}`
    )
    .join('\n\n')

  const response = await withRetry(() => anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Generate questions for these concepts from ${module_name}:\n\n${conceptsText}`,
      },
    ],
  }))

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return c.json({ error: 'Failed to parse questions response' }, 500)
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return c.json(parsed)
  } catch {
    return c.json({ error: 'Invalid JSON in questions response' }, 500)
  }
})

export default app
