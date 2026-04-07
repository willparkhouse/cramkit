/**
 * Reusable transcript ingest: parses a timestamped lecture transcript, chunks
 * into ~60s windows with ~15s overlap, embeds, and upserts into the unified
 * `sources` + `source_chunks` tables.
 *
 * Used by both the CLI script (server/scripts/ingest-transcripts.ts) and the
 * admin API route (POST /api/admin/sources/transcript).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { recordUsage } from './usage.js'

const TARGET_CHUNK_SECONDS = 60
const OVERLAP_SECONDS = 15

interface ParsedLine {
  seconds: number
  speaker: string | null
  text: string
}

interface TranscriptChunk {
  index: number
  start: number
  end: number
  text: string
}

export interface IngestTranscriptOpts {
  moduleSlug: string
  week: number
  /** Lecture identifier within the week (e.g. "1", "2", "extra"). */
  lecture: string
  panoptoUrl: string
  transcriptText: string
  /** Optional override for the source code stored in DB. Defaults to `${slug}${week}.${lecture}` (mirrors NC convention). */
  code?: string
  /** User who initiated the ingest (for usage tracking). Null for CLI scripts. */
  userId?: string | null
}

export interface IngestTranscriptResult {
  source_id: string
  code: string
  lines: number
  chunks_inserted: number
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

function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map((n) => parseInt(n))
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

function parseTranscript(text: string): ParsedLine[] {
  const lines: ParsedLine[] = []
  const re = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(?:([^:]+?):\s*)?(.*)$/
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const m = trimmed.match(re)
    if (!m) continue
    const [, ts, speaker, body] = m
    if (!body) continue
    lines.push({
      seconds: parseTimestamp(ts),
      speaker: speaker?.trim() || null,
      text: body.trim(),
    })
  }
  return lines
}

function chunkLines(lines: ParsedLine[]): TranscriptChunk[] {
  if (lines.length === 0) return []
  const chunks: TranscriptChunk[] = []
  let i = 0
  let chunkIndex = 0
  while (i < lines.length) {
    const start = lines[i].seconds
    let j = i
    while (j < lines.length && lines[j].seconds - start < TARGET_CHUNK_SECONDS) j++
    if (j === i) j = i + 1
    const slice = lines.slice(i, j)
    const end = slice[slice.length - 1].seconds
    const body = slice
      .map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text))
      .join(' ')
    chunks.push({ index: chunkIndex++, start, end, text: body })

    if (j >= lines.length) break
    const nextStartTime = end - OVERLAP_SECONDS
    let next = j
    while (next > i + 1 && lines[next - 1].seconds > nextStartTime) next--
    i = Math.max(next, i + 1)
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
      endpoint: 'ingest-transcript',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
      meta: { module: ctx.moduleSlug, batch_size: batch.length },
    })
  }
  return out
}

export async function ingestTranscript(opts: IngestTranscriptOpts): Promise<IngestTranscriptResult> {
  const { supabase, openai } = getClients()
  const code = opts.code ?? `${opts.moduleSlug.replace(/[^a-z]/g, '')}${opts.week}.${opts.lecture === 'extra' ? '4' : opts.lecture}`

  const lines = parseTranscript(opts.transcriptText)
  const chunks = chunkLines(lines)
  if (chunks.length === 0) {
    return { source_id: '', code, lines: lines.length, chunks_inserted: 0 }
  }

  const { data: sourceRow, error: srcErr } = await supabase
    .from('sources')
    .upsert(
      {
        module: opts.moduleSlug,
        source_type: 'lecture',
        code,
        week: opts.week,
        lecture: opts.lecture,
        url: opts.panoptoUrl,
      },
      { onConflict: 'code' }
    )
    .select('id')
    .single()
  if (srcErr || !sourceRow) {
    throw new Error(`Failed to upsert source ${code}: ${srcErr?.message ?? 'unknown'}`)
  }
  const sourceId = sourceRow.id as string

  await supabase.from('source_chunks').delete().eq('source_id', sourceId)

  const embeddings = await embedAll(openai, chunks.map((c) => c.text), {
    userId: opts.userId ?? null,
    moduleSlug: opts.moduleSlug,
  })

  const rows = chunks.map((c, i) => ({
    source_id: sourceId,
    chunk_index: c.index,
    locator: { start_seconds: c.start, end_seconds: c.end },
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

  return { source_id: sourceId, code, lines: lines.length, chunks_inserted: inserted }
}
