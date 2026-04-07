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

  return c.json({
    modules: (exams ?? []).map((e) => ({
      ...e,
      coverage: coverageBySlug.get(e.slug) ?? { slide_decks: 0, lectures: 0, chunks: 0 },
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
  const { data, error } = await sb
    .from('exams')
    .insert({ name: name.trim(), slug, date, weight, semester })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ module: data })
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
