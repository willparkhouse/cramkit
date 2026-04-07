/**
 * Ingest lecture transcripts into Supabase pgvector for RAG.
 *
 * Reads data/transcripts/panopto.csv (lecture -> Panopto URL manifest) and
 * the matching nc{week}.{lecture}.txt files, splits them into ~60s chunks,
 * embeds them with OpenAI text-embedding-3-small, and upserts into the
 * unified `sources` + `source_chunks` tables (source_type='lecture').
 *
 * One-shot script. Re-running is idempotent (delete + reinsert per lecture).
 *
 * Required env (in server/.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY    <- add this, do NOT commit
 *   OPENAI_API_KEY
 *
 * Run from repo root:
 *   npm run ingest:transcripts --workspace=server
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const TRANSCRIPT_DIR = join(REPO_ROOT, 'data', 'transcripts', 'nc')
const MANIFEST_PATH = join(REPO_ROOT, 'data', 'transcripts', 'panopto.csv')
const MODULE = 'neuralcomp'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY

if (!SUPABASE_URL || !SERVICE_KEY || !OPENAI_KEY) {
  console.error('Missing required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})
const openai = new OpenAI({ apiKey: OPENAI_KEY })

interface ManifestRow {
  module: string
  week: number
  lecture: string  // "1", "2", "extra"
  url: string
}

interface ParsedLine {
  seconds: number
  speaker: string | null
  text: string
}

interface Chunk {
  index: number
  start: number
  end: number
  text: string  // includes speaker prefixes for grounding
}

// ----------------------------------------------------------------------------
// Manifest parsing
// ----------------------------------------------------------------------------
function parseManifest(): ManifestRow[] {
  const raw = readFileSync(MANIFEST_PATH, 'utf-8')
  const lines = raw.trim().split('\n').slice(1) // skip header
  const rows: ManifestRow[] = []
  let currentModule = MODULE
  for (const line of lines) {
    const [mod, week, lecture, url] = line.split(',')
    if (mod) currentModule = mod
    if (!url) continue
    rows.push({
      module: currentModule,
      week: parseInt(week),
      lecture: lecture.trim(),
      url: url.trim(),
    })
  }
  return rows
}

// Map manifest lecture id to the file on disk.
// "extra" for week 3 corresponds to nc3.4.txt.
function transcriptFileFor(week: number, lecture: string): string | null {
  const lectureNum = lecture === 'extra' ? '4' : lecture
  const candidate = `nc${week}.${lectureNum}.txt`
  const exists = readdirSync(TRANSCRIPT_DIR).includes(candidate)
  return exists ? candidate : null
}

// Lecture code stored in DB matches the actual filename stem (stable).
function lectureCodeFor(week: number, lecture: string): string {
  const lectureNum = lecture === 'extra' ? '4' : lecture
  return `nc${week}.${lectureNum}`
}

// ----------------------------------------------------------------------------
// Transcript parsing + chunking
// ----------------------------------------------------------------------------
function parseTimestamp(ts: string): number {
  // Accepts m:ss or h:mm:ss
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

// Sliding ~60s windows with ~15s overlap. Each chunk's start_seconds is
// the timestamp of its first line — that's the Panopto deep-link target.
const TARGET_CHUNK_SECONDS = 60
const OVERLAP_SECONDS = 15

function chunkLines(lines: ParsedLine[]): Chunk[] {
  if (lines.length === 0) return []
  const chunks: Chunk[] = []
  let i = 0
  let chunkIndex = 0
  while (i < lines.length) {
    const start = lines[i].seconds
    let j = i
    while (j < lines.length && lines[j].seconds - start < TARGET_CHUNK_SECONDS) j++
    if (j === i) j = i + 1  // safety: ensure progress
    const slice = lines.slice(i, j)
    const end = slice[slice.length - 1].seconds
    const body = slice
      .map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text))
      .join(' ')
    chunks.push({ index: chunkIndex++, start, end, text: body })

    if (j >= lines.length) break
    // Advance i so the next chunk starts ~OVERLAP_SECONDS before current end
    const nextStartTime = end - OVERLAP_SECONDS
    let next = j
    while (next > i + 1 && lines[next - 1].seconds > nextStartTime) next--
    i = Math.max(next, i + 1)
  }
  return chunks
}

// ----------------------------------------------------------------------------
// Embedding (batched)
// ----------------------------------------------------------------------------
async function embedAll(texts: string[]): Promise<number[][]> {
  const BATCH = 100
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
    })
    for (const item of res.data) out.push(item.embedding)
    process.stdout.write(`    embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}\r`)
  }
  process.stdout.write('\n')
  return out
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const manifest = parseManifest()
  console.log(`Manifest: ${manifest.length} lectures`)

  for (const row of manifest) {
    const file = transcriptFileFor(row.week, row.lecture)
    const code = lectureCodeFor(row.week, row.lecture)
    if (!file) {
      console.warn(`  ${code}: no transcript file found, skipping`)
      continue
    }

    console.log(`\n${code} (${file})`)

    const text = readFileSync(join(TRANSCRIPT_DIR, file), 'utf-8')
    const lines = parseTranscript(text)
    const chunks = chunkLines(lines)
    console.log(`  ${lines.length} lines -> ${chunks.length} chunks`)

    if (chunks.length === 0) continue

    // Upsert source row, get id
    const { data: sourceRow, error: srcErr } = await supabase
      .from('sources')
      .upsert(
        {
          module: row.module,
          source_type: 'lecture',
          code,
          week: row.week,
          lecture: row.lecture,
          url: row.url,
        },
        { onConflict: 'code' }
      )
      .select('id')
      .single()
    if (srcErr || !sourceRow) {
      console.error(`  failed to upsert source ${code}:`, srcErr)
      continue
    }
    const sourceId = sourceRow.id

    // Wipe existing chunks for this source (idempotent re-runs)
    await supabase.from('source_chunks').delete().eq('source_id', sourceId)

    // Embed
    const embeddings = await embedAll(chunks.map((c) => c.text))

    // Bulk insert
    const rows = chunks.map((c, i) => ({
      source_id: sourceId,
      chunk_index: c.index,
      locator: { start_seconds: c.start, end_seconds: c.end },
      text: c.text,
      embedding: embeddings[i],
    }))
    const INSERT_BATCH = 100
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH)
      const { error } = await supabase.from('source_chunks').insert(batch)
      if (error) {
        console.error(`  insert failed for ${code}:`, error)
        break
      }
    }
    console.log(`  inserted ${rows.length} chunks`)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
