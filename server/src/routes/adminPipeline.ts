/**
 * Admin content-pipeline routes.
 *
 * Three long-running operations driven from the admin UI:
 *   POST /admin/pipeline/extract           — kick off concept extraction
 *   POST /admin/pipeline/promote           — promote a draft into the live concepts table
 *   POST /admin/pipeline/generate-questions — generate questions for concepts with none
 *
 * Status polling:
 *   GET  /admin/pipeline/jobs/:id          — current state of one job
 *   GET  /admin/pipeline/drafts            — all extracted_concepts rows for status display
 *   GET  /admin/pipeline/drafts/:id        — full draft payload (concepts + coverage gaps)
 *
 * Job state lives in-process in a Map. That's adequate for a one-admin tool;
 * if multiple admins or multi-instance deploys ever happen, swap to a jobs
 * table backed by Postgres LISTEN/NOTIFY or a queue.
 */
import { Hono } from 'hono'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { requireAuth, requireAdmin } from '../lib/auth.js'
import { runExtraction, type ExtractionResult } from '../lib/conceptExtraction.js'
import { promoteDraft } from '../lib/conceptImport.js'
import { runQuestionGeneration } from '../lib/questionGeneration.js'

type AppEnv = { Variables: { user: { id: string; email?: string } } }
const app = new Hono<AppEnv>()

app.use('/admin/pipeline/*', requireAuth, requireAdmin)

function getServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  return createClient(url, key, { auth: { persistSession: false } })
}

// ----------------------------------------------------------------------------
// In-memory job registry
//
// Each job has a state machine:
//   pending → running → completed | failed
//
// We keep the last 50 jobs in memory; older ones get evicted by insertion
// order. The UI polls /jobs/:id every couple of seconds while a job is in
// flight, then stops polling once status leaves the running state.
// ----------------------------------------------------------------------------
type JobKind = 'extract' | 'promote' | 'generate-questions'
type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

interface JobState {
  id: string
  kind: JobKind
  module: string
  status: JobStatus
  started_at: string
  finished_at?: string
  /** Free-form progress payload, depends on job kind */
  progress?: Record<string, unknown>
  /** Last 200 log lines (older lines drop off the front) */
  logs: string[]
  /** Job-kind-specific result payload set on completion */
  result?: Record<string, unknown>
  error?: string
}

const jobs = new Map<string, JobState>()
const MAX_JOBS = 50
const MAX_LOG_LINES = 200

function newJobId(): string {
  return crypto.randomUUID()
}

function recordJob(state: JobState) {
  jobs.set(state.id, state)
  if (jobs.size > MAX_JOBS) {
    const oldestKey = jobs.keys().next().value
    if (oldestKey) jobs.delete(oldestKey)
  }
}

function appendLog(jobId: string, line: string) {
  const j = jobs.get(jobId)
  if (!j) return
  j.logs.push(line)
  if (j.logs.length > MAX_LOG_LINES) j.logs.splice(0, j.logs.length - MAX_LOG_LINES)
}

// ----------------------------------------------------------------------------
// Drafts listing endpoints — used by the admin UI to display per-module
// extraction history without polling job state.
// ----------------------------------------------------------------------------
app.get('/admin/pipeline/drafts', async (c) => {
  const moduleSlug = c.req.query('module')
  const sb = getServiceClient()
  let query = sb
    .from('extracted_concepts')
    .select('id, module, status, generated_at, promoted_at, error_message, progress, payload')
    .order('generated_at', { ascending: false })
    .limit(50)
  if (moduleSlug) query = query.eq('module', moduleSlug)
  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 500)
  // Strip the heavy `payload` field from the listing — only return summary stats
  const drafts = (data ?? []).map((d) => {
    const payload = d.payload as ExtractionResult | null
    return {
      id: d.id,
      module: d.module,
      status: d.status,
      generated_at: d.generated_at,
      promoted_at: d.promoted_at,
      error_message: d.error_message,
      progress: d.progress,
      total_concepts: payload?.total_concepts ?? 0,
      by_week: payload?.by_week ?? {},
      has_coverage_report: !!payload && Boolean((payload as ExtractionResult).coverage_report),
    }
  })
  return c.json({ drafts })
})

app.get('/admin/pipeline/drafts/:id', async (c) => {
  const id = c.req.param('id')
  const sb = getServiceClient()
  const { data, error } = await sb
    .from('extracted_concepts')
    .select('*')
    .eq('id', id)
    .single()
  if (error || !data) return c.json({ error: error?.message ?? 'not found' }, 404)
  return c.json({ draft: data })
})

app.post('/admin/pipeline/drafts/:id/discard', async (c) => {
  const id = c.req.param('id')
  const sb = getServiceClient()
  const { error } = await sb
    .from('extracted_concepts')
    .update({ status: 'discarded' })
    .eq('id', id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

// ----------------------------------------------------------------------------
// Job status polling
// ----------------------------------------------------------------------------
app.get('/admin/pipeline/jobs/:id', (c) => {
  const id = c.req.param('id')
  const j = jobs.get(id)
  if (!j) return c.json({ error: 'job not found (may have been evicted)' }, 404)
  return c.json({ job: j })
})

// ----------------------------------------------------------------------------
// POST /admin/pipeline/extract  — kick off concept extraction for a module
// ----------------------------------------------------------------------------
app.post('/admin/pipeline/extract', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const moduleSlug = typeof body.module === 'string' ? body.module : null
  const skipCoverage = body.skip_coverage === true
  const model = body.model === 'haiku' ? 'haiku' : 'sonnet'

  if (!moduleSlug) return c.json({ error: 'module (string) required' }, 400)

  const user = c.get('user')
  const jobId = newJobId()
  const job: JobState = {
    id: jobId,
    kind: 'extract',
    module: moduleSlug,
    status: 'pending',
    started_at: new Date().toISOString(),
    logs: [],
  }
  recordJob(job)

  // Create the draft row up front so the UI can show "running" immediately
  const sb = getServiceClient()
  const { data: draftRow, error: draftErr } = await sb
    .from('extracted_concepts')
    .insert({
      module: moduleSlug,
      status: 'running',
      generated_by: user?.id ?? null,
      progress: { weeks_total: 0, weeks_done: 0 },
    })
    .select('id')
    .single()
  if (draftErr || !draftRow) {
    job.status = 'failed'
    job.error = draftErr?.message ?? 'failed to insert draft row'
    job.finished_at = new Date().toISOString()
    return c.json({ error: job.error }, 500)
  }
  const draftId = draftRow.id as string
  job.progress = { draft_id: draftId, weeks_total: 0, weeks_done: 0 }

  // Fire-and-forget. The HTTP response returns immediately with the job id;
  // the UI polls /jobs/:id for progress.
  ;(async () => {
    job.status = 'running'
    appendLog(jobId, `Job ${jobId} started for module ${moduleSlug}`)

    try {
      const result = await runExtraction({
        moduleSlug,
        skipCoverage,
        model,
        onLog: (line) => {
          appendLog(jobId, line)
        },
        onProgress: async (p) => {
          job.progress = { draft_id: draftId, ...p }
          // Persist progress to the draft row so it survives a restart
          await sb
            .from('extracted_concepts')
            .update({ progress: p })
            .eq('id', draftId)
        },
      })

      // Persist the full result to the draft row and flip status to ready
      await sb
        .from('extracted_concepts')
        .update({
          status: 'ready',
          payload: result,
          coverage_report: result.coverage_report,
        })
        .eq('id', draftId)

      job.status = 'completed'
      job.result = {
        draft_id: draftId,
        total_concepts: result.total_concepts,
        by_week: result.by_week,
      }
      job.finished_at = new Date().toISOString()
      appendLog(jobId, `Extraction complete: ${result.total_concepts} concept(s)`)
    } catch (err) {
      job.status = 'failed'
      job.error = (err as Error).message
      job.finished_at = new Date().toISOString()
      appendLog(jobId, `FATAL: ${job.error}`)
      await sb
        .from('extracted_concepts')
        .update({ status: 'failed', error_message: job.error })
        .eq('id', draftId)
    }
  })()

  return c.json({ job_id: jobId, draft_id: draftId })
})

// ----------------------------------------------------------------------------
// POST /admin/pipeline/promote  — promote a ready draft into the live concepts table
// ----------------------------------------------------------------------------
app.post('/admin/pipeline/promote', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const draftId = typeof body.draft_id === 'string' ? body.draft_id : null
  const mode = body.mode === 'replace' ? 'replace' : 'skip'
  const dryRun = body.dry_run === true

  if (!draftId) return c.json({ error: 'draft_id (string) required' }, 400)

  const user = c.get('user')
  if (!user?.id) return c.json({ error: 'no user' }, 401)

  // Promote is fast (just DB writes) — run synchronously and return the result.
  // No job tracking needed for this one.
  try {
    const result = await promoteDraft({
      draftId,
      ownerUserId: user.id,
      mode,
      dryRun,
    })
    return c.json({ result })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ----------------------------------------------------------------------------
// POST /admin/pipeline/generate-questions  — batch question gen for a module
// ----------------------------------------------------------------------------
app.post('/admin/pipeline/generate-questions', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const moduleSlug = typeof body.module === 'string' ? body.module : null
  const scope = body.scope === 'all' ? 'all' : 'missing'

  if (!moduleSlug) return c.json({ error: 'module (string) required' }, 400)

  const user = c.get('user')
  if (!user?.id) return c.json({ error: 'no user' }, 401)

  const jobId = newJobId()
  const job: JobState = {
    id: jobId,
    kind: 'generate-questions',
    module: moduleSlug,
    status: 'running',
    started_at: new Date().toISOString(),
    logs: [],
  }
  recordJob(job)

  ;(async () => {
    appendLog(jobId, `Job ${jobId} started: question gen for ${moduleSlug} (scope=${scope})`)
    try {
      const result = await runQuestionGeneration({
        moduleSlug,
        ownerUserId: user.id,
        scope,
        onLog: (line) => appendLog(jobId, line),
        onProgress: (p) => {
          job.progress = { ...p }
        },
      })
      job.status = 'completed'
      job.result = { ...result }
      job.finished_at = new Date().toISOString()
      appendLog(jobId, `Done: ${result.questions_generated} questions across ${result.concepts_processed} concept(s)`)
    } catch (err) {
      job.status = 'failed'
      job.error = (err as Error).message
      job.finished_at = new Date().toISOString()
      appendLog(jobId, `FATAL: ${job.error}`)
    }
  })()

  return c.json({ job_id: jobId })
})

export default app
