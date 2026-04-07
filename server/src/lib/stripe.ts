import Stripe from 'stripe'

let cached: Stripe | null = null

/**
 * Lazy Stripe client. The constructor throws on an empty key in stripe@22+,
 * so we can't eagerly instantiate at module load — that crashes the whole
 * server when STRIPE_SECRET_KEY is unset. Billing routes call this and 500
 * gracefully if the key isn't configured.
 */
export function getStripe(): Stripe {
  if (cached) return cached
  const apiKey = process.env.STRIPE_SECRET_KEY
  if (!apiKey) throw new Error('STRIPE_SECRET_KEY not set')
  cached = new Stripe(apiKey, { apiVersion: '2026-03-25.dahlia' })
  return cached
}

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TJXqmRQQzfkSbxuebbOM1mo'
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
