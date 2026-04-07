import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/lib/auth'
import { refreshEnrollments } from '@/store/hydrate'
import * as api from '@/lib/api'
import { MODULE_COLOURS, MODULE_SHORT_NAMES } from '@/lib/constants'
import { formatDate, daysUntil } from '@/lib/utils'
import { CheckCircle, Plus, ThumbsUp, Loader2, GraduationCap, X } from 'lucide-react'
import type { ModuleRequest } from '@/types'

export function ModulesPage() {
  const exams = useAppStore((s) => s.exams)
  const enrolledModuleIds = useAppStore((s) => s.enrolledModuleIds)
  const { user } = useAuth()

  const [requests, setRequests] = useState<ModuleRequest[]>([])
  const [voteCounts, setVoteCounts] = useState<Record<string, number>>({})
  const [myVotes, setMyVotes] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadRequests = useCallback(async () => {
    try {
      const [reqs, votes] = await Promise.all([
        api.fetchModuleRequests(),
        api.fetchRequestVotes(),
      ])
      setRequests(reqs)
      const counts: Record<string, number> = {}
      const mine = new Set<string>()
      for (const v of votes) {
        counts[v.request_id] = (counts[v.request_id] || 0) + 1
        if (v.user_id === user?.id) mine.add(v.request_id)
      }
      setVoteCounts(counts)
      setMyVotes(mine)
    } catch (err) {
      console.error('Failed to load requests:', err)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    loadRequests()
  }, [loadRequests])

  const enrolled = exams.filter((e) => enrolledModuleIds.includes(e.id))
  const available = exams.filter((e) => !enrolledModuleIds.includes(e.id))

  const handleEnroll = async (moduleId: string) => {
    setBusy(moduleId)
    try {
      await api.enrollInModule(moduleId)
      await refreshEnrollments()
    } finally {
      setBusy(null)
    }
  }

  const handleUnenroll = async (moduleId: string) => {
    setBusy(moduleId)
    try {
      await api.unenrollFromModule(moduleId)
      await refreshEnrollments()
    } finally {
      setBusy(null)
    }
  }

  const handleVote = async (requestId: string) => {
    setBusy(requestId)
    try {
      if (myVotes.has(requestId)) {
        await api.unvoteRequest(requestId)
      } else {
        await api.voteForRequest(requestId)
      }
      await loadRequests()
    } finally {
      setBusy(null)
    }
  }

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    setSubmitting(true)
    try {
      await api.createModuleRequest(newName, newDescription)
      setNewName('')
      setNewDescription('')
      await loadRequests()
    } catch (err) {
      console.error('Failed to create request:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Modules</h1>

      {/* Enrolled */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Your modules ({enrolled.length})
        </h2>
        {enrolled.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              You're not enrolled in any modules yet. Pick one below.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {enrolled.map((exam) => (
              <ModuleCard
                key={exam.id}
                exam={exam}
                enrolled
                busy={busy === exam.id}
                onAction={() => handleUnenroll(exam.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Available */}
      {available.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Available modules ({available.length})
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {available.map((exam) => (
              <ModuleCard
                key={exam.id}
                exam={exam}
                enrolled={false}
                busy={busy === exam.id}
                onAction={() => handleEnroll(exam.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Request a module */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Request a module
        </h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Don't see your module?</CardTitle>
            <p className="text-xs text-muted-foreground">
              Request it here. cramkit's admin manually adds approved modules.
              Vote for existing requests to bump them up the queue.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmitRequest} className="space-y-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Module name (e.g. Distributed Systems)"
                required
                disabled={submitting}
                className="w-full border rounded-md px-3 py-2 text-sm bg-background"
              />
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional: course code, year, brief description"
                disabled={submitting}
                rows={2}
                className="w-full border rounded-md px-3 py-2 text-sm bg-background resize-none"
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={!newName.trim() || submitting} size="sm">
                  {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : (
                    <><Plus className="mr-1 h-3 w-3" /> Submit request</>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Pending requests */}
        {loading ? (
          <div className="text-center py-4">
            <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
          </div>
        ) : requests.length > 0 && (
          <div className="space-y-2">
            {requests
              .sort((a, b) => (voteCounts[b.id] || 0) - (voteCounts[a.id] || 0))
              .map((req) => {
                const voted = myVotes.has(req.id)
                const count = voteCounts[req.id] || 0
                return (
                  <Card key={req.id}>
                    <CardContent className="flex items-start gap-3 py-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{req.name}</p>
                        {req.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {req.description}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={voted ? 'default' : 'outline'}
                        onClick={() => handleVote(req.id)}
                        disabled={busy === req.id}
                        className="shrink-0 gap-1.5"
                      >
                        <ThumbsUp className="h-3 w-3" />
                        {count}
                      </Button>
                    </CardContent>
                  </Card>
                )
              })}
          </div>
        )}
      </section>
    </div>
  )
}

function ModuleCard({
  exam,
  enrolled,
  busy,
  onAction,
}: {
  exam: { id: string; name: string; date: string; weight: number }
  enrolled: boolean
  busy: boolean
  onAction: () => void
}) {
  const colour = MODULE_COLOURS[exam.name] || '#888'
  const shortName = MODULE_SHORT_NAMES[exam.name] || exam.name
  const days = Math.ceil(daysUntil(exam.date))

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div
              className="w-3 h-3 rounded-sm shrink-0"
              style={{ backgroundColor: colour }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{exam.name}</p>
              <p className="text-xs text-muted-foreground">
                {shortName} · Exam in {days}d
              </p>
            </div>
          </div>
          {enrolled && (
            <Badge variant="secondary" className="text-[10px] gap-1 shrink-0">
              <CheckCircle className="h-3 w-3" />
              Enrolled
            </Badge>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 mt-3">
          <p className="text-xs text-muted-foreground">
            {formatDate(exam.date)}
          </p>
          <Button
            size="sm"
            variant={enrolled ? 'outline' : 'default'}
            onClick={onAction}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : enrolled ? (
              <><X className="mr-1 h-3 w-3" /> Unenroll</>
            ) : (
              <><GraduationCap className="mr-1 h-3 w-3" /> Enroll</>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
