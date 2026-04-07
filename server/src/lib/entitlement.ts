/**
 * Entitlement middleware: gates AI endpoints behind either a paid subscription
 * or a BYOK provider key on the user's profile. Compose AFTER requireAuth.
 *
 * Free users with neither get a 402 with an error code the client can use to
 * decide between "Upgrade" and "Add your own key".
 */
import type { Context, Next } from 'hono'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

interface EntitledProfile {
  subscription_tier: string | null
  byok_openai_key: string | null
  byok_anthropic_key: string | null
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

export interface Entitlement {
  tier: 'pro' | 'free'
  hasByokOpenAI: boolean
  hasByokAnthropic: boolean
  byokOpenAIKey: string | null
  byokAnthropicKey: string | null
}

/**
 * Middleware factory. `requires` lists which provider keys an endpoint needs
 * if the user is on the free tier (so we can validate BYOK coverage).
 * Pro users always pass.
 */
export function requireAIAccess(requires: Array<'openai' | 'anthropic'>) {
  return async function (c: Context, next: Next) {
    const user = c.get('user') as { id: string } | undefined
    if (!user?.id) return c.json({ error: 'Not authenticated' }, 401)

    const sb = getServiceClient()
    if (!sb) return c.json({ error: 'Server not configured' }, 500)

    const { data, error } = await sb
      .from('profiles')
      .select('subscription_tier, byok_openai_key, byok_anthropic_key')
      .eq('id', user.id)
      .maybeSingle<EntitledProfile>()

    if (error) {
      console.error('entitlement lookup failed:', error.message)
      return c.json({ error: 'Entitlement check failed' }, 500)
    }

    const tier = data?.subscription_tier === 'pro' ? 'pro' : 'free'
    const ent: Entitlement = {
      tier,
      hasByokOpenAI: !!data?.byok_openai_key,
      hasByokAnthropic: !!data?.byok_anthropic_key,
      byokOpenAIKey: data?.byok_openai_key ?? null,
      byokAnthropicKey: data?.byok_anthropic_key ?? null,
    }

    if (tier !== 'pro') {
      const missing = requires.filter((p) =>
        p === 'openai' ? !ent.hasByokOpenAI : !ent.hasByokAnthropic
      )
      if (missing.length > 0) {
        return c.json(
          {
            error: 'ai_access_required',
            message: 'Upgrade to Pro or add your own API key to use AI features.',
            missing_providers: missing,
          },
          402
        )
      }
    }

    c.set('entitlement', ent)
    await next()
  }
}
