import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase env vars: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY')
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

/**
 * Signup currently allows any email. Keeping this helper around in case we
 * reinstate the bham restriction later (once uni IT allowlists cramkit.app
 * or we have a working SSO flow).
 */
export function isBhamEmail(email: string): boolean {
  const lower = email.trim().toLowerCase()
  return /@(.+\.)?bham\.ac\.uk$/.test(lower)
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}
