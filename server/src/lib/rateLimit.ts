import type { Context, Next } from 'hono'

interface SupabaseUser {
  id: string
  email?: string
}

interface Bucket {
  count: number
  resetAt: number
}

/**
 * Simple in-memory token-bucket rate limiter keyed by user ID.
 * Resets every `windowMs`. Suitable for a single-instance deployment;
 * if we ever scale horizontally, replace with Redis or Upstash.
 */
export function rateLimit(opts: { windowMs: number; max: number; key: string }) {
  const buckets = new Map<string, Bucket>()

  return async function rateLimitMiddleware(c: Context, next: Next) {
    const user = c.get('user') as SupabaseUser | undefined
    if (!user?.id) {
      // Should never happen if requireAuth ran first, but fail closed.
      return c.json({ error: 'Not authenticated' }, 401)
    }

    const now = Date.now()
    const key = `${opts.key}:${user.id}`
    const existing = buckets.get(key)

    if (!existing || existing.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
    } else {
      if (existing.count >= opts.max) {
        const retryAfter = Math.ceil((existing.resetAt - now) / 1000)
        return c.json(
          { error: 'Rate limit exceeded', retry_after_seconds: retryAfter },
          429,
          { 'Retry-After': String(retryAfter) }
        )
      }
      existing.count += 1
    }

    // Periodic cleanup of expired buckets to keep memory bounded
    if (buckets.size > 1000) {
      for (const [k, b] of buckets) {
        if (b.resetAt < now) buckets.delete(k)
      }
    }

    await next()
  }
}
