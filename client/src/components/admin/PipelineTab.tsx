import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  pipelineListDrafts,
  pipelineGetDraft,
  pipelineDiscardDraft,
  pipelineGetJob,
  pipelineExtract,
  pipelinePromote,
  pipelineGenerateQuestions,
  adminListWeekTitles,
  adminUpdateWeekTitles,
  type AdminModule,
  type PipelineDraft,
  type PipelineDraftFull,
  type PipelineJob,
  type WeekTitle,
} from '@/lib/api'
import {
  Loader2,
  Sparkles,
  Upload,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  X,
  Trash2,
  FileText,
} from 'lucide-react'

interface Props {
  modules: AdminModule[]
  onChange: () => void | Promise<void>
}

/**
 * Content Pipeline tab — drives the three-stage admin workflow:
 *
 *   1. Extract  : run whole-week concept extraction over the module's
 *                 indexed source chunks → writes a draft row
 *   2. Promote  : copy a ready draft into the live concepts table
 *   3. Generate : run batch question generation for the module's concepts
 *
 * Each module gets a row showing source coverage, current concept/question
 * counts, and any in-flight or recent drafts. Long-running jobs are tracked
 * by polling /admin/pipeline/jobs/:id every 2 seconds while running.
 */
export function PipelineTab({ modules, onChange }: Props) {
  const [draftsByModule, setDraftsByModule] = useState<Record<string, PipelineDraft[]>>({})
  const [activeJobs, setActiveJobs] = useState<Record<string, PipelineJob>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // Load drafts for every module on mount, then on demand
  const reloadDrafts = useCallback(async () => {
    setError(null)
    try {
      const all = await pipelineListDrafts()
      const grouped: Record<string, PipelineDraft[]> = {}
      for (const d of all) {
        const list = grouped[d.module] ?? []
        list.push(d)
        grouped[d.module] = list
      }
      setDraftsByModule(grouped)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void reloadDrafts()
  }, [reloadDrafts])

  // ─── Job polling ────────────────────────────────────────────────────────
  // Each in-flight job is polled every 2 seconds. We stop polling once the
  // job leaves the "running" state. Polling happens in a single tick that
  // walks all active jobs together so multiple in-flight jobs share one
  // event loop pass instead of N intervals.
  const pollersRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const active = Object.entries(activeJobs).filter(
      ([, j]) => j.status === 'pending' || j.status === 'running'
    )
    if (active.length === 0) return

    const interval = setInterval(async () => {
      for (const [jobId] of active) {
        if (pollersRef.current.has(jobId)) continue
        pollersRef.current.add(jobId)
        try {
          const updated = await pipelineGetJob(jobId)
          setActiveJobs((prev) => ({ ...prev, [jobId]: updated }))
          if (updated.status === 'completed' || updated.status === 'failed') {
            // Job finished — refresh drafts and module stats so the row
            // reflects the new state
            await reloadDrafts()
            await onChange()
          }
        } catch {
          // Tolerate transient errors — next tick will retry
        } finally {
          pollersRef.current.delete(jobId)
        }
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [activeJobs, reloadDrafts, onChange])

  // Sorted, only published & unpublished modules
  const sortedModules = useMemo(
    () => [...modules].sort((a, b) => a.slug.localeCompare(b.slug)),
    [modules]
  )

  // ─── Action handlers ────────────────────────────────────────────────────
  const handleExtract = async (moduleSlug: string) => {
    setBusyKey(`extract-${moduleSlug}`)
    setError(null)
    try {
      const { job_id } = await pipelineExtract({ module: moduleSlug })
      const initial: PipelineJob = {
        id: job_id,
        kind: 'extract',
        module: moduleSlug,
        status: 'running',
        started_at: new Date().toISOString(),
        logs: [],
      }
      setActiveJobs((prev) => ({ ...prev, [job_id]: initial }))
      setExpanded((prev) => ({ ...prev, [moduleSlug]: true }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyKey(null)
    }
  }

  const handleGenerateQuestions = async (moduleSlug: string) => {
    if (
      !window.confirm(
        `Generate questions for every concept in "${moduleSlug}" that has zero questions? This uses server credits.`
      )
    ) {
      return
    }
    setBusyKey(`gen-${moduleSlug}`)
    setError(null)
    try {
      const { job_id } = await pipelineGenerateQuestions({ module: moduleSlug, scope: 'missing' })
      const initial: PipelineJob = {
        id: job_id,
        kind: 'generate-questions',
        module: moduleSlug,
        status: 'running',
        started_at: new Date().toISOString(),
        logs: [],
      }
      setActiveJobs((prev) => ({ ...prev, [job_id]: initial }))
      setExpanded((prev) => ({ ...prev, [moduleSlug]: true }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Run the whole-week concept extraction over a module's indexed sources, then promote the
        draft into the live <code className="text-xs">concepts</code> table, then batch-generate
        questions. Cost is paid from the server's OpenRouter / Anthropic key — no BYOK.
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-3 text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </CardContent>
        </Card>
      )}

      {sortedModules.map((module) => {
        const drafts = draftsByModule[module.slug] ?? []
        const liveDraft = drafts.find((d) => d.status === 'ready')
        const runningDraft = drafts.find((d) => d.status === 'running' || d.status === 'pending')
        const isExpanded = expanded[module.slug] ?? false
        const moduleJobs = Object.values(activeJobs).filter((j) => j.module === module.slug)
        return (
          <ModuleRow
            key={module.id}
            module={module}
            drafts={drafts}
            liveDraft={liveDraft}
            runningDraft={runningDraft}
            jobs={moduleJobs}
            expanded={isExpanded}
            busyKey={busyKey}
            onToggle={() => setExpanded((prev) => ({ ...prev, [module.slug]: !isExpanded }))}
            onExtract={() => handleExtract(module.slug)}
            onGenerateQuestions={() => handleGenerateQuestions(module.slug)}
            onPromoted={async () => {
              await reloadDrafts()
              await onChange()
            }}
            onDiscarded={async () => {
              await reloadDrafts()
            }}
          />
        )
      })}
    </div>
  )
}

// ----------------------------------------------------------------------------
// One module row + its expanded drawer
// ----------------------------------------------------------------------------
function ModuleRow({
  module,
  drafts,
  liveDraft,
  runningDraft,
  jobs,
  expanded,
  busyKey,
  onToggle,
  onExtract,
  onGenerateQuestions,
  onPromoted,
  onDiscarded,
}: {
  module: AdminModule
  drafts: PipelineDraft[]
  liveDraft: PipelineDraft | undefined
  runningDraft: PipelineDraft | undefined
  jobs: PipelineJob[]
  expanded: boolean
  busyKey: string | null
  onToggle: () => void
  onExtract: () => void
  onGenerateQuestions: () => void
  onPromoted: () => void | Promise<void>
  onDiscarded: () => void | Promise<void>
}) {
  const cov = module.coverage
  const q = module.questions
  const conceptCount = q?.concepts ?? 0
  const questionStats = q
    ? `${q.with_ok} ok · ${q.with_low} low · ${q.with_zero} empty`
    : '—'
  const liveJob = jobs.find((j) => j.status === 'running' || j.status === 'pending')

  return (
    <Card>
      <CardContent className="py-3 space-y-3">
        {/* Header row */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            aria-label="toggle"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{module.name}</span>
              <Badge variant="outline" className="text-[10px]">{module.slug}</Badge>
              {!module.is_published && (
                <Badge variant="secondary" className="text-[10px]">unpublished</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {cov.lectures} lec · {cov.slide_decks} decks · {cov.chunks} chunks · {conceptCount} concepts · {questionStats}
            </div>
          </div>

          <Button
            size="sm"
            variant="outline"
            disabled={!!liveJob || busyKey === `extract-${module.slug}` || cov.chunks === 0}
            onClick={onExtract}
            className="shrink-0"
          >
            {busyKey === `extract-${module.slug}` ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Sparkles className="h-3 w-3 mr-1" /> Extract
              </>
            )}
          </Button>

          <Button
            size="sm"
            variant="outline"
            disabled={!!liveJob || busyKey === `gen-${module.slug}` || conceptCount === 0}
            onClick={onGenerateQuestions}
            className="shrink-0"
            title="Generate questions for concepts that have zero"
          >
            {busyKey === `gen-${module.slug}` ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <HelpCircle className="h-3 w-3 mr-1" /> Generate
              </>
            )}
          </Button>
        </div>

        {/* In-flight jobs */}
        {liveJob && <JobStatus job={liveJob} />}

        {/* Inline running draft if no in-flight job (e.g. after page refresh) */}
        {!liveJob && runningDraft && (
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Draft running… ({runningDraft.progress?.weeks_done ?? 0}/{runningDraft.progress?.weeks_total ?? '?'} weeks)
          </div>
        )}

        {/* Expanded drawer: drafts list + week titles editor */}
        {expanded && (
          <div className="border-t border-border pt-3 space-y-3">
            {drafts.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Drafts
                </div>
                {drafts.map((d) => (
                  <DraftRow
                    key={d.id}
                    draft={d}
                    isLive={d.id === liveDraft?.id}
                    onPromoted={onPromoted}
                    onDiscarded={onDiscarded}
                  />
                ))}
              </div>
            )}
            <WeekTitlesEditor moduleId={module.id} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// Week titles editor — lets the admin type a per-week label that gets applied
// to every concept in (module, week). The progress UI then renders
// "Week N: <title>" automatically.
// ----------------------------------------------------------------------------
function WeekTitlesEditor({ moduleId }: { moduleId: string }) {
  const [weeks, setWeeks] = useState<WeekTitle[] | null>(null)
  const [titles, setTitles] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setWeeks(null)
    adminListWeekTitles(moduleId)
      .then((ws) => {
        if (cancelled) return
        setWeeks(ws)
        const initial: Record<number, string> = {}
        for (const w of ws) initial[w.week] = w.current_title ?? ''
        setTitles(initial)
      })
      .catch((err) => {
        if (cancelled) return
        setError((err as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [moduleId])

  const handleSave = async () => {
    setBusy(true)
    setError(null)
    setSavedAt(null)
    try {
      // Send all entries — empty strings clear the title back to null.
      const payload: Record<number, string | null> = {}
      for (const [week, title] of Object.entries(titles)) {
        payload[parseInt(week)] = title.trim() || null
      }
      const result = await adminUpdateWeekTitles(moduleId, payload)
      setSavedAt(Date.now())
      // Refresh the source data so subsequent edits reflect what we just saved
      const fresh = await adminListWeekTitles(moduleId)
      setWeeks(fresh)
      const next: Record<number, string> = {}
      for (const w of fresh) next[w.week] = w.current_title ?? ''
      setTitles(next)
      void result
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (weeks === null) {
    return (
      <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading weeks…
      </div>
    )
  }
  if (weeks.length === 0) {
    return (
      <div className="text-[10px] text-muted-foreground italic">
        No concepts yet — promote a draft first to set week titles.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Week titles
      </div>
      <div className="space-y-1.5">
        {weeks.map((w) => (
          <div key={w.week} className="flex items-center gap-2">
            <span className="text-xs font-medium w-20 shrink-0 text-muted-foreground">
              Week {w.week}
            </span>
            <input
              className="flex-1 border border-border rounded-md px-2 py-1 text-xs bg-background"
              value={titles[w.week] ?? ''}
              onChange={(e) => setTitles((s) => ({ ...s, [w.week]: e.target.value }))}
              placeholder={`e.g. Access control & OS hardening (${w.concept_count} concepts)`}
              disabled={busy}
            />
          </div>
        ))}
      </div>
      {error && <div className="text-[10px] text-destructive">{error}</div>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleSave}
          disabled={busy}
          className="h-6 px-2 text-[10px]"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save week titles'}
        </Button>
        {savedAt && !busy && (
          <span className="text-[10px] text-green-700 dark:text-green-400">Saved</span>
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// In-flight job UI
// ----------------------------------------------------------------------------
function JobStatus({ job }: { job: PipelineJob }) {
  const isRunning = job.status === 'running' || job.status === 'pending'
  const isFailed = job.status === 'failed'
  const tail = job.logs.slice(-12)

  // Best-effort progress percent for the extract job kind
  let progressPct: number | null = null
  if (job.kind === 'extract' && job.progress) {
    const total = (job.progress as { weeks_total?: number }).weeks_total
    const done = (job.progress as { weeks_done?: number }).weeks_done
    if (typeof total === 'number' && typeof done === 'number' && total > 0) {
      progressPct = Math.round((done / total) * 100)
    }
  } else if (job.kind === 'generate-questions' && job.progress) {
    const total = (job.progress as { concepts_total?: number }).concepts_total
    const done = (job.progress as { concepts_done?: number }).concepts_done
    if (typeof total === 'number' && typeof done === 'number' && total > 0) {
      progressPct = Math.round((done / total) * 100)
    }
  }

  return (
    <div className="rounded-md bg-muted/50 p-2 space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
        {!isRunning && !isFailed && <CheckCircle2 className="h-3 w-3 text-green-500" />}
        {isFailed && <AlertCircle className="h-3 w-3 text-destructive" />}
        <span className="font-medium">{labelForKind(job.kind)}</span>
        <span className="text-muted-foreground">· {job.status}</span>
        {progressPct !== null && (
          <span className="text-muted-foreground ml-auto">{progressPct}%</span>
        )}
      </div>
      {progressPct !== null && (
        <div className="h-1 rounded-full bg-background overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      {tail.length > 0 && (
        <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap leading-snug max-h-32 overflow-y-auto">
          {tail.join('\n')}
        </pre>
      )}
      {job.error && (
        <div className="text-xs text-destructive">{job.error}</div>
      )}
    </div>
  )
}

function labelForKind(kind: PipelineJob['kind']): string {
  switch (kind) {
    case 'extract':
      return 'Extracting concepts'
    case 'promote':
      return 'Promoting draft'
    case 'generate-questions':
      return 'Generating questions'
  }
}

// ----------------------------------------------------------------------------
// Draft row
// ----------------------------------------------------------------------------
function DraftRow({
  draft,
  isLive,
  onPromoted,
  onDiscarded,
}: {
  draft: PipelineDraft
  isLive: boolean
  onPromoted: () => void | Promise<void>
  onDiscarded: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<PipelineDraftFull | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [promoteResult, setPromoteResult] = useState<string | null>(null)

  const loadFull = useCallback(async () => {
    if (full) return
    try {
      const f = await pipelineGetDraft(draft.id)
      setFull(f)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [draft.id, full])

  const handlePromote = async (mode: 'skip' | 'replace', dryRun: boolean) => {
    if (mode === 'replace' && !dryRun) {
      const ok = window.confirm(
        `REPLACE will delete every existing concept for this module under your admin user, ` +
        `which CASCADES to all questions and knowledge rows. Continue?`
      )
      if (!ok) return
    }
    setBusy(`promote-${mode}-${dryRun}`)
    setError(null)
    try {
      const { result } = await pipelinePromote({ draft_id: draft.id, mode, dry_run: dryRun })
      setPromoteResult(
        dryRun
          ? `Dry run: would insert ${result.inserted}, skip ${result.skipped}${result.deleted ? `, delete ${result.deleted}` : ''}`
          : `Inserted ${result.inserted}, skipped ${result.skipped}${result.deleted ? `, deleted ${result.deleted}` : ''}`
      )
      if (!dryRun) await onPromoted()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleDiscard = async () => {
    if (!window.confirm(`Mark draft as discarded? It stays in the table for the audit trail but is hidden.`)) return
    setBusy('discard')
    try {
      await pipelineDiscardDraft(draft.id)
      await onDiscarded()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen(!open)
            if (!open) void loadFull()
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <Badge variant={statusVariant(draft.status)} className="text-[10px]">
          {draft.status}
        </Badge>
        {isLive && <Badge variant="outline" className="text-[10px]">latest ready</Badge>}
        <span className="text-xs text-muted-foreground">
          {new Date(draft.generated_at).toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground ml-auto">
          {draft.total_concepts} concepts
        </span>
        {draft.status === 'ready' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => handlePromote('skip', false)}
            className="h-6 px-2 text-[10px]"
          >
            {busy === 'promote-skip-false' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Upload className="h-3 w-3 mr-1" /> Promote (skip)
              </>
            )}
          </Button>
        )}
        {draft.status !== 'discarded' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={handleDiscard}
            className="h-6 px-2 text-[10px]"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {error && (
        <div className="px-2.5 pb-2 text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      )}
      {promoteResult && (
        <div className="px-2.5 pb-2 text-xs text-green-700 dark:text-green-400">
          {promoteResult}
        </div>
      )}

      {open && (
        <div className="border-t border-border px-2.5 py-2 space-y-2 text-xs">
          {!full && <Loader2 className="h-3 w-3 animate-spin" />}
          {full && (
            <>
              {/* By-week breakdown */}
              <div className="flex flex-wrap gap-1">
                {Object.entries(full.payload.by_week ?? {}).sort().map(([k, v]) => (
                  <Badge key={k} variant="outline" className="text-[10px]">
                    {k.replace('week-', 'w')}: {v}
                  </Badge>
                ))}
              </div>

              {/* Coverage report */}
              {full.coverage_report && (
                <details className="rounded bg-muted/40 p-2">
                  <summary className="cursor-pointer font-medium flex items-center gap-1">
                    <FileText className="h-3 w-3" /> Coverage report
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap text-[11px] leading-snug">
                    {full.coverage_report}
                  </pre>
                </details>
              )}

              {/* Concepts list (collapsed by default) */}
              <details className="rounded bg-muted/40 p-2">
                <summary className="cursor-pointer font-medium flex items-center gap-1">
                  <Sparkles className="h-3 w-3" /> {full.payload.concepts.length} concepts
                </summary>
                <ul className="mt-2 space-y-1">
                  {full.payload.concepts.map((c, i) => (
                    <li key={i} className="leading-snug">
                      <span className="text-muted-foreground">[w{c.week ?? '?'}]</span>{' '}
                      <span className="font-medium">{c.name}</span>
                    </li>
                  ))}
                </ul>
              </details>

              {/* Promote with replace — destructive */}
              {full.status === 'ready' && (
                <div className="flex items-center gap-2 pt-1 border-t border-border/60">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => handlePromote('skip', true)}
                    className="h-6 px-2 text-[10px]"
                  >
                    Dry-run skip
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => handlePromote('replace', true)}
                    className="h-6 px-2 text-[10px]"
                  >
                    Dry-run replace
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null}
                    onClick={() => handlePromote('replace', false)}
                    className="h-6 px-2 text-[10px] ml-auto"
                  >
                    <Trash2 className="h-3 w-3 mr-1" /> Promote (replace)
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function statusVariant(status: PipelineDraft['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'ready':
      return 'default'
    case 'promoted':
      return 'secondary'
    case 'failed':
      return 'destructive'
    case 'running':
    case 'pending':
      return 'outline'
    case 'discarded':
      return 'outline'
  }
}
