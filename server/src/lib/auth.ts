import type { Context, Next } from 'hono'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.warn('SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY not set — JWT validation disabled')
}

interface SupabaseUser {
  id: string
  email?: string
}

/**
 * Hono middleware that validates the Supabase JWT in the Authorization header.
 * Calls the Supabase auth API to verify the token. If valid, attaches the user
 * to the context. If not, returns 401.
 */
export async function requireAuth(c: Context, next: Next) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Authorization header' }, 401)
  }

  const token = auth.slice('Bearer '.length)

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return c.json({ error: 'Server auth not configured' }, 500)
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_PUBLISHABLE_KEY,
      },
    })

    if (!res.ok) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    const user = await res.json() as SupabaseUser
    if (!user.id) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    // Enforce bham.ac.uk email at the API level too (defence in depth)
    if (user.email && !/@(.+\.)?bham\.ac\.uk$/i.test(user.email)) {
      return c.json({ error: 'Forbidden: bham.ac.uk emails only' }, 403)
    }

    c.set('user', user)
    await next()
  } catch (err) {
    console.error('Auth check failed:', err)
    return c.json({ error: 'Auth check failed' }, 500)
  }
}
