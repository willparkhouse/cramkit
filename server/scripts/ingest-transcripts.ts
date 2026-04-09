/**
 * CLI wrapper around server/src/lib/transcriptIngest.ts.
 *
 * Reads data/transcripts/panopto.csv and the matching transcript text files,
 * then ingests each one into the unified `sources` + `source_chunks` tables.
 *
 * Run:
 *   npm run ingest:transcripts --workspace=server -- --module neuralcomp
 *   npm run ingest:transcripts --workspace=server -- --module sandn
 *   npm run ingest:transcripts --workspace=server -- --module cvi
 *   npm run ingest:transcripts --workspace=server -- --module advnet
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { ingestTranscript } from '../src/lib/transcriptIngest.js'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const MANIFEST_PATH = join(REPO_ROOT, 'data', 'transcripts', 'panopto.csv')

// ----------------------------------------------------------------------------
// Per-module config — maps a target slug to:
//  - csvModuleName: how the module is labelled in panopto.csv (case-sensitive)
//  - transcriptDir: subfolder under data/transcripts/
//  - transcriptPrefix: filename prefix used by the transcript files in that
//    folder. Files are named `{prefix}{week}.{lecture}.txt`.
//
// To add a new module, add an entry here. The script trusts the CSV for the
// canonical (week, lecture, panopto_url) tuples.
// ----------------------------------------------------------------------------
interface ModuleConfig {
  csvModuleName: string
  transcriptDir: string
  transcriptPrefix: string
  /** Per-row file resolver. Defaults to `{prefix}{week}.{lecture}.txt`. */
  resolveFile?: (week: number, lecture: string) => string
}

const MODULE_CONFIG: Record<string, ModuleConfig> = {
  neuralcomp: {
    csvModuleName: 'neuralcomp',
    transcriptDir: 'nc',
    transcriptPrefix: 'nc',
    // NC's CSV uses "extra" for the optional week-3 bonus lecture but the
    // file on disk is nc3.4.txt
    resolveFile: (week, lecture) => {
      const lec = lecture === 'extra' ? '4' : lecture
      return `nc${week}.${lec}.txt`
    },
  },
  sandn: {
    csvModuleName: 'security and networks',
    transcriptDir: 'sandn',
    transcriptPrefix: 'sec',
  },
  cvi: {
    csvModuleName: 'Computer Vision & Imaging',
    transcriptDir: 'CVI',
    transcriptPrefix: 'cvi',
  },
  advnet: {
    csvModuleName: 'advanced Networking',
    transcriptDir: 'advnet',
    transcriptPrefix: 'advnet',
  },
}

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const MODULE_SLUG = arg('--module')
if (!MODULE_SLUG) {
  console.error('Usage: tsx scripts/ingest-transcripts.ts --module <slug>')
  console.error(`Available modules: ${Object.keys(MODULE_CONFIG).join(', ')}`)
  process.exit(1)
}
const config = MODULE_CONFIG[MODULE_SLUG]
if (!config) {
  console.error(`Unknown module: ${MODULE_SLUG}`)
  console.error(`Available: ${Object.keys(MODULE_CONFIG).join(', ')}`)
  process.exit(1)
}

const TRANSCRIPT_DIR = join(REPO_ROOT, 'data', 'transcripts', config.transcriptDir)

// ----------------------------------------------------------------------------
// CSV parsing — first column is the module name (sticky: empty rows inherit
// the previous non-empty module). We filter to only the rows belonging to
// our target module.
// ----------------------------------------------------------------------------
interface ManifestRow {
  week: number
  lecture: string
  url: string
}

function parseManifest(): ManifestRow[] {
  const raw = readFileSync(MANIFEST_PATH, 'utf-8')
  const lines = raw.trim().split('\n').slice(1) // skip header
  const rows: ManifestRow[] = []
  let currentModule = ''
  for (const line of lines) {
    const [mod, weekStr, lecture, url] = line.split(',')
    if (mod && mod.trim()) currentModule = mod.trim()
    if (currentModule !== config.csvModuleName) continue
    if (!url || url.trim() === '' || url.trim() === 'N/A') continue
    const week = parseInt(weekStr)
    if (isNaN(week)) continue
    rows.push({
      week,
      lecture: lecture.trim(),
      url: url.trim(),
    })
  }
  return rows
}

function transcriptFileFor(week: number, lecture: string): string | null {
  const candidate = config.resolveFile
    ? config.resolveFile(week, lecture)
    : `${config.transcriptPrefix}${week}.${lecture}.txt`
  const exists = readdirSync(TRANSCRIPT_DIR).includes(candidate)
  return exists ? candidate : null
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const manifest = parseManifest()
  console.log(`Module: ${MODULE_SLUG} (csv: "${config.csvModuleName}")`)
  console.log(`Manifest: ${manifest.length} lecture(s)\n`)

  if (manifest.length === 0) {
    console.error(`No rows found for "${config.csvModuleName}" in ${MANIFEST_PATH}`)
    process.exit(1)
  }

  let ok = 0
  let skipped = 0
  for (const row of manifest) {
    const file = transcriptFileFor(row.week, row.lecture)
    if (!file) {
      console.warn(`  week ${row.week} lec ${row.lecture}: no transcript file found, skipping`)
      skipped++
      continue
    }
    console.log(`\nweek ${row.week} lec ${row.lecture} (${file})`)
    const text = readFileSync(join(TRANSCRIPT_DIR, file), 'utf-8')
    try {
      const result = await ingestTranscript({
        moduleSlug: MODULE_SLUG!,
        week: row.week,
        lecture: row.lecture,
        panoptoUrl: row.url,
        transcriptText: text,
      })
      console.log(`  ${result.lines} lines -> ${result.chunks_inserted} chunks`)
      ok++
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`)
      skipped++
    }
  }

  console.log(`\nDone. ${ok} ingested, ${skipped} skipped.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
