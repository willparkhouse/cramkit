/**
 * Pro-tier gate for AI proxy routes. Compose AFTER requireAuth.
 *
 * Returns 402 with a structured error so the client can render the paywall
 * modal with "Upgrade" / "Add your own key" actions.
 */
import type { Context, Next } from 'hono'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cachedClient: SupabaseClient | null = null
function getServiceClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  cachedClient = createClient(url, key, { auth: { persistSession: false } })
  return cachedClient
}

export async function requirePro(c: Context, next: Next) {
  const user = c.get('user') as { id: string } | undefined
  if (!user?.id) return c.json({ error: 'Not authenticated' }, 401)

  const sb = getServiceClient()
  if (!sb) return c.json({ error: 'Server not configured' }, 500)

  const { data, error } = await sb
    .from('profiles')
    .select('subscription_tier, subscription_status')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('requirePro lookup failed:', error.message)
    return c.json({ error: 'Entitlement check failed' }, 500)
  }

  const tier = data?.subscription_tier === 'pro' ? 'pro' : 'free'
  const status = data?.subscription_status ?? null

  // Treat past_due as still pro for a grace period — Stripe will retry
  // payment and the webhook will downgrade if it ultimately fails.
  const entitled = tier === 'pro' && (status === 'active' || status === 'trialing' || status === 'past_due')
  if (!entitled) {
    return c.json(
      {
        error: 'pro_required',
        message: 'This feature requires a Pro subscription. Upgrade or add your own Anthropic key.',
      },
      402
    )
  }

  await next()
}
