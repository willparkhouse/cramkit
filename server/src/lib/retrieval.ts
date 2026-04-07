import OpenAI from 'openai'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY

const openai = new OpenAI({ apiKey: OPENAI_KEY || '' })

export interface MatchedChunk {
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

/**
 * Server-internal RAG retrieval — embeds the query and calls the
 * match_source_chunks RPC. Used by the question generator to ground
 * questions in actual course material instead of hallucinating.
 *
 * Unlike the user-facing /api/source-search route, this is invoked from
 * server code (no JWT to forward), so it uses the publishable anon key
 * and bypasses RLS via the SECURITY DEFINER RPC.
 */
export async function retrieveChunks(opts: {
  query: string
  module?: string
  matchCount?: number
  sourceTypes?: string[]
}): Promise<MatchedChunk[]> {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not configured')
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Supabase env vars not configured')
  }

  const emb = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: opts.query.slice(0, 8000),
  })
  const embedding = emb.data[0].embedding

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_source_chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: opts.matchCount ?? 8,
      module_filter: opts.module ?? null,
      source_types: opts.sourceTypes ?? null,
    }),
  })

  if (!rpcRes.ok) {
    const text = await rpcRes.text()
    throw new Error(`match_source_chunks failed: ${rpcRes.status} ${text}`)
  }

  return (await rpcRes.json()) as MatchedChunk[]
}
