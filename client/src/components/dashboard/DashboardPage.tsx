import { useAppStore } from '@/store/useAppStore'
import { ExamCountdown } from './ExamCountdown'
import { ModuleConfidence } from './ModuleConfidence'
import { PriorityAllocation } from './PriorityAllocation'
import { Button } from '@/components/ui/button'
import { Link } from 'react-router-dom'
import { Brain, Upload } from 'lucide-react'

export function DashboardPage() {
  const exams = useAppStore((s) => s.exams)
  const concepts = useAppStore((s) => s.concepts)
  const hydrated = useAppStore((s) => s.hydrated)

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
          {concepts.length === 0 ? (
            <Button asChild>
              <Link to="/ingest">
                <Upload className="mr-2 h-4 w-4" />
                Ingest Notes
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
