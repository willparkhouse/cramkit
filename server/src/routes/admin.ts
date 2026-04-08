/**
 * Admin-only routes for managing modules and source ingestion.
 * All endpoints require requireAuth + requireAdmin.
 */
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { requireAuth, requireAdmin } from '../lib/auth.js'
import { ingestSlideDeck } from '../lib/slideIngest.js'
import { ingestTranscript } from '../lib/transcriptIngest.js'

type AppEnv = { Variables: { user: { id: string; email?: string } } }
const app = new Hono<AppEnv>()

app.use('/admin/*', requireAuth, requireAdmin)

// Hard ceiling on a single slide-deck upload — 25 MB is plenty for a typical PDF.
const MAX_PDF_BYTES = 25 * 1024 * 1024
// Transcripts are plain text — 2 MB covers a multi-hour lecture comfortably.
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024

function getServiceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  return createClient(url, key, { auth: { persistSession: false } })
}

// ----------------------------------------------------------------------------
// Modules (exams)
// ----------------------------------------------------------------------------

// List all modules with their source-chunk coverage stats.
app.get('/admin/modules', async (c) => {
  const sb = getServiceClient()
  const { data: exams, error } = await sb.from('exams').select('*').order('name')
  if (error) return c.json({ error: error.message }, 500)

  // Pull a coverage summary per module.
  const { data: sources } = await sb
    .from('sources')
    .select('module, source_type, id')
  const { data: chunkCounts } = await sb
    .from('source_chunks')
    .select('source_id', { count: 'exact', head: false })

  const chunkCountBySource = new Map<string, number>()
  for (const row of chunkCounts ?? []) {
    chunkCountBySource.set(row.source_id, (chunkCountBySource.get(row.source_id) ?? 0) + 1)
  }

  const coverageBySlug = new Map<string, { slide_decks: number; lectures: number; chunks: number }>()
  for (const src of sources ?? []) {
    const cov = coverageBySlug.get(src.module) ?? { slide_decks: 0, lectures: 0, chunks: 0 }
    if (src.source_type === 'slides') cov.slide_decks++
    if (src.source_type === 'lecture') cov.lectures++
    cov.chunks += chunkCountBySource.get(src.id) ?? 0
    coverageBySlug.set(src.module, cov)
  }

  // Question coverage per module: how many concepts have 0 / 1–2 / ≥3
  // questions. Used by the admin status page to drive the "Retry failed" and
  // "Top up sparse" actions.
  //
  // Both `concepts` and `questions` can exceed the default PostgREST 1000-row
  // page limit (we have ~400 concepts and ~1800 questions today), so page
  // through them explicitly. Without this, the question map silently misses
  // most rows and every concept past the cutoff looks empty.
  async function fetchAllRows<T>(table: string, columns: string): Promise<T[]> {
    const PAGE = 1000
    const out: T[] = []
    let from = 0
    while (true) {
      const { data, error } = await sb
        .from(table)
        .select(columns)
        .range(from, from + PAGE - 1)
      if (error) throw error
      const rows = (data ?? []) as T[]
      out.push(...rows)
      if (rows.length < PAGE) break
      from += PAGE
    }
    return out
  }

  const concepts = await fetchAllRows<{ id: string; module_ids: string[] }>('concepts', 'id, module_ids')
  const questionCounts = await fetchAllRows<{ concept_id: string }>('questions', 'concept_id')

  const qPerConcept = new Map<string, number>()
  for (const row of questionCounts) {
    qPerConcept.set(row.concept_id, (qPerConcept.get(row.concept_id) ?? 0) + 1)
  }

  type QStats = { concepts: number; with_zero: number; with_low: number; with_ok: number }
  const questionsByModule = new Map<string, QStats>()
  for (const c of concepts) {
    const count = qPerConcept.get(c.id) ?? 0
    for (const mid of c.module_ids ?? []) {
      const stats = questionsByModule.get(mid) ?? { concepts: 0, with_zero: 0, with_low: 0, with_ok: 0 }
      stats.concepts++
      if (count === 0) stats.with_zero++
      else if (count <= 2) stats.with_low++
      else stats.with_ok++
      questionsByModule.set(mid, stats)
    }
  }

  return c.json({
    modules: (exams ?? []).map((e) => ({
      ...e,
      coverage: coverageBySlug.get(e.slug) ?? { slide_decks: 0, lectures: 0, chunks: 0 },
      questions: questionsByModule.get(e.id) ?? { concepts: 0, with_zero: 0, with_low: 0, with_ok: 0 },
    })),
  })
})

app.post('/admin/modules', async (c) => {
  const body = await c.req.json()
  const { name, slug, date, weight, semester } = body
  if (typeof name !== 'string' || !name.trim()) return c.json({ error: 'name required' }, 400)
  if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
    return c.json({ error: 'slug required (lowercase a-z, 0-9, hyphen)' }, 400)
  }
  if (typeof date !== 'string') return c.json({ error: 'date (ISO) required' }, 400)
  if (typeof weight !== 'number') return c.json({ error: 'weight (number) required' }, 400)
  if (typeof semester !== 'number') return c.json({ error: 'semester (number) required' }, 400)

  const sb = getServiceClient()
  // New modules default to UNPUBLISHED so the admin can ingest content
  // before students see them. Flip via the publish button on the status tab.
  const { data, error } = await sb
    .from('exams')
    .insert({ name: name.trim(), slug, date, weight, semester, is_published: false })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ module: data })
})

// Edit an existing module. Slug edits cascade through `sources.module` and
// any FK that references the slug — guard against orphaning by leaving slug
// alone unless the caller explicitly asked.
app.patch('/admin/modules/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { name, slug, date, weight, semester } = body

  const patch: Record<string, unknown> = {}
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return c.json({ error: 'name must be non-empty' }, 400)
    patch.name = name.trim()
  }
  if (slug !== undefined) {
    if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
      return c.json({ error: 'slug must be lowercase a-z, 0-9, hyphen' }, 400)
    }
    patch.slug = slug
  }
  if (date !== undefined) {
    if (typeof date !== 'string') return c.json({ error: 'date must be ISO string' }, 400)
    patch.date = date
  }
  if (weight !== undefined) {
    if (typeof weight !== 'number' || weight < 0 || weight > 1) {
      return c.json({ error: 'weight must be number 0-1' }, 400)
    }
    patch.weight = weight
  }
  if (semester !== undefined) {
    if (typeof semester !== 'number') return c.json({ error: 'semester must be number' }, 400)
    patch.semester = semester
  }
  if (body.is_published !== undefined) {
    if (typeof body.is_published !== 'boolean') return c.json({ error: 'is_published must be boolean' }, 400)
    patch.is_published = body.is_published
  }

  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to update' }, 400)

  const sb = getServiceClient()

  // If slug is changing, fetch the old slug first so we can cascade-update
  // the `sources.module` text column (no FK; it joins by slug).
  let oldSlug: string | null = null
  if (typeof patch.slug === 'string') {
    const { data: existing } = await sb.from('exams').select('slug').eq('id', id).maybeSingle()
    oldSlug = existing?.slug ?? null
  }

  const { data, error } = await sb
    .from('exams')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)

  // Cascade slug rename to sources rows that reference it by text.
  if (oldSlug && typeof patch.slug === 'string' && oldSlug !== patch.slug) {
    const { error: srcErr } = await sb
      .from('sources')
      .update({ module: patch.slug })
      .eq('module', oldSlug)
    if (srcErr) console.error('slug cascade to sources failed:', srcErr.message)
  }

  return c.json({ module: data })
})

// Delete a module. Cascades through sources + source_chunks via the
// existing FK relationships, plus concepts/questions via module_ids array
// membership (handled separately because it's an array column).
app.delete('/admin/modules/:id', async (c) => {
  const id = c.req.param('id')
  const sb = getServiceClient()

  // Confirm gate — caller must pass ?confirm=<slug> matching the module's
  // current slug. Protects against accidental delete from a fat-fingered
  // curl or a misbehaving frontend.
  const confirm = c.req.query('confirm')
  const { data: existing, error: lookupErr } = await sb
    .from('exams')
    .select('slug')
    .eq('id', id)
    .maybeSingle()
  if (lookupErr) return c.json({ error: lookupErr.message }, 500)
  if (!existing) return c.json({ error: 'module not found' }, 404)
  if (confirm !== existing.slug) {
    return c.json({ error: `confirm=${existing.slug} required` }, 400)
  }

  // Delete chunks → sources → exam, in that order. We don't touch concepts
  // or questions: those reference modules via a `module_ids uuid[]` array
  // (Postgres won't let us cascade through that), and we'd rather leak a
  // few orphan concepts than nuke them when an admin deletes a module.
  const { data: srcRows } = await sb.from('sources').select('id').eq('module', existing.slug)
  const sourceIds = (srcRows ?? []).map((r) => r.id as string)
  if (sourceIds.length > 0) {
    await sb.from('source_chunks').delete().in('source_id', sourceIds)
    await sb.from('sources').delete().in('id', sourceIds)
  }

  const { error: delErr } = await sb.from('exams').delete().eq('id', id)
  if (delErr) return c.json({ error: delErr.message }, 500)

  return c.json({ ok: true, deleted_sources: sourceIds.length })
})

// ----------------------------------------------------------------------------
// Module requests — admin view + linking
// ----------------------------------------------------------------------------

// List all module requests (pending + resolved) with vote counts so the admin
// can see what students are asking for and link them to real exam rows.
app.get('/admin/module-requests', async (c) => {
  const sb = getServiceClient()
  const { data: reqs, error } = await sb
    .from('module_requests')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)

  const reqIds = (reqs ?? []).map((r) => r.id as string)
  const voteCounts = new Map<string, number>()
  if (reqIds.length > 0) {
    const { data: votes } = await sb
      .from('module_request_votes')
      .select('request_id')
      .in('request_id', reqIds)
    for (const v of votes ?? []) {
      const id = v.request_id as string
      voteCounts.set(id, (voteCounts.get(id) ?? 0) + 1)
    }
  }

  return c.json({
    requests: (reqs ?? []).map((r) => ({
      ...r,
      vote_count: voteCounts.get(r.id as string) ?? 0,
    })),
  })
})

// Link a free-text module request to a real exam row. Once linked, the
// publish trigger will auto-enroll the requester + voters when the exam
// transitions to is_published=true.
app.patch('/admin/module-requests/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null) as { linked_exam_id?: unknown } | null
  if (!body || (body.linked_exam_id !== null && typeof body.linked_exam_id !== 'string')) {
    return c.json({ error: 'linked_exam_id (uuid or null) required' }, 400)
  }

  const sb = getServiceClient()
  const { data, error } = await sb
    .from('module_requests')
    .update({ linked_exam_id: body.linked_exam_id })
    .eq('id', id)
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ request: data })
})

// ----------------------------------------------------------------------------
// Source listing (per module)
// ----------------------------------------------------------------------------

app.get('/admin/sources', async (c) => {
  const moduleSlug = c.req.query('module')
  if (!moduleSlug) return c.json({ error: 'module query param required' }, 400)
  const sb = getServiceClient()
  const { data, error } = await sb
    .from('sources')
    .select('id, code, source_type, week, lecture, title, url, created_at')
    .eq('module', moduleSlug)
    .order('week', { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ sources: data ?? [] })
})

app.delete('/admin/sources/:id', async (c) => {
  const id = c.req.param('id')
  const sb = getServiceClient()
  // source_chunks cascade-delete via FK; if not, do it explicitly first.
  await sb.from('source_chunks').delete().eq('source_id', id)
  const { error } = await sb.from('sources').delete().eq('id', id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

// ----------------------------------------------------------------------------
// Slide deck ingest
// ----------------------------------------------------------------------------

app.post('/admin/sources/slides', async (c) => {
  const form = await c.req.formData()
  const moduleSlug = form.get('module')
  const weekRaw = form.get('week')
  const lectureRaw = form.get('lecture')
  const titleRaw = form.get('title')
  const file = form.get('file')

  if (typeof moduleSlug !== 'string' || !moduleSlug) {
    return c.json({ error: 'module (string) required' }, 400)
  }
  if (typeof weekRaw !== 'string' || !/^\d+$/.test(weekRaw)) {
    return c.json({ error: 'week (integer) required' }, 400)
  }
  if (!(file instanceof File)) {
    return c.json({ error: 'file required' }, 400)
  }
  if (file.size > MAX_PDF_BYTES) {
    return c.json({ error: `PDF too large (max ${MAX_PDF_BYTES} bytes)` }, 413)
  }

  const week = parseInt(weekRaw)
  const lecture = typeof lectureRaw === 'string' && lectureRaw.trim() ? lectureRaw.trim() : undefined
  const title = typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim() : undefined
  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    const user = c.get('user')
    const result = await ingestSlideDeck({
      moduleSlug,
      week,
      lecture,
      title,
      pdfBytes: bytes,
      filename: file.name,
      userId: user?.id ?? null,
    })
    return c.json(result)
  } catch (err) {
    console.error('slide ingest failed:', err)
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ----------------------------------------------------------------------------
// Transcript ingest
// ----------------------------------------------------------------------------

app.post('/admin/sources/transcript', async (c) => {
  const body = await c.req.json()
  const { module: moduleSlug, week, lecture, panopto_url, transcript_text } = body

  if (typeof moduleSlug !== 'string' || !moduleSlug) {
    return c.json({ error: 'module required' }, 400)
  }
  if (typeof week !== 'number') return c.json({ error: 'week (number) required' }, 400)
  if (typeof lecture !== 'string' || !lecture) return c.json({ error: 'lecture required' }, 400)
  if (typeof panopto_url !== 'string' || !panopto_url) {
    return c.json({ error: 'panopto_url required' }, 400)
  }
  if (typeof transcript_text !== 'string' || !transcript_text.trim()) {
    return c.json({ error: 'transcript_text required' }, 400)
  }
  if (transcript_text.length > MAX_TRANSCRIPT_BYTES) {
    return c.json({ error: `transcript too large (max ${MAX_TRANSCRIPT_BYTES} bytes)` }, 413)
  }

  try {
    const user = c.get('user')
    const result = await ingestTranscript({
      moduleSlug,
      week,
      lecture,
      panoptoUrl: panopto_url,
      transcriptText: transcript_text,
      userId: user?.id ?? null,
    })
    return c.json(result)
  } catch (err) {
    console.error('transcript ingest failed:', err)
    return c.json({ error: (err as Error).message }, 500)
  }
})

export default app
