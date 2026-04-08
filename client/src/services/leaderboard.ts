/**
 * Leaderboard + profile-display read/write helpers. All routes through Supabase
 * directly via RLS — no server proxy needed. Failures are logged and returned
 * as null/empty so the UI can degrade gracefully.
 */
import { supabase } from '@/lib/supabase'

export interface LeaderboardRow {
  user_id: string
  display_name: string
  questions_answered: number
  questions_correct: number
  rank: number
  is_self: boolean
}

export interface MyRank {
  rank: number
  questions_answered: number
  questions_correct: number
  total_participants: number
}

export type LeaderboardWindow = 'week' | 'all'

export async function fetchLeaderboard(opts: {
  window: LeaderboardWindow
  moduleId?: string | null
  limit?: number
}): Promise<LeaderboardRow[]> {
  try {
    const { data, error } = await supabase.rpc('get_leaderboard', {
      p_window: opts.window,
      p_module_id: opts.moduleId ?? null,
      p_limit: opts.limit ?? 25,
    })
    if (error) {
      console.error('fetchLeaderboard failed:', error.message)
      return []
    }
    return (data ?? []) as LeaderboardRow[]
  } catch (e) {
    console.error('fetchLeaderboard threw:', (e as Error).message)
    return []
  }
}

export async function fetchMyLeaderboardRank(opts: {
  window: LeaderboardWindow
  moduleId?: string | null
}): Promise<MyRank | null> {
  try {
    const { data, error } = await supabase.rpc('get_my_leaderboard_rank', {
      p_window: opts.window,
      p_module_id: opts.moduleId ?? null,
    })
    if (error) {
      console.error('fetchMyLeaderboardRank failed:', error.message)
      return null
    }
    const rows = (data ?? []) as MyRank[]
    return rows[0] ?? null
  } catch (e) {
    console.error('fetchMyLeaderboardRank threw:', (e as Error).message)
    return null
  }
}

// ----------------------------------------------------------------------------
// Profile (display name + opt-out)
// ----------------------------------------------------------------------------

export interface LeaderboardProfile {
  display_name: string | null
  leaderboard_opt_in: boolean
}

export async function fetchMyProfile(): Promise<LeaderboardProfile | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name, leaderboard_opt_in')
      .eq('id', user.id)
      .maybeSingle()
    if (error) {
      console.error('fetchMyProfile failed:', error.message)
      return null
    }
    return (data as LeaderboardProfile | null) ?? { display_name: null, leaderboard_opt_in: true }
  } catch (e) {
    console.error('fetchMyProfile threw:', (e as Error).message)
    return null
  }
}

export async function updateMyProfile(input: Partial<LeaderboardProfile>): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return false
    // Upsert (not update) so that the rare case where a user has no profile
    // row yet — e.g. signed up before the on_auth_user_created trigger
    // existed — still works. id is the primary key so onConflict='id'.
    const patch: Record<string, unknown> = {
      id: user.id,
      email: user.email,
      updated_at: new Date().toISOString(),
    }
    if (input.display_name !== undefined) {
      patch.display_name = input.display_name?.trim() ? input.display_name.trim().slice(0, 40) : null
    }
    if (input.leaderboard_opt_in !== undefined) {
      patch.leaderboard_opt_in = input.leaderboard_opt_in
    }
    const { error } = await supabase.from('profiles').upsert(patch, { onConflict: 'id' })
    if (error) {
      console.error('updateMyProfile failed:', error.message)
      return false
    }
    return true
  } catch (e) {
    console.error('updateMyProfile threw:', (e as Error).message)
    return false
  }
}
