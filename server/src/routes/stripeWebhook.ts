/**
 * Stripe webhook handler.
 *
 * Mounted at /api/webhooks/stripe and intentionally OUTSIDE the auth and CORS
 * middleware — Stripe authenticates itself via the webhook signature, not a
 * user JWT, and the request body must be read as a raw string for signature
 * verification (any JSON parsing would invalidate it).
 */
import { Hono } from 'hono'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { stripe, STRIPE_WEBHOOK_SECRET } from '../lib/stripe.js'

const app = new Hono()

function getServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  return createClient(url, key, { auth: { persistSession: false } })
}

// Resolve a profile row from a Stripe customer id, falling back to the
// supabase_user_id metadata that we stamp on customers + subscriptions.
async function resolveUserId(
  sb: SupabaseClient,
  customerId: string,
  metaUserId: string | undefined
): Promise<string | null> {
  if (metaUserId) return metaUserId
  const { data } = await sb
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  return data?.id ?? null
}

async function syncSubscription(sb: SupabaseClient, sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const userId = await resolveUserId(
    sb,
    customerId,
    (sub.metadata as Record<string, string>)?.supabase_user_id
  )
  if (!userId) {
    console.warn(`stripe webhook: no user matched for customer ${customerId}`)
    return
  }

  const status = sub.status
  // Treat trialing as pro too, in case we add trials later.
  const tier = status === 'active' || status === 'trialing' ? 'pro' : 'free'
  // current_period_end moved off the top-level Subscription in newer API
  // versions; pull from the first item instead.
  const periodEndUnix =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    sub.items?.data?.[0]?.current_period_end ??
    null
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null

  const { error } = await sb
    .from('profiles')
    .update({
      stripe_subscription_id: sub.id,
      subscription_status: status,
      subscription_tier: tier,
      current_period_end: periodEnd,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)

  if (error) console.error('stripe webhook: profile update failed:', error.message)
}

app.post('/webhooks/stripe', async (c) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error('stripe webhook hit but STRIPE_WEBHOOK_SECRET not set')
    return c.json({ error: 'webhook not configured' }, 500)
  }

  const sig = c.req.header('stripe-signature')
  if (!sig) return c.json({ error: 'missing signature' }, 400)

  const rawBody = await c.req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('stripe webhook signature verification failed:', (err as Error).message)
    return c.json({ error: 'invalid signature' }, 400)
  }

  const sb = getServiceClient()

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.subscription && session.customer) {
          const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id
          const sub = await stripe.subscriptions.retrieve(subId)
          await syncSubscription(sb, sub)
        }
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        await syncSubscription(sb, sub)
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const subId = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(typeof subId === 'string' ? subId : subId.id)
          await syncSubscription(sb, sub)
        }
        break
      }
      default:
        // Ignore other events; Stripe will resend if we 4xx.
        break
    }
  } catch (err) {
    console.error(`stripe webhook handler error for ${event.type}:`, err)
    return c.json({ error: 'handler error' }, 500)
  }

  return c.json({ received: true })
})

export default app
