/**
 * Ingest slide PDFs into Supabase pgvector for RAG.
 *
 * For each Week{N}.pdf in data/slides/{module}/:
 *   1. Upload the PDF to Supabase Storage (public bucket `learning-materials`)
 *      so the client can deep-link into it via #page=N.
 *   2. Extract text per page with pdfjs-dist.
 *   3. Group adjacent slides into ~3-slide windows (1-slide overlap) so each
 *      embedded chunk has enough text to be useful — individual slides are
 *      often only a few words.
 *   4. Embed with OpenAI text-embedding-3-small.
 *   5. Upsert into the unified `sources` + `source_chunks` tables with
 *      source_type='slides' and locator={start_page, end_page}.
 *
 * Required env (server/.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   OPENAI_API_KEY
 *
 * Run:
 *   npm run ingest:slides --workspace=server
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const SLIDES_ROOT = join(REPO_ROOT, 'data', 'slides')
const MODULE = 'neuralcomp'   // only NC for now; loop over modules later
const MODULE_DIR = 'nc'
const STORAGE_BUCKET = 'learning-materials'

const SLIDES_PER_CHUNK = 3
const SLIDE_OVERLAP = 1

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

// ----------------------------------------------------------------------------
// PDF text extraction
// ----------------------------------------------------------------------------
interface SlidePage {
  pageNumber: number
  text: string
}

async function extractPages(pdfBytes: Uint8Array): Promise<SlidePage[]> {
  const loadingTask = pdfjs.getDocument({ data: pdfBytes })
  const doc = await loadingTask.promise
  const pages: SlidePage[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      // pdfjs TextItem objects have a `str` field
      .map((item) => ('str' in item ? (item as { str: string }).str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    pages.push({ pageNumber: i, text })
  }
  await doc.cleanup()
  return pages
}

// ----------------------------------------------------------------------------
// Chunking: sliding 3-slide windows with 1-slide overlap.
// Skips slides that are essentially empty (title-only, image-only).
// ----------------------------------------------------------------------------
interface Chunk {
  index: number
  startPage: number
  endPage: number
  text: string
}

function chunkSlides(pages: SlidePage[]): Chunk[] {
  const usable = pages.filter((p) => p.text.length >= 20)
  if (usable.length === 0) return []
  const chunks: Chunk[] = []
  let i = 0
  let chunkIndex = 0
  while (i < usable.length) {
    const window = usable.slice(i, i + SLIDES_PER_CHUNK)
    const text = window
      .map((p) => `[Slide ${p.pageNumber}] ${p.text}`)
      .join('\n')
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

// ----------------------------------------------------------------------------
// Storage upload
// ----------------------------------------------------------------------------
async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets()
  if (buckets?.some((b) => b.name === STORAGE_BUCKET)) return
  const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, {
    public: true,
  })
  if (error) throw new Error(`Failed to create bucket: ${error.message}`)
  console.log(`Created public bucket "${STORAGE_BUCKET}"`)
}

async function uploadPdf(localPath: string, storagePath: string): Promise<string> {
  const bytes = readFileSync(localPath)
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, {
      contentType: 'application/pdf',
      upsert: true,
    })
  if (error) throw new Error(`Upload failed for ${storagePath}: ${error.message}`)
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
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
  await ensureBucket()

  const moduleSlideDir = join(SLIDES_ROOT, MODULE_DIR)
  const files = readdirSync(moduleSlideDir)
    .filter((f) => /^Week\d+\.pdf$/i.test(f))
    .sort()
  console.log(`Found ${files.length} slide decks in ${moduleSlideDir}`)

  for (const file of files) {
    const week = parseInt(file.match(/Week(\d+)/i)![1])
    const code = `${MODULE}-slides-w${week}`
    console.log(`\n${code} (${file})`)

    // Upload to storage and get the public URL
    const storagePath = `slides/${MODULE_DIR}/${file}`
    const publicUrl = await uploadPdf(join(moduleSlideDir, file), storagePath)

    // Extract pages
    const bytes = readFileSync(join(moduleSlideDir, file))
    const pages = await extractPages(new Uint8Array(bytes))
    const chunks = chunkSlides(pages)
    console.log(`  ${pages.length} slides -> ${chunks.length} chunks`)

    if (chunks.length === 0) continue

    // Upsert source row
    const { data: sourceRow, error: srcErr } = await supabase
      .from('sources')
      .upsert(
        {
          module: MODULE,
          source_type: 'slides',
          code,
          week,
          lecture: null,
          title: `Week ${week} slides`,
          url: publicUrl,
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

    // Wipe existing chunks (idempotent re-runs)
    await supabase.from('source_chunks').delete().eq('source_id', sourceId)

    // Embed
    const embeddings = await embedAll(chunks.map((c) => c.text))

    const rows = chunks.map((c, i) => ({
      source_id: sourceId,
      chunk_index: c.index,
      locator: { start_page: c.startPage, end_page: c.endPage },
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
