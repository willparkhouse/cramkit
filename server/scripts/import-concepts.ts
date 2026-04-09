/**
 * Import extracted concepts from a JSON file into the `concepts` table.
 *
 * This is the companion to extract-concepts.ts. The extraction script writes
 * to data/extracted-concepts/{module}.json; this script reads that file and
 * upserts the concepts under the admin user (concepts are per-user in the
 * schema, but the admin is the canonical seed source).
 *
 * Idempotent by default: if a concept with the same (admin user, module,
 * name) already exists, it's skipped. Use --replace to delete-and-reinsert
 * for the whole module — WARNING, this cascade-deletes any questions
 * generated on top of those concepts.
 *
 * Required env (server/.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_EMAILS                 (or pass --user-email)
 *
 * Run:
 *   npm run import:concepts --workspace=server -- --module neuralcomp
 *   npm run import:concepts --workspace=server -- --module neuralcomp --dry-run
 *   npm run import:concepts --workspace=server -- --module neuralcomp --replace
 */
import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
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

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(name)
}

const MODULE_SLUG = arg('--module')
const DRY_RUN = flag('--dry-run')
const REPLACE = flag('--replace')
const USER_EMAIL = arg('--user-email') ?? (process.env.ADMIN_EMAILS ?? '').split(',')[0].trim().toLowerCase()
const FILE_OVERRIDE = arg('--file')

if (!MODULE_SLUG) {
  console.error('Usage: tsx scripts/import-concepts.ts --module <slug> [--dry-run] [--replace] [--user-email <email>] [--file <path>]')
  console.error('  --dry-run    : show what would happen, no DB writes')
  console.error('  --replace    : DELETE existing concepts for this module under the admin user, then reinsert.')
  console.error('                 WARNING: cascade-deletes any questions tied to those concepts.')
  console.error('  --user-email : admin email to seed concepts under (defaults to first ADMIN_EMAILS entry)')
  console.error('  --file       : override the input JSON path (default: data/extracted-concepts/{module}.json)')
  process.exit(1)
}
if (!USER_EMAIL) {
  console.error('No admin email available. Set ADMIN_EMAILS env or pass --user-email.')
  process.exit(1)
}

// ----------------------------------------------------------------------------
// JSON shape (must match extract-concepts.ts OutputFile)
// ----------------------------------------------------------------------------
interface ImportConcept {
  name: string
  description: string
  key_facts: string[]
  difficulty: number
  source_chunk_ids: string[]
  week: number | null
  lecture: string | null
}

interface ImportFile {
  module: string
  generated_at: string
  total_concepts: number
  concepts: ImportConcept[]
}

// ----------------------------------------------------------------------------
// Lookups
// ----------------------------------------------------------------------------
async function lookupAdminUserId(email: string): Promise<string> {
  // auth.users is reachable via the admin API (service role required).
  const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(`Failed to list users: ${error.message}`)
  const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (!found) throw new Error(`No auth.users row found for email ${email} — has this user signed in at least once?`)
  return found.id
}

async function lookupExamId(slug: string): Promise<{ id: string; name: string }> {
  const { data, error } = await sb
    .from('exams')
    .select('id, name')
    .eq('slug', slug)
    .single()
  if (error || !data) throw new Error(`No exam row found for slug "${slug}": ${error?.message ?? 'not found'}`)
  return data as { id: string; name: string }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const inputPath = FILE_OVERRIDE ?? join(IN_DIR, `${MODULE_SLUG}.json`)
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`)
    console.error('Run extract-concepts.ts first.')
    process.exit(1)
  }

  console.log(`\nImporting concepts for module: ${MODULE_SLUG}`)
  console.log(`Source: ${inputPath}`)
  console.log(`Admin user: ${USER_EMAIL}`)
  if (DRY_RUN) console.log('Mode: DRY RUN — no DB writes\n')
  else if (REPLACE) console.log('Mode: REPLACE — existing concepts will be deleted (cascades to questions)\n')
  else console.log('Mode: skip-if-exists\n')

  const file = JSON.parse(readFileSync(inputPath, 'utf-8')) as ImportFile
  console.log(`Loaded ${file.concepts.length} concepts (extracted ${file.generated_at})`)

  // Look up admin user and exam id in parallel
  const [userId, exam] = await Promise.all([
    lookupAdminUserId(USER_EMAIL!),
    lookupExamId(MODULE_SLUG!),
  ])
  console.log(`Admin user_id: ${userId}`)
  console.log(`Exam: ${exam.name} (${exam.id})\n`)

  // ─── Replace mode: wipe existing admin concepts for this module ───
  if (REPLACE) {
    const { data: existing, error: fetchErr } = await sb
      .from('concepts')
      .select('id')
      .eq('user_id', userId)
      .contains('module_ids', [exam.id])
    if (fetchErr) throw new Error(`Failed to fetch existing concepts: ${fetchErr.message}`)
    const existingIds = (existing ?? []).map((r) => r.id as string)
    console.log(`Found ${existingIds.length} existing concepts to delete (will cascade to questions)`)
    if (!DRY_RUN && existingIds.length > 0) {
      // Delete in batches in case the list is huge
      const BATCH = 200
      for (let i = 0; i < existingIds.length; i += BATCH) {
        const batch = existingIds.slice(i, i + BATCH)
        const { error: delErr } = await sb.from('concepts').delete().in('id', batch)
        if (delErr) throw new Error(`Failed to delete batch: ${delErr.message}`)
      }
      console.log(`Deleted ${existingIds.length} existing concept(s)`)
    }
  }

  // ─── Skip-if-exists mode: pre-load existing concept names so we can
  //     diff and only insert what's new ───
  let existingNames = new Set<string>()
  if (!REPLACE) {
    const { data: existing, error: fetchErr } = await sb
      .from('concepts')
      .select('name')
      .eq('user_id', userId)
      .contains('module_ids', [exam.id])
    if (fetchErr) throw new Error(`Failed to fetch existing concepts: ${fetchErr.message}`)
    existingNames = new Set((existing ?? []).map((r) => normaliseName(r.name as string)))
    if (existingNames.size > 0) {
      console.log(`Found ${existingNames.size} existing concept(s) under this admin user — these will be skipped`)
    }
  }

  // ─── Build insert rows ───
  const toInsert: Array<Record<string, unknown>> = []
  let skipped = 0
  for (const c of file.concepts) {
    if (!REPLACE && existingNames.has(normaliseName(c.name))) {
      skipped++
      continue
    }
    toInsert.push({
      user_id: userId,
      name: c.name,
      description: c.description,
      key_facts: c.key_facts ?? [],
      module_ids: [exam.id],
      difficulty: clampDifficulty(c.difficulty),
      // Use the first ~3 key facts as the source_excerpt fallback for the
      // chat-grounding UI. The new wrong-answer panel prefers source_chunk_ids
      // over source_excerpt, but we keep this populated for backwards compat.
      source_excerpt: (c.key_facts ?? []).slice(0, 3).join(' · ').slice(0, 500) || c.description.slice(0, 500),
      week: c.week,
      lecture: c.lecture,
      source_chunk_ids: c.source_chunk_ids ?? [],
    })
  }

  console.log(`\nWill insert ${toInsert.length} concept(s) (${skipped} skipped as duplicates)`)

  if (DRY_RUN) {
    console.log('\nDRY RUN — no writes performed')
    if (toInsert.length > 0) {
      console.log('\nFirst 5 to insert:')
      for (const row of toInsert.slice(0, 5)) {
        console.log(`  · ${row.name} (week ${row.week}, ${(row.key_facts as string[]).length} facts)`)
      }
    }
    return
  }

  // ─── Insert in batches ───
  if (toInsert.length === 0) {
    console.log('Nothing to insert.')
    return
  }
  const BATCH = 100
  let inserted = 0
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH)
    const { error } = await sb.from('concepts').insert(batch)
    if (error) {
      console.error(`Insert failed at batch ${i}-${i + batch.length}:`, error.message)
      throw error
    }
    inserted += batch.length
    process.stdout.write(`  inserted ${inserted}/${toInsert.length}\r`)
  }
  process.stdout.write('\n')
  console.log(`\n✓ Imported ${inserted} concept(s) for ${MODULE_SLUG}`)
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function clampDifficulty(d: number | undefined): number {
  if (typeof d !== 'number' || isNaN(d)) return 3
  return Math.max(1, Math.min(5, Math.round(d)))
}

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
