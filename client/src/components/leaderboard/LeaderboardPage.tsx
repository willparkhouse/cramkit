import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Trophy, Loader2, Sparkles } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import {
  fetchLeaderboard,
  fetchMyLeaderboardRank,
  fetchMyProfile,
  type LeaderboardRow,
  type MyRank,
  type LeaderboardWindow,
} from '@/services/leaderboard'
import { Link } from 'react-router-dom'

/**
 * Leaderboard page — global by default, filterable by module. Shows the top 25
 * for the selected window plus the caller's own row pinned at the bottom if
 * they're outside the top.
 */
export function LeaderboardPage() {
  const exams = useAppStore((s) => s.exams)
  const [window, setWindow] = useState<LeaderboardWindow>('week')
  const [moduleId, setModuleId] = useState<string | null>(null)
  const [rows, setRows] = useState<LeaderboardRow[]>([])
  const [myRank, setMyRank] = useState<MyRank | null>(null)
  const [loading, setLoading] = useState(true)
  const [optedIn, setOptedIn] = useState<boolean | null>(null)

  // Track whether the user has opted out — if so, the page becomes a CTA to
  // re-enable it from Settings rather than showing competitive content they
  // might find stressful.
  useEffect(() => {
    void fetchMyProfile().then((p) => setOptedIn(p?.leaderboard_opt_in ?? true))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetchLeaderboard({ window, moduleId, limit: 25 }),
      fetchMyLeaderboardRank({ window, moduleId }),
    ]).then(([leaderboard, rank]) => {
      if (cancelled) return
      setRows(leaderboard)
      setMyRank(rank)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [window, moduleId])

  const showMyRowSeparately = useMemo(() => {
    if (!myRank) return false
    return !rows.some((r) => r.is_self)
  }, [rows, myRank])

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-2">
        <Trophy className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight">Leaderboard</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Window toggle */}
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {(['week', 'all'] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                window === w
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background hover:bg-accent text-muted-foreground'
              }`}
            >
              {w === 'week' ? 'This week' : 'All time'}
            </button>
          ))}
        </div>

        {/* Module filter */}
        <select
          value={moduleId ?? ''}
          onChange={(e) => setModuleId(e.target.value || null)}
          className="border border-border rounded-md px-3 py-1.5 text-xs bg-background"
        >
          <option value="">All modules</option>
          {exams.map((exam) => (
            <option key={exam.id} value={exam.id}>{exam.name}</option>
          ))}
        </select>
      </div>

      {optedIn === false && (
        <Card className="border-amber-400/40 bg-amber-50/40 dark:bg-amber-950/10">
          <CardContent className="py-4 text-sm">
            <div className="font-medium mb-1 flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-amber-600" />
              You're hidden from the leaderboard
            </div>
            <p className="text-muted-foreground text-xs">
              Your stats aren't being shown to anyone. Re-enable in{' '}
              <Link to="/settings" className="text-primary underline">Settings</Link>{' '}
              if you'd like to compete.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No one has answered any questions {window === 'week' ? 'this week' : 'yet'}
              {moduleId && ' for this module'}.
            </div>
          ) : (
            <div className="divide-y divide-border">
              <LeaderboardHeader />
              {rows.map((row) => (
                <LeaderboardRowItem key={row.user_id} row={row} />
              ))}
              {showMyRowSeparately && myRank && (
                <>
                  <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                    Your rank
                  </div>
                  <LeaderboardRowItem
                    row={{
                      user_id: 'self',
                      display_name: 'You',
                      questions_answered: myRank.questions_answered,
                      questions_correct: myRank.questions_correct,
                      rank: myRank.rank,
                      is_self: true,
                    }}
                  />
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {myRank && (
        <p className="text-xs text-muted-foreground text-center">
          {myRank.total_participants} {myRank.total_participants === 1 ? 'participant' : 'participants'}
          {moduleId && ' in this module'}
          {window === 'week' && ' this week'}
        </p>
      )}
    </div>
  )
}

function LeaderboardHeader() {
  return (
    <div className="grid grid-cols-[3rem_1fr_5rem_5rem] gap-3 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
      <div>Rank</div>
      <div>Name</div>
      <div className="text-right">Answered</div>
      <div className="text-right">Correct</div>
    </div>
  )
}

function LeaderboardRowItem({ row }: { row: LeaderboardRow }) {
  const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : null
  return (
    <div
      className={`grid grid-cols-[3rem_1fr_5rem_5rem] gap-3 px-4 py-2.5 text-sm tabular-nums ${
        row.is_self ? 'bg-primary/10 font-medium' : ''
      }`}
    >
      <div className="text-muted-foreground">
        {medal ?? `#${row.rank}`}
      </div>
      <div className="truncate">{row.display_name}</div>
      <div className="text-right">{row.questions_answered}</div>
      <div className="text-right text-muted-foreground">{row.questions_correct}</div>
    </div>
  )
}
