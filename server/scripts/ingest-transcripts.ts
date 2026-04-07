/**
 * CLI wrapper around server/src/lib/transcriptIngest.ts.
 *
 * Reads data/transcripts/panopto.csv (lecture -> Panopto URL manifest) and
 * the matching nc{week}.{lecture}.txt files, then ingests each one.
 *
 * Run:
 *   npm run ingest:transcripts --workspace=server
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { ingestTranscript } from '../src/lib/transcriptIngest.js'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const TRANSCRIPT_DIR = join(REPO_ROOT, 'data', 'transcripts', 'nc')
const MANIFEST_PATH = join(REPO_ROOT, 'data', 'transcripts', 'panopto.csv')
const MODULE_SLUG = 'neuralcomp'

interface ManifestRow {
  module: string
  week: number
  lecture: string
  url: string
}

function parseManifest(): ManifestRow[] {
  const raw = readFileSync(MANIFEST_PATH, 'utf-8')
  const lines = raw.trim().split('\n').slice(1)
  const rows: ManifestRow[] = []
  let currentModule = MODULE_SLUG
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

function transcriptFileFor(week: number, lecture: string): string | null {
  const lectureNum = lecture === 'extra' ? '4' : lecture
  const candidate = `nc${week}.${lectureNum}.txt`
  const exists = readdirSync(TRANSCRIPT_DIR).includes(candidate)
  return exists ? candidate : null
}

async function main() {
  const manifest = parseManifest()
  console.log(`Manifest: ${manifest.length} lectures`)

  for (const row of manifest) {
    const file = transcriptFileFor(row.week, row.lecture)
    if (!file) {
      console.warn(`  week ${row.week} ${row.lecture}: no transcript file found, skipping`)
      continue
    }
    console.log(`\nweek ${row.week} ${row.lecture} (${file})`)
    const text = readFileSync(join(TRANSCRIPT_DIR, file), 'utf-8')
    const result = await ingestTranscript({
      moduleSlug: row.module,
      week: row.week,
      lecture: row.lecture,
      panoptoUrl: row.url,
      transcriptText: text,
    })
    console.log(`  ${result.lines} lines -> ${result.chunks_inserted} chunks`)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
