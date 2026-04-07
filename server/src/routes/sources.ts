import { Hono } from 'hono'
import OpenAI from 'openai'
import { requireAuth } from '../lib/auth.js'
import { rateLimit } from '../lib/rateLimit.js'

const app = new Hono()

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY

const openai = new OpenAI({ apiKey: OPENAI_KEY || '' })

const MAX_QUERY_LENGTH = 1000      // chars
const MAX_MATCH_COUNT = 20         // ceiling on chunks returned

interface MatchedChunk {
  chunk_id: string
  source_id: string
  source_code: string
  source_type: string
  module: string
  url: string
  locator: Record<string, unknown>
  chunk_text: string
  similarity: number
}

interface RetrievedChunk extends MatchedChunk {
  deep_link: string
  position_label: string
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Builds a deep-link + a human label for a chunk based on its source type.
 * Lectures get Panopto ?start=N; slides get PDF #page=N.
 */
function decorateChunk(m: MatchedChunk): RetrievedChunk {
  if (m.source_type === 'lecture') {
    const start = Number(m.locator.start_seconds || 0)
    const sep = m.url.includes('?') ? '&' : '?'
    return {
      ...m,
      deep_link: `${m.url}${sep}start=${start}`,
      position_label: formatTimestamp(start),
    }
  }
  if (m.source_type === 'slides') {
    const startPage = Number(m.locator.start_page || 1)
    const endPage = Number(m.locator.end_page || startPage)
    return {
      ...m,
      deep_link: `${m.url}#page=${startPage}`,
      position_label: startPage === endPage ? `slide ${startPage}` : `slides ${startPage}–${endPage}`,
    }
  }
  // Fallback for future source types — link to the source itself, no position
  return {
    ...m,
    deep_link: m.url,
    position_label: '',
  }
}

// Auth + rate limit: any signed-in user can search sources, but capped to
// 30 requests per minute per user to prevent OpenAI embedding cost abuse.
app.use(
  '/source-search',
  requireAuth,
  rateLimit({ key: 'source-search', windowMs: 60_000, max: 30 })
)

app.post('/source-search', async (c) => {
  if (!OPENAI_KEY) return c.json({ error: 'OPENAI_API_KEY not configured' }, 500)
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return c.json({ error: 'Supabase not configured' }, 500)
  }

  const { query, module, match_count, source_types } = await c.req.json<{
    query: string
    module?: string
    match_count?: number
    source_types?: string[]
  }>()
  if (typeof query !== 'string' || !query.trim()) {
    return c.json({ error: 'query required' }, 400)
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return c.json({ error: `query too long (max ${MAX_QUERY_LENGTH} chars)` }, 413)
  }
  if (module !== undefined && (typeof module !== 'string' || module.length > 100)) {
    return c.json({ error: 'invalid module filter' }, 400)
  }
  if (
    source_types !== undefined &&
    (!Array.isArray(source_types) || source_types.some((s) => typeof s !== 'string'))
  ) {
    return c.json({ error: 'invalid source_types filter' }, 400)
  }
  const safeMatchCount = Math.min(
    Math.max(typeof match_count === 'number' ? match_count : 8, 1),
    MAX_MATCH_COUNT
  )

  // Embed the query
  const emb = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query.trim(),
  })
  const embedding = emb.data[0].embedding

  // Forward the user's JWT so RLS + the security-definer RPC are happy
  const userToken = c.req.header('Authorization')!.slice('Bearer '.length)
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_source_chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: safeMatchCount,
      module_filter: module ?? null,
      source_types: source_types ?? null,
    }),
  })

  if (!rpcRes.ok) {
    const text = await rpcRes.text()
    console.error('match_source_chunks failed:', rpcRes.status, text)
    return c.json({ error: 'Retrieval failed' }, 500)
  }

  const matches = (await rpcRes.json()) as MatchedChunk[]
  const chunks: RetrievedChunk[] = matches.map(decorateChunk)

  return c.json({ chunks })
})

export default app
