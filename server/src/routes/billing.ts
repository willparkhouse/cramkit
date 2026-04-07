/**
 * Billing routes — Stripe Checkout, customer portal, status.
 * All routes require auth. Webhook lives in routes/webhooks/getStripe().ts and
 * handles the actual subscription state mutations.
 */
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../lib/auth.js'
import { getStripe, STRIPE_PRICE_ID } from '../lib/stripe.js'

type AppEnv = { Variables: { user: { id: string; email?: string } } }
const app = new Hono<AppEnv>()

function getServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  return createClient(url, key, { auth: { persistSession: false } })
}

function appUrl(): string {
  // First entry of CORS_ORIGINS is treated as the canonical app URL.
  return (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',')[0].trim()
}

app.use('/billing/*', requireAuth)

/**
 * Find or create the Stripe customer for this user, persisting the id back
 * to profiles. Idempotent.
 */
async function ensureCustomer(userId: string, email: string | undefined): Promise<string> {
  const sb = getServiceClient()
  const { data: profile } = await sb
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle()

  if (profile?.stripe_customer_id) return profile.stripe_customer_id

  const customer = await getStripe().customers.create({
    email,
    metadata: { supabase_user_id: userId },
  })

  await sb
    .from('profiles')
    .upsert({ id: userId, email, stripe_customer_id: customer.id }, { onConflict: 'id' })

  return customer.id
}

// Create a Checkout Session for the pro subscription. Client redirects to the URL.
app.post('/billing/checkout', async (c) => {
  const user = c.get('user')
  if (!user?.id) return c.json({ error: 'Not authenticated' }, 401)

  try {
    const customerId = await ensureCustomer(user.id, user.email)
    const base = appUrl()
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${base}/account?checkout=success`,
      cancel_url: `${base}/account?checkout=cancelled`,
      allow_promotion_codes: true,
      // Mirror the supabase user id on the subscription itself so the webhook
      // can resolve the user even if customer metadata is missing.
      subscription_data: {
        metadata: { supabase_user_id: user.id },
      },
    })
    return c.json({ url: session.url })
  } catch (err) {
    console.error('checkout failed:', err)
    return c.json({ error: (err as Error).message }, 500)
  }
})

// Stripe-hosted billing portal for managing/cancelling the subscription.
app.post('/billing/portal', async (c) => {
  const user = c.get('user')
  if (!user?.id) return c.json({ error: 'Not authenticated' }, 401)

  try {
    const customerId = await ensureCustomer(user.id, user.email)
    const base = appUrl()
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${base}/account`,
    })
    return c.json({ url: session.url })
  } catch (err) {
    console.error('portal failed:', err)
    return c.json({ error: (err as Error).message }, 500)
  }
})

// Current subscription state for the signed-in user.
app.get('/billing/status', async (c) => {
  const user = c.get('user')
  if (!user?.id) return c.json({ error: 'Not authenticated' }, 401)

  const sb = getServiceClient()
  const { data, error } = await sb
    .from('profiles')
    .select('subscription_tier, subscription_status, current_period_end')
    .eq('id', user.id)
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({
    tier: data?.subscription_tier ?? 'free',
    status: data?.subscription_status ?? null,
    current_period_end: data?.current_period_end ?? null,
  })
})

export default app
