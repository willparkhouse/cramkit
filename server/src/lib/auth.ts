import type { Context, Next } from 'hono'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY

// Comma-separated allowlist of admin emails. Defaults to the project owner if unset.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'wjdparkhouse@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

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

    c.set('user', user)
    await next()
  } catch (err) {
    console.error('Auth check failed:', err)
    return c.json({ error: 'Auth check failed' }, 500)
  }
}

/**
 * Middleware that requires the caller to be on the admin allowlist.
 * Composes with requireAuth — call requireAuth first.
 */
export async function requireAdmin(c: Context, next: Next) {
  const user = c.get('user') as SupabaseUser | undefined
  if (!user?.email) {
    return c.json({ error: 'Not authenticated' }, 401)
  }
  if (!ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    return c.json({ error: 'Forbidden: admin only' }, 403)
  }
  await next()
}
