import { useState, useMemo } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { getEffectiveScore } from '@/store/selectors'
import { MODULE_SHORT_NAMES, MODULE_COLOURS } from '@/lib/constants'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronRight, CheckCircle, XCircle, Clock, HelpCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Concept, KnowledgeEntry } from '@/types'

function timeAgo(date: string | null): string {
  if (!date) return 'never'
  const ms = Date.now() - new Date(date).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface ConceptWithStats {
  concept: Concept
  knowledge: KnowledgeEntry | null
  effectiveScore: number
  totalAttempts: number
  correctAttempts: number
  questionsAvailable: number
}

export function ProgressPage() {
  const concepts = useAppStore((s) => s.concepts)
  const knowledge = useAppStore((s) => s.knowledge)
  const questions = useAppStore((s) => s.questions)
  const exams = useAppStore((s) => s.exams)

  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set())
  const [expandedConcept, setExpandedConcept] = useState<string | null>(null)
  const [moduleFilter, setModuleFilter] = useState<string | null>(null)

  // Build concept stats
  const conceptStats = useMemo((): ConceptWithStats[] => {
    return concepts.map((concept) => {
      const k = knowledge[concept.id] || null
      const effectiveScore = k ? getEffectiveScore(k.score, k.last_tested) : 0
      const totalAttempts = k ? k.history.length : 0
      const correctAttempts = k ? k.history.filter((h) => h.correct).length : 0
      const questionsAvailable = questions.filter((q) => q.concept_id === concept.id).length

      return { concept, knowledge: k, effectiveScore, totalAttempts, correctAttempts, questionsAvailable }
    })
  }, [concepts, knowledge, questions])

  // Filter by module
  const filtered = useMemo(() => {
    if (!moduleFilter) return conceptStats
    return conceptStats.filter((cs) => cs.concept.module_ids.includes(moduleFilter))
  }, [conceptStats, moduleFilter])

  // Group by week
  const weekGroups = useMemo(() => {
    const groups = new Map<string, { week: number; lecture: string; concepts: ConceptWithStats[] }>()

    for (const cs of filtered) {
      const week = cs.concept.week || 0
      const lecture = cs.concept.lecture || 'Uncategorised'
      const key = `${week}-${lecture}`

      if (!groups.has(key)) {
        groups.set(key, { week, lecture, concepts: [] })
      }
      groups.get(key)!.concepts.push(cs)
    }

    return Array.from(groups.values()).sort((a, b) => a.week - b.week)
  }, [filtered])

  // Summary stats
  const summary = useMemo(() => {
    const total = filtered.length
    const tested = filtered.filter((cs) => cs.totalAttempts > 0).length
    const mastered = filtered.filter((cs) => cs.effectiveScore >= 0.8).length
    const weak = filtered.filter((cs) => cs.effectiveScore < 0.4 && cs.totalAttempts > 0).length
    const untested = total - tested
    const avgScore = total > 0 ? filtered.reduce((sum, cs) => sum + cs.effectiveScore, 0) / total : 0

    return { total, tested, mastered, weak, untested, avgScore }
  }, [filtered])

  const toggleWeek = (key: string) => {
    const next = new Set(expandedWeeks)
    next.has(key) ? next.delete(key) : next.add(key)
    setExpandedWeeks(next)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Progress</h1>
      </div>

      {/* Module filter */}
      <div className="flex flex-wrap gap-2">
        <Badge
          variant={moduleFilter === null ? 'default' : 'outline'}
          className="cursor-pointer"
          onClick={() => setModuleFilter(null)}
        >
          All modules
        </Badge>
        {exams.map((exam) => {
          const shortName = MODULE_SHORT_NAMES[exam.name] || exam.name
          const colour = MODULE_COLOURS[exam.name] || '#888'
          const active = moduleFilter === exam.id
          return (
            <Badge
              key={exam.id}
              variant={active ? 'default' : 'outline'}
              className="cursor-pointer"
              style={active ? { backgroundColor: colour, borderColor: colour } : {}}
              onClick={() => setModuleFilter(active ? null : exam.id)}
            >
              {shortName}
            </Badge>
          )
        })}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard label="Total" value={summary.total} />
        <SummaryCard label="Tested" value={summary.tested} sub={`${summary.untested} untested`} />
        <SummaryCard label="Mastered" value={summary.mastered} sub="≥80% confidence" colour="text-green-600" />
        <SummaryCard label="Weak" value={summary.weak} sub="<40% confidence" colour="text-red-500" />
        <SummaryCard label="Avg Score" value={`${Math.round(summary.avgScore * 100)}%`} />
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to={`/quiz?mode=weakest${moduleFilter ? `&module=${moduleFilter}` : ''}`}>
            Quiz Weakest
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={`/quiz?mode=untested${moduleFilter ? `&module=${moduleFilter}` : ''}`}>
            Quiz Untested ({summary.untested})
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={`/quiz?mode=mistakes${moduleFilter ? `&module=${moduleFilter}` : ''}`}>
            Review Mistakes ({summary.weak})
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={`/quiz?mode=spaced${moduleFilter ? `&module=${moduleFilter}` : ''}`}>
            Spaced Repetition
          </Link>
        </Button>
      </div>

      {/* Week groups */}
      {weekGroups.map((group) => {
        const key = `${group.week}-${group.lecture}`
        const expanded = expandedWeeks.has(key)
        const avgScore = group.concepts.reduce((sum, cs) => sum + cs.effectiveScore, 0) / group.concepts.length
        const testedCount = group.concepts.filter((cs) => cs.totalAttempts > 0).length

        return (
          <Card key={key}>
            <CardHeader
              className="py-3 cursor-pointer"
              onClick={() => toggleWeek(key)}
            >
              <div className="flex items-center gap-3">
                {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-sm font-medium">
                    {group.week > 0 ? `Week ${group.week}: ` : ''}{group.lecture}
                  </CardTitle>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {group.concepts.length} concepts · {testedCount} tested · {Math.round(avgScore * 100)}% avg
                  </div>
                </div>
                <div className="w-24">
                  <Progress value={avgScore * 100} className="h-2" />
                </div>
              </div>
            </CardHeader>

            {expanded && (
              <CardContent className="pt-0 space-y-1">
                {group.concepts
                  .sort((a, b) => a.effectiveScore - b.effectiveScore)
                  .map((cs) => (
                    <ConceptRow
                      key={cs.concept.id}
                      cs={cs}
                      expanded={expandedConcept === cs.concept.id}
                      onToggle={() => setExpandedConcept(
                        expandedConcept === cs.concept.id ? null : cs.concept.id
                      )}
                      questions={questions}
                    />
                  ))}
              </CardContent>
            )}
          </Card>
        )
      })}
    </div>
  )
}

function SummaryCard({ label, value, sub, colour }: { label: string; value: string | number; sub?: string; colour?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className={`text-xl font-bold ${colour || ''}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

function ConceptRow({ cs, expanded, onToggle, questions }: {
  cs: ConceptWithStats
  expanded: boolean
  onToggle: () => void
  questions: { id: string; concept_id: string; type: string; question: string; correct_answer: string }[]
}) {
  const scorePercent = Math.round(cs.effectiveScore * 100)
  const scoreColour = scorePercent >= 80 ? 'text-green-600' : scorePercent >= 40 ? 'text-yellow-600' : scorePercent > 0 ? 'text-red-500' : 'text-muted-foreground'

  return (
    <div className="border rounded-md">
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
      >
        {cs.totalAttempts === 0 ? (
          <HelpCircle className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : cs.effectiveScore >= 0.8 ? (
          <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
        ) : cs.effectiveScore < 0.4 ? (
          <XCircle className="h-4 w-4 text-red-400 shrink-0" />
        ) : (
          <Clock className="h-4 w-4 text-yellow-500 shrink-0" />
        )}

        <span className="text-sm flex-1 truncate">{cs.concept.name}</span>

        <span className={`text-xs font-mono font-medium ${scoreColour} w-10 text-right`}>
          {scorePercent}%
        </span>

        <span className="text-[10px] text-muted-foreground w-16 text-right">
          {cs.totalAttempts > 0
            ? `${cs.correctAttempts}/${cs.totalAttempts} · ${timeAgo(cs.knowledge?.last_tested || null)}`
            : 'untested'}
        </span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          <div className="text-xs text-muted-foreground">{cs.concept.description}</div>

          {cs.concept.key_facts.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium text-muted-foreground">Key Facts:</p>
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                {cs.concept.key_facts.map((fact, i) => <li key={i}>{fact}</li>)}
              </ul>
            </div>
          )}

          {/* Question history */}
          {cs.knowledge && cs.knowledge.history.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">Recent Attempts:</p>
              <div className="space-y-0.5">
                {cs.knowledge.history.slice(-10).reverse().map((attempt, i) => {
                  const q = questions.find((qq) => qq.id === attempt.question_id)
                  return (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      {attempt.correct ? (
                        <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-red-400 shrink-0" />
                      )}
                      <span className="text-muted-foreground truncate flex-1">
                        {q ? q.question.substring(0, 80) + (q.question.length > 80 ? '...' : '') : 'Question'}
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {Math.round(attempt.score_after * 100)}%
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Questions available */}
          <div className="text-[10px] text-muted-foreground">
            {cs.questionsAvailable} questions in bank
          </div>
        </div>
      )}
    </div>
  )
}
