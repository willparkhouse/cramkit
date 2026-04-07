/**
 * Reusable slide ingest: takes a PDF byte buffer, uploads it to Storage,
 * extracts page text, chunks into 3-slide windows, embeds, and upserts into
 * the unified `sources` + `source_chunks` tables.
 *
 * Used by both the CLI script (server/scripts/ingest-slides.ts) and the
 * admin API route (POST /api/admin/sources/slides).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { recordUsage } from './usage.js'

const STORAGE_BUCKET = 'learning-materials'
const SLIDES_PER_CHUNK = 3
const SLIDE_OVERLAP = 1
const MAX_CHUNK_CHARS = 8000

interface SlidePage {
  pageNumber: number
  text: string
}

interface SlideChunk {
  index: number
  startPage: number
  endPage: number
  text: string
}

export interface IngestSlideDeckOpts {
  moduleSlug: string
  week: number
  pdfBytes: Uint8Array
  /** Original filename, used as the storage path leaf (e.g. "13.1 EMV Lecture.pdf"). */
  filename: string
  /**
   * Lecture id this deck covers (e.g. "1", "13.1", "1+2" for multi-lecture decks).
   * If omitted, the deck is treated as a week-level deck.
   */
  lecture?: string
  /** Optional human title. Defaults to filename (without extension). */
  title?: string
  /** Optional override for the source code. Defaults to `${slug}-slides-l${lecture}` or `${slug}-slides-w${week}`. */
  code?: string
  /** User who initiated the ingest (for usage tracking). Null for CLI scripts. */
  userId?: string | null
}

export interface IngestSlideDeckResult {
  source_id: string
  code: string
  pages: number
  chunks_inserted: number
  public_url: string
}

function getClients(): { supabase: SupabaseClient; openai: OpenAI } {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  const OPENAI_KEY = process.env.OPENAI_API_KEY
  if (!SUPABASE_URL || !SERVICE_KEY || !OPENAI_KEY) {
    throw new Error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY')
  }
  return {
    supabase: createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }),
    openai: new OpenAI({ apiKey: OPENAI_KEY }),
  }
}

async function ensureBucket(supabase: SupabaseClient): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets()
  if (buckets?.some((b) => b.name === STORAGE_BUCKET)) return
  const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: true })
  if (error) throw new Error(`Failed to create bucket: ${error.message}`)
}

async function uploadPdf(
  supabase: SupabaseClient,
  bytes: Uint8Array,
  storagePath: string
): Promise<string> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true })
  if (error) throw new Error(`Upload failed for ${storagePath}: ${error.message}`)
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

async function extractPages(pdfBytes: Uint8Array): Promise<SlidePage[]> {
  const loadingTask = pdfjs.getDocument({ data: pdfBytes })
  const doc = await loadingTask.promise
  const pages: SlidePage[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? (item as { str: string }).str : ''))
      .join(' ')
      // Strip C0 control chars — Postgres text rejects \u0000.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    pages.push({ pageNumber: i, text })
  }
  await doc.cleanup()
  return pages
}

function chunkSlides(pages: SlidePage[]): SlideChunk[] {
  const usable = pages.filter((p) => p.text.length >= 20)
  if (usable.length === 0) return []
  const chunks: SlideChunk[] = []
  let i = 0
  let chunkIndex = 0
  while (i < usable.length) {
    const window = usable.slice(i, i + SLIDES_PER_CHUNK)
    const rawText = window.map((p) => `[Slide ${p.pageNumber}] ${p.text}`).join('\n')
    const text = rawText.length > MAX_CHUNK_CHARS ? rawText.slice(0, MAX_CHUNK_CHARS) : rawText
    chunks.push({
      index: chunkIndex++,
      startPage: window[0].pageNumber,
      endPage: window[window.length - 1].pageNumber,
      text,
    })
    if (i + SLIDES_PER_CHUNK >= usable.length) break
    i += SLIDES_PER_CHUNK - SLIDE_OVERLAP
  }
  return chunks
}

async function embedAll(
  openai: OpenAI,
  texts: string[],
  ctx: { userId: string | null; moduleSlug: string }
): Promise<number[][]> {
  const BATCH = 100
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: batch })
    for (const item of res.data) out.push(item.embedding)
    void recordUsage({
      userId: ctx.userId,
      provider: 'openai',
      model: 'text-embedding-3-small',
      endpoint: 'ingest-slides',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
      meta: { module: ctx.moduleSlug, batch_size: batch.length },
    })
  }
  return out
}

export async function ingestSlideDeck(opts: IngestSlideDeckOpts): Promise<IngestSlideDeckResult> {
  const { supabase, openai } = getClients()
  // Lecture-based code when a lecture id is provided (matches the SRWS-style
  // "13.1 EMV Lecture.pdf" naming where slides belong to lectures, not weeks).
  // Falls back to the legacy week-based code when no lecture id is given.
  const lectureSlug = opts.lecture?.trim().replace(/\s+/g, '-')
  const code = opts.code ?? (lectureSlug
    ? `${opts.moduleSlug}-slides-l${lectureSlug}`
    : `${opts.moduleSlug}-slides-w${opts.week}`)
  const title = opts.title ?? opts.filename.replace(/\.pdf$/i, '')

  await ensureBucket(supabase)

  const storagePath = `slides/${opts.moduleSlug}/${opts.filename}`
  const publicUrl = await uploadPdf(supabase, opts.pdfBytes, storagePath)

  const pages = await extractPages(opts.pdfBytes)
  const chunks = chunkSlides(pages)
  if (chunks.length === 0) {
    return { source_id: '', code, pages: pages.length, chunks_inserted: 0, public_url: publicUrl }
  }

  const { data: sourceRow, error: srcErr } = await supabase
    .from('sources')
    .upsert(
      {
        module: opts.moduleSlug,
        source_type: 'slides',
        code,
        week: opts.week,
        lecture: opts.lecture ?? null,
        title,
        url: publicUrl,
      },
      { onConflict: 'code' }
    )
    .select('id')
    .single()
  if (srcErr || !sourceRow) {
    throw new Error(`Failed to upsert source ${code}: ${srcErr?.message ?? 'unknown'}`)
  }
  const sourceId = sourceRow.id as string

  // Idempotent re-runs
  await supabase.from('source_chunks').delete().eq('source_id', sourceId)

  const embeddings = await embedAll(openai, chunks.map((c) => c.text), {
    userId: opts.userId ?? null,
    moduleSlug: opts.moduleSlug,
  })

  const rows = chunks.map((c, i) => ({
    source_id: sourceId,
    chunk_index: c.index,
    locator: { start_page: c.startPage, end_page: c.endPage },
    text: c.text,
    embedding: embeddings[i],
  }))

  const INSERT_BATCH = 100
  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH)
    const { error } = await supabase.from('source_chunks').insert(batch)
    if (error) throw new Error(`Insert failed for ${code}: ${error.message}`)
    inserted += batch.length
  }

  return {
    source_id: sourceId,
    code,
    pages: pages.length,
    chunks_inserted: inserted,
    public_url: publicUrl,
  }
}
