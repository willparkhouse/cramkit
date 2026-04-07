import Stripe from 'stripe'

const apiKey = process.env.STRIPE_SECRET_KEY

if (!apiKey) {
  console.warn('STRIPE_SECRET_KEY not set — billing routes will 500')
}

export const stripe = new Stripe(apiKey || '', {
  // Pin a known API version so Stripe-side upgrades don't break us silently.
  apiVersion: '2026-03-25.dahlia',
})

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TJXqmRQQzfkSbxuebbOM1mo'
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''
