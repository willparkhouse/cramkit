/**
 * Subscription context — fetches the current user's billing status from
 * /api/billing/status and exposes the tier ('free' | 'pro') across the app.
 *
 * Used by lib/api.ts to decide whether to call the server proxy or hit
 * Anthropic directly from the browser, and by the Account / paywall UIs.
 */
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'

export type Tier = 'free' | 'pro'

interface SubscriptionState {
  tier: Tier
  status: string | null
  currentPeriodEnd: string | null
  loading: boolean
  refresh: () => Promise<void>
}

const SubscriptionContext = createContext<SubscriptionState>({
  tier: 'free',
  status: null,
  currentPeriodEnd: null,
  loading: true,
  refresh: async () => {},
})

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [tier, setTier] = useState<Tier>('free')
  const [status, setStatus] = useState<string | null>(null)
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!user) {
      setTier('free')
      setStatus(null)
      setCurrentPeriodEnd(null)
      setLoading(false)
      return
    }
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch('/api/billing/status', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const body = (await res.json()) as { tier: Tier; status: string | null; current_period_end: string | null }
      setTier(body.tier === 'pro' ? 'pro' : 'free')
      setStatus(body.status)
      setCurrentPeriodEnd(body.current_period_end)
    } catch (e) {
      console.error('subscription refresh failed:', (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    setLoading(true)
    refresh()
  }, [refresh])

  // Mirror to module-level snapshot so non-React code (lib/api.ts) can branch.
  useEffect(() => {
    setCurrentTier(tier)
  }, [tier])

  return (
    <SubscriptionContext.Provider value={{ tier, status, currentPeriodEnd, loading, refresh }}>
      {children}
    </SubscriptionContext.Provider>
  )
}

export function useSubscription() {
  return useContext(SubscriptionContext)
}

/**
 * Snapshot accessor for non-React code (lib/api.ts) to read the current
 * tier without going through the React context. Updated by the provider on
 * every refresh.
 */
let currentTier: Tier = 'free'
export function getCurrentTier(): Tier {
  return currentTier
}
export function setCurrentTier(t: Tier): void {
  currentTier = t
}
