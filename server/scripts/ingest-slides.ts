/**
 * CLI wrapper around server/src/lib/slideIngest.ts.
 *
 * Walks data/slides/{dir}/ for the chosen module, parses each PDF filename
 * with the module-specific resolver to extract (week, lecture, code, title),
 * uploads + chunks + embeds + ingests each one.
 *
 * Run:
 *   npm run ingest:slides --workspace=server -- --module neuralcomp
 *   npm run ingest:slides --workspace=server -- --module sandn
 *   npm run ingest:slides --workspace=server -- --module advnet
 *
 * cvi has no slides folder, so there's nothing to ingest for that module.
 */
import 'dotenv/config'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { ingestSlideDeck } from '../src/lib/slideIngest.js'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const SLIDES_ROOT = join(REPO_ROOT, 'data', 'slides')

// ----------------------------------------------------------------------------
// Per-module slide config. Each module's resolver inspects a filename and
// returns either:
//   { week, lecture?, code?, title? }    — ingest this file
//   null                                 — skip this file
//
// `code` is optional; slideIngest defaults to `${slug}-slides-w${week}` or
// `${slug}-slides-l${lecture}`. We override when a module has multiple decks
// per week so codes don't collide.
// ----------------------------------------------------------------------------
interface SlideMeta {
  week: number
  lecture?: string
  code?: string
  title?: string
}

interface SlideConfig {
  slidesDir: string
  resolve: (filename: string) => SlideMeta | null
}

/** Slugify a filename stem for use in a stable code. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

const SLIDE_CONFIG: Record<string, SlideConfig> = {
  // Neuralcomp slides are one PDF per week, named "Week{N}.pdf".
  neuralcomp: {
    slidesDir: 'nc',
    resolve: (filename) => {
      const m = filename.match(/^Week(\d+)\.pdf$/i)
      if (!m) return null
      return { week: parseInt(m[1]) }
    },
  },

  // S&N has multiple decks per week, all prefixed "Week N ...". Each deck
  // gets a unique code derived from the filename so they don't collide.
  sandn: {
    slidesDir: 'sandn',
    resolve: (filename) => {
      // Match "Week N <topic>.pdf" or "WeekN <topic>.pdf" (one outlier without
      // the space) — leading week number is the only requirement.
      const m = filename.match(/^Week\s*(\d+)\b(.*)\.pdf$/i)
      if (!m) return null
      const week = parseInt(m[1])
      const topic = m[2].trim().replace(/^[-\s]+/, '')
      const slug = slugify(topic || `w${week}`)
      return {
        week,
        code: `sandn-slides-w${week}-${slug}`,
        title: `Week ${week} ${topic}`.trim(),
      }
    },
  },

  // CVI slides are normalised on disk to "Wk{N}_topic.pdf". Multiple decks
  // per week are common (e.g. Wk2_features_and_dl_part1, Wk2_features_and_dl_part2).
  // Anything that doesn't match the prefix (e.g. "Digital Image Processing.pdf")
  // is skipped — orphaned content can be added by hand later.
  cvi: {
    slidesDir: 'cvi',
    resolve: (filename) => {
      const m = filename.match(/^Wk(\d+)_(.+)\.pdf$/i)
      if (!m) return null
      const week = parseInt(m[1])
      const topic = m[2].trim()
      const slug = slugify(topic)
      return {
        week,
        code: `cvi-slides-w${week}-${slug}`,
        title: `Week ${week} ${topic.replace(/_/g, ' ')}`.trim(),
      }
    },
  },

  // advnet's slides are lecture-numbered (01-07, 12, 13). No clean week
  // mapping — we set week to 0 as a sentinel and use the lecture number for
  // ordering. The "Lecture-NN" and "Net-LectureNN" outliers are normalised.
  // The .small.pdf duplicates and the unnumbered Intro are skipped.
  advnet: {
    slidesDir: 'advnet',
    resolve: (filename) => {
      // Skip the smaller duplicate of "02 Lower Layers - Part One"
      if (/\.small\.pdf$/i.test(filename)) return null

      // Pattern A: leading two-digit number ("01 Introduction.pdf")
      const a = filename.match(/^(\d{2})\s+(.+)\.pdf$/i)
      if (a) {
        const lec = a[1]
        const title = a[2].trim()
        return {
          week: 0,
          lecture: lec,
          code: `advnet-slides-l${lec}`,
          title,
        }
      }
      // Pattern B: "Lecture-NN-Title.pdf" or "Net-Lecture-NN-Title.pdf"
      const b = filename.match(/Lecture[-\s]?(\d+)[-\s]+(.+)\.pdf$/i)
      if (b) {
        const lec = b[1].padStart(2, '0')
        const title = b[2].trim().replace(/-/g, ' ')
        return {
          week: 0,
          lecture: lec,
          code: `advnet-slides-l${lec}`,
          title,
        }
      }
      // Skip anything that doesn't match (e.g. "Advanced Networking Intro.pdf")
      return null
    },
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
  console.error('Usage: tsx scripts/ingest-slides.ts --module <slug>')
  console.error(`Available modules: ${Object.keys(SLIDE_CONFIG).join(', ')}`)
  process.exit(1)
}
const config = SLIDE_CONFIG[MODULE_SLUG]
if (!config) {
  console.error(`Unknown module: ${MODULE_SLUG}`)
  console.error(`Available: ${Object.keys(SLIDE_CONFIG).join(', ')}`)
  process.exit(1)
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const moduleSlideDir = join(SLIDES_ROOT, config.slidesDir)
  if (!existsSync(moduleSlideDir)) {
    console.error(`Slide directory not found: ${moduleSlideDir}`)
    process.exit(1)
  }

  const allFiles = readdirSync(moduleSlideDir).filter((f) => f.toLowerCase().endsWith('.pdf'))
  console.log(`Found ${allFiles.length} PDFs in ${moduleSlideDir}`)

  // Resolve every file via the module's parser; group skipped vs accepted
  const accepted: Array<{ file: string; meta: SlideMeta }> = []
  const skipped: string[] = []
  for (const file of allFiles) {
    const meta = config.resolve(file)
    if (meta) accepted.push({ file, meta })
    else skipped.push(file)
  }
  console.log(`  ${accepted.length} match, ${skipped.length} skipped`)
  if (skipped.length) console.log(`  skipped: ${skipped.join(', ')}`)

  let ok = 0
  let failed = 0
  for (const { file, meta } of accepted) {
    const codeLabel = meta.code ?? `${MODULE_SLUG}-slides-w${meta.week}`
    console.log(`\n${codeLabel} (${file})`)
    const bytes = readFileSync(join(moduleSlideDir, file))
    try {
      const result = await ingestSlideDeck({
        moduleSlug: MODULE_SLUG!,
        week: meta.week,
        lecture: meta.lecture,
        code: meta.code,
        title: meta.title,
        pdfBytes: new Uint8Array(bytes),
        filename: file,
      })
      console.log(`  ${result.pages} pages -> ${result.chunks_inserted} chunks`)
      ok++
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`)
      failed++
    }
  }

  console.log(`\nDone. ${ok} ingested, ${failed} failed, ${skipped.length} skipped.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
