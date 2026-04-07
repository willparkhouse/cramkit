/**
 * LLM usage tracking. Records one row per provider call into public.llm_usage
 * via the Supabase service role. Cost is estimated from a static price table —
 * update PRICES below when providers change pricing.
 *
 * Failures here must NEVER break the user-facing request, so all calls are
 * fire-and-forget and errors are logged but swallowed.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// USD per 1M tokens. Keep in sync with provider pricing pages.
const PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  // OpenAI embeddings (output tokens are 0)
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model]
  if (!p) return 0
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

let cachedClient: SupabaseClient | null = null
function getServiceClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  cachedClient = createClient(url, key, { auth: { persistSession: false } })
  return cachedClient
}

export interface UsageRecord {
  userId: string | null
  provider: 'openai' | 'anthropic'
  model: string
  endpoint: string
  inputTokens: number
  outputTokens: number
  meta?: Record<string, unknown>
}

/**
 * Fire-and-forget. Returns a promise but callers shouldn't await it on the
 * hot path — use `void recordUsage(...)`.
 */
export async function recordUsage(rec: UsageRecord): Promise<void> {
  try {
    const sb = getServiceClient()
    if (!sb) return
    const cost = estimateCost(rec.model, rec.inputTokens, rec.outputTokens)
    const { error } = await sb.from('llm_usage').insert({
      user_id: rec.userId,
      provider: rec.provider,
      model: rec.model,
      endpoint: rec.endpoint,
      input_tokens: rec.inputTokens,
      output_tokens: rec.outputTokens,
      cost_usd: cost,
      meta: rec.meta ?? null,
    })
    if (error) console.error('recordUsage insert failed:', error.message)
  } catch (e) {
    console.error('recordUsage threw:', (e as Error).message)
  }
}
