import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/lib/auth'
import { refreshEnrollments } from '@/store/hydrate'
import * as api from '@/lib/api'
import { MODULE_COLOURS, getModuleShortName } from '@/lib/constants'
import { formatDate, daysUntil } from '@/lib/utils'
import { Plus, ThumbsUp, Loader2, GraduationCap, X, Bell, CheckCircle, Clock } from 'lucide-react'
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
  // Only published modules are openly enrollable. Unpublished modules show
  // up in the "Coming soon" list with a "Notify me" action that creates a
  // module_requests row linked to the exam — when the admin flips the
  // is_published flag, the publish trigger auto-enrolls the requester.
  const available = exams.filter((e) => !enrolledModuleIds.includes(e.id) && e.is_published !== false)
  const upcoming = exams.filter((e) => !enrolledModuleIds.includes(e.id) && e.is_published === false)

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

  // Express interest in an unpublished module — creates/votes on a linked
  // request behind the scenes. The publish trigger auto-enrolls voters.
  const [interestSet, setInterestSet] = useState<Set<string>>(new Set())
  const handleExpressInterest = async (exam: typeof exams[number]) => {
    setBusy(exam.id)
    try {
      await api.expressInterestInModule(exam)
      setInterestSet((s) => new Set(s).add(exam.id))
    } catch (err) {
      console.error('Failed to express interest:', err)
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

  const sortedRequests = [...requests].sort(
    (a, b) => (voteCounts[b.id] || 0) - (voteCounts[a.id] || 0)
  )

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Modules</h1>

      {/* Enrolled */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Your modules ({enrolled.length})
        </h2>
        {enrolled.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            You're not enrolled in any modules yet. Pick one below.
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {enrolled.map((exam) => (
              <ModuleRow
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
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Available modules ({available.length})
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            {available.map((exam) => (
              <ModuleRow
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

      {/* Coming soon — modules that exist but aren't published yet. Users can
          flag interest; the publish trigger auto-enrolls them when it drops. */}
      {upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Coming soon ({upcoming.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            These modules are being prepared. Tap "Notify me" and we'll auto-enrol you the moment they're ready.
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {upcoming.map((exam) => {
              const interested = interestSet.has(exam.id)
              return (
                <UpcomingModuleRow
                  key={exam.id}
                  exam={exam}
                  busy={busy === exam.id}
                  interested={interested}
                  onAction={() => handleExpressInterest(exam)}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* Requested by other students — surfaced first so users notice them */}
      {!loading && sortedRequests.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Requested modules
          </h2>
          <p className="text-xs text-muted-foreground">
            Tap <ThumbsUp className="inline h-3 w-3 -mt-0.5" /> "Me too" if you want this module added — the most-requested ones get prioritised.
          </p>
          <div className="divide-y divide-border/60">
            {sortedRequests.map((req) => {
              const voted = myVotes.has(req.id)
              const count = voteCounts[req.id] || 0
              return (
                <div key={req.id} className="flex items-start gap-3 py-2.5">
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
                    className="shrink-0 gap-1.5 h-7 px-2.5 text-xs"
                  >
                    <ThumbsUp className="h-3 w-3" />
                    {voted ? 'Me too' : 'Me too'} · {count}
                  </Button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {loading && (
        <div className="text-center py-2">
          <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
        </div>
      )}

      {/* Submit a new request — least frequent action, sits at the bottom */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Don't see your module?
        </h2>
        <p className="text-xs text-muted-foreground">
          Request it here. cramkit's admin manually adds approved modules.
        </p>
        <form onSubmit={handleSubmitRequest} className="space-y-2">
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
      </section>
    </div>
  )
}

function UpcomingModuleRow({
  exam,
  busy,
  interested,
  onAction,
}: {
  exam: { id: string; name: string; date: string; weight: number }
  busy: boolean
  interested: boolean
  onAction: () => void
}) {
  const colour = MODULE_COLOURS[exam.name] || '#888'
  const shortName = getModuleShortName(exam)
  return (
    <div className="flex items-center gap-3 rounded-md px-2.5 py-2 border border-dashed border-border/60 bg-muted/20">
      <div className="w-2.5 h-2.5 rounded-sm shrink-0 opacity-60" style={{ backgroundColor: colour }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate leading-tight">{exam.name}</p>
        <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
          <Clock className="h-3 w-3" /> {shortName} · in preparation
        </p>
      </div>
      <Button
        size="sm"
        variant={interested ? 'ghost' : 'outline'}
        onClick={onAction}
        disabled={busy || interested}
        className="shrink-0 h-7 px-2.5 text-xs"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : interested ? (
          <><CheckCircle className="mr-1 h-3 w-3" /> Notified</>
        ) : (
          <><Bell className="mr-1 h-3 w-3" /> Notify me</>
        )}
      </Button>
    </div>
  )
}

function ModuleRow({
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
  const shortName = getModuleShortName(exam)
  const days = Math.ceil(daysUntil(exam.date))

  return (
    <div className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-accent/30 transition-colors">
      <div
        className="w-2.5 h-2.5 rounded-sm shrink-0"
        style={{ backgroundColor: colour }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate leading-tight">{exam.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {shortName} · {formatDate(exam.date)} · in {days}d
        </p>
      </div>
      <Button
        size="sm"
        variant={enrolled ? 'ghost' : 'default'}
        onClick={onAction}
        disabled={busy}
        className="shrink-0 h-7 px-2.5 text-xs"
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
  )
}
