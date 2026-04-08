import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { ExamCountdown } from './ExamCountdown'
import { ModuleConfidence } from './ModuleConfidence'
import { PriorityAllocation } from './PriorityAllocation'
import { Button } from '@/components/ui/button'
import { Link } from 'react-router-dom'
import { Brain, GraduationCap, Trophy, Loader2 } from 'lucide-react'
import { fetchLeaderboard, fetchMyLeaderboardRank, type LeaderboardRow, type MyRank } from '@/services/leaderboard'

export function DashboardPage() {
  const allExams = useAppStore((s) => s.exams)
  const enrolledModuleIds = useAppStore((s) => s.enrolledModuleIds)
  const concepts = useAppStore((s) => s.concepts)
  const hydrated = useAppStore((s) => s.hydrated)

  const exams = useMemo(
    () => allExams.filter((e) => enrolledModuleIds.includes(e.id)),
    [allExams, enrolledModuleIds]
  )

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <div className="flex gap-2">
          {exams.length === 0 ? (
            <Button asChild>
              <Link to="/modules">
                <GraduationCap className="mr-2 h-4 w-4" />
                Pick modules
              </Link>
            </Button>
          ) : (
            <Button asChild>
              <Link to="/quiz">
                <Brain className="mr-2 h-4 w-4" />
                Start Quiz
              </Link>
            </Button>
          )}
        </div>
      </div>

      {exams.length === 0 && (
        <div className="rounded-lg border bg-muted/50 px-4 py-8 text-center">
          <GraduationCap className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">You're not enrolled in any modules yet</p>
          <p className="text-sm text-muted-foreground mb-4">
            Pick the modules you're studying to start tracking your revision.
          </p>
          <Button asChild size="sm">
            <Link to="/modules">Browse modules</Link>
          </Button>
        </div>
      )}

      {/* Exam countdowns */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {exams.map((exam) => (
          <ExamCountdown key={exam.id} exam={exam} />
        ))}
      </div>

      {/* Knowledge + Allocation */}
      <div className="grid gap-4 md:grid-cols-2">
        <ModuleConfidence />
        <PriorityAllocation />
      </div>

      {/* Stats summary */}
      {concepts.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Concepts" value={concepts.length} />
          <QuestionsStatCard />
          <SessionsStatCard />
        </div>
      )}

      {/* Leaderboard preview */}
      <LeaderboardWidget />
    </div>
  )
}

function LeaderboardWidget() {
  const [rows, setRows] = useState<LeaderboardRow[]>([])
  const [myRank, setMyRank] = useState<MyRank | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchLeaderboard({ window: 'week', moduleId: null, limit: 5 }),
      fetchMyLeaderboardRank({ window: 'week', moduleId: null }),
    ]).then(([leaderboard, rank]) => {
      if (cancelled) return
      setRows(leaderboard)
      setMyRank(rank)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Leaderboard · this week</span>
        </div>
        <Link to="/leaderboard" className="text-xs text-primary hover:underline">
          See all
        </Link>
      </div>
      {loading ? (
        <div className="py-6 flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          No one has answered any questions this week yet. Be first.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row) => {
            const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : null
            return (
              <div
                key={row.user_id}
                className={`grid grid-cols-[2.5rem_1fr_4rem] gap-3 px-4 py-2 text-sm tabular-nums ${
                  row.is_self ? 'bg-primary/10 font-medium' : ''
                }`}
              >
                <div className="text-muted-foreground">{medal ?? `#${row.rank}`}</div>
                <div className="truncate">{row.display_name}</div>
                <div className="text-right">{row.questions_answered}</div>
              </div>
            )
          })}
          {myRank && !rows.some((r) => r.is_self) && (
            <div className="grid grid-cols-[2.5rem_1fr_4rem] gap-3 px-4 py-2 text-sm tabular-nums bg-primary/10 font-medium">
              <div className="text-muted-foreground">#{myRank.rank}</div>
              <div className="truncate">You</div>
              <div className="text-right">{myRank.questions_answered}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function QuestionsStatCard() {
  const questions = useAppStore((s) => s.questions)
  return <StatCard label="Questions in bank" value={questions.length} />
}

function SessionsStatCard() {
  const knowledge = useAppStore((s) => s.knowledge)
  const totalAttempts = Object.values(knowledge).reduce(
    (sum, k) => sum + k.history.length,
    0
  )
  return <StatCard label="Questions answered" value={totalAttempts} />
}
