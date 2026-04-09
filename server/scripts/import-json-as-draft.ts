/**
 * Bridge: import an existing data/extracted-concepts/{module}.json file into
 * the extracted_concepts table as a `ready` draft.
 *
 * Use case: you ran extract-concepts.ts (CLI) before the admin pipeline UI
 * existed, and you don't want to pay to re-extract. This script reads the
 * JSON output and inserts it as a draft so the admin Pipeline tab can
 * promote it like any other draft.
 *
 * The script is idempotent in the sense that it always inserts a NEW row —
 * it doesn't try to merge with existing drafts. If you've already imported
 * the same JSON, you'll get a duplicate; discard the older one in the UI.
 *
 * Run:
 *   npm run import:draft --workspace=server -- --module sandn
 *   npm run import:draft --workspace=server -- --module cvi
 *   npm run import:draft --workspace=server -- --module sandn --file path/to/custom.json
 */
import 'dotenv/config'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const IN_DIR = join(REPO_ROOT, 'data', 'extracted-concepts')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const MODULE_SLUG = arg('--module')
const FILE_OVERRIDE = arg('--file')
const COVERAGE_FILE_OVERRIDE = arg('--coverage')

if (!MODULE_SLUG) {
  console.error('Usage: tsx scripts/import-json-as-draft.ts --module <slug> [--file path] [--coverage path]')
  process.exit(1)
}

interface ImportFile {
  module: string
  generated_at: string
  total_concepts: number
  by_week: Record<string, number>
  concepts: Array<{
    name: string
    description: string
    key_facts: string[]
    difficulty: number
    source_chunk_ids: string[]
    week: number | null
    lecture: string | null
  }>
  // The CLI's runExtraction now embeds coverage_report in the payload, but
  // older runs wrote it to a sibling .coverage-gaps.txt file. Support both.
  coverage_report?: string | null
}

async function main() {
  const inputPath = FILE_OVERRIDE ?? join(IN_DIR, `${MODULE_SLUG}.json`)
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`)
    process.exit(1)
  }

  const file = JSON.parse(readFileSync(inputPath, 'utf-8')) as ImportFile

  // Try to load coverage gaps from a sibling .txt file if not embedded in JSON
  let coverageReport: string | null = file.coverage_report ?? null
  if (!coverageReport) {
    const coverageFile = COVERAGE_FILE_OVERRIDE ?? join(IN_DIR, `${MODULE_SLUG}.coverage-gaps.txt`)
    if (existsSync(coverageFile)) {
      coverageReport = readFileSync(coverageFile, 'utf-8')
    }
  }

  // Build the payload exactly as the admin extraction route would.
  const payload = {
    module: file.module ?? MODULE_SLUG,
    generated_at: file.generated_at ?? new Date().toISOString(),
    total_concepts: file.concepts.length,
    by_week: file.by_week ?? {},
    concepts: file.concepts,
    coverage_report: coverageReport,
  }

  console.log(`Importing draft for ${MODULE_SLUG}`)
  console.log(`  source: ${inputPath}`)
  console.log(`  concepts: ${payload.total_concepts}`)
  console.log(`  weeks: ${Object.keys(payload.by_week).join(', ')}`)
  console.log(`  coverage report: ${coverageReport ? 'yes' : 'no'}`)

  const { data, error } = await sb
    .from('extracted_concepts')
    .insert({
      module: MODULE_SLUG,
      status: 'ready',
      payload,
      coverage_report: coverageReport,
      progress: {
        weeks_total: Object.keys(payload.by_week).length,
        weeks_done: Object.keys(payload.by_week).length,
      },
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('Insert failed:', error?.message ?? 'unknown')
    process.exit(1)
  }
  console.log(`\n✓ Imported as draft ${data.id}`)
  console.log('Open Admin → Pipeline to promote it.')
}

main().catch((err) => {
  console.error('\nFatal:', err)
  process.exit(1)
})
