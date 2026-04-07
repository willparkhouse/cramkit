/**
 * CLI wrapper around server/src/lib/slideIngest.ts.
 *
 * Walks data/slides/{MODULE_DIR}/Week{N}.pdf and ingests each one.
 *
 * Run:
 *   npm run ingest:slides --workspace=server
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { ingestSlideDeck } from '../src/lib/slideIngest.js'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const SLIDES_ROOT = join(REPO_ROOT, 'data', 'slides')
const MODULE_SLUG = 'neuralcomp'
const MODULE_DIR = 'nc'

async function main() {
  const moduleSlideDir = join(SLIDES_ROOT, MODULE_DIR)
  const files = readdirSync(moduleSlideDir)
    .filter((f) => /^Week\d+\.pdf$/i.test(f))
    .sort()
  console.log(`Found ${files.length} slide decks in ${moduleSlideDir}`)

  for (const file of files) {
    const week = parseInt(file.match(/Week(\d+)/i)![1])
    console.log(`\n${MODULE_SLUG}-slides-w${week} (${file})`)
    const bytes = readFileSync(join(moduleSlideDir, file))
    const result = await ingestSlideDeck({
      moduleSlug: MODULE_SLUG,
      week,
      pdfBytes: new Uint8Array(bytes),
      filename: file,
    })
    console.log(`  ${result.pages} pages -> ${result.chunks_inserted} chunks`)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
