import { Hono } from 'hono'
import OpenAI from 'openai'
import { requireAuth } from '../lib/auth.js'

const app = new Hono()

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY

const openai = new OpenAI({ apiKey: OPENAI_KEY || '' })

interface MatchedChunk {
  chunk_id: string
  lecture_id: string
  lecture_code: string
  module: string
  panopto_url: string
  start_seconds: number
  end_seconds: number
  chunk_text: string
  similarity: number
}

interface RetrievedChunk extends MatchedChunk {
  deep_link: string
  timestamp_label: string
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function buildDeepLink(panoptoUrl: string, startSeconds: number): string {
  const sep = panoptoUrl.includes('?') ? '&' : '?'
  return `${panoptoUrl}${sep}start=${startSeconds}`
}

app.use('/lecture-search', requireAuth)

app.post('/lecture-search', async (c) => {
  if (!OPENAI_KEY) return c.json({ error: 'OPENAI_API_KEY not configured' }, 500)
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return c.json({ error: 'Supabase not configured' }, 500)
  }

  const { query, module, match_count } = await c.req.json<{
    query: string
    module?: string
    match_count?: number
  }>()
  if (!query?.trim()) return c.json({ error: 'query required' }, 400)

  // Embed the query
  const emb = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query.trim(),
  })
  const embedding = emb.data[0].embedding

  // Forward the user's JWT so RLS + the security-definer RPC are happy
  const userToken = c.req.header('Authorization')!.slice('Bearer '.length)
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_lecture_chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: match_count ?? 8,
      module_filter: module ?? null,
    }),
  })

  if (!rpcRes.ok) {
    const text = await rpcRes.text()
    console.error('match_lecture_chunks failed:', rpcRes.status, text)
    return c.json({ error: 'Retrieval failed' }, 500)
  }

  const matches = (await rpcRes.json()) as MatchedChunk[]
  const chunks: RetrievedChunk[] = matches.map((m) => ({
    ...m,
    deep_link: buildDeepLink(m.panopto_url, m.start_seconds),
    timestamp_label: formatTimestamp(m.start_seconds),
  }))

  return c.json({ chunks })
})

export default app
