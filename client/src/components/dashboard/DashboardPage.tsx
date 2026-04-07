import { useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { ExamCountdown } from './ExamCountdown'
import { ModuleConfidence } from './ModuleConfidence'
import { PriorityAllocation } from './PriorityAllocation'
import { Button } from '@/components/ui/button'
import { Link } from 'react-router-dom'
import { Brain, GraduationCap } from 'lucide-react'

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
