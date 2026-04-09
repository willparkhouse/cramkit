/**
 * Promote an extracted_concepts draft into the live concepts table.
 *
 * Two modes mirror the CLI's --replace flag:
 *   - "skip"     : skip-if-exists by name. Default. Safe additive merge.
 *   - "replace"  : delete all existing concepts for this module under the
 *                  admin user, then insert. CASCADE-DELETES questions and
 *                  knowledge rows tied to those concepts. Use with care.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { ExtractedConceptWithLocation, ExtractionResult } from './conceptExtraction.js'

function getServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  return createClient(url, key, { auth: { persistSession: false } })
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function clampDifficulty(d: number | undefined): number {
  if (typeof d !== 'number' || isNaN(d)) return 3
  return Math.max(1, Math.min(5, Math.round(d)))
}

// Standard 8-4-4-4-12 UUID v4 shape. The model occasionally hallucinates
// chunk IDs with the wrong segment lengths (e.g. "4df3f" instead of "4df3"),
// and Postgres rejects the whole insert when any uuid[] entry is malformed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function filterValidUuids(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x))
}

export interface PromoteOptions {
  /** extracted_concepts row id to promote. */
  draftId: string
  /** Admin user id who owns the concepts (concepts are per-user in the schema). */
  ownerUserId: string
  /** 'skip' (default) or 'replace' */
  mode?: 'skip' | 'replace'
  /** Dry run — count what would happen, don't write. */
  dryRun?: boolean
  onLog?: (line: string) => void | Promise<void>
}

export interface PromoteResult {
  module: string
  inserted: number
  skipped: number
  deleted: number
  draft_id: string
  dry_run: boolean
}

export async function promoteDraft(opts: PromoteOptions): Promise<PromoteResult> {
  const sb = getServiceClient()
  const log = opts.onLog ?? (() => {})

  // Load draft row
  const { data: draftRow, error: draftErr } = await sb
    .from('extracted_concepts')
    .select('id, module, status, payload')
    .eq('id', opts.draftId)
    .single()
  if (draftErr || !draftRow) {
    throw new Error(`Draft ${opts.draftId} not found: ${draftErr?.message ?? 'no row'}`)
  }
  if (draftRow.status !== 'ready') {
    throw new Error(`Draft ${opts.draftId} is in status "${draftRow.status}", not "ready"`)
  }

  const payload = draftRow.payload as ExtractionResult
  const moduleSlug = draftRow.module as string
  await log(`Promoting draft ${opts.draftId} for module ${moduleSlug}`)
  await log(`Payload contains ${payload.concepts.length} concept(s)`)

  // Resolve exam id from slug
  const { data: exam, error: examErr } = await sb
    .from('exams')
    .select('id, name')
    .eq('slug', moduleSlug)
    .single()
  if (examErr || !exam) {
    throw new Error(`No exam row for slug "${moduleSlug}": ${examErr?.message ?? 'not found'}`)
  }
  await log(`Target exam: ${exam.name} (${exam.id})`)

  const mode = opts.mode ?? 'skip'
  let deleted = 0

  // ─── Replace mode: wipe existing admin concepts for this module ───
  if (mode === 'replace') {
    const { data: existing, error: fetchErr } = await sb
      .from('concepts')
      .select('id')
      .eq('user_id', opts.ownerUserId)
      .contains('module_ids', [exam.id])
    if (fetchErr) throw new Error(`Failed to fetch existing concepts: ${fetchErr.message}`)
    const existingIds = (existing ?? []).map((r) => r.id as string)
    await log(`Found ${existingIds.length} existing concept(s) to delete (cascades to questions + knowledge)`)

    if (!opts.dryRun && existingIds.length > 0) {
      const BATCH = 200
      for (let i = 0; i < existingIds.length; i += BATCH) {
        const batch = existingIds.slice(i, i + BATCH)
        const { error: delErr } = await sb.from('concepts').delete().in('id', batch)
        if (delErr) throw new Error(`Failed to delete batch: ${delErr.message}`)
      }
      deleted = existingIds.length
      await log(`Deleted ${deleted} existing concept(s)`)
    } else if (opts.dryRun) {
      deleted = existingIds.length
    }
  }

  // ─── Skip-if-exists mode: pre-load existing concept names ───
  let existingNames = new Set<string>()
  if (mode === 'skip') {
    const { data: existing, error: fetchErr } = await sb
      .from('concepts')
      .select('name')
      .eq('user_id', opts.ownerUserId)
      .contains('module_ids', [exam.id])
    if (fetchErr) throw new Error(`Failed to fetch existing concepts: ${fetchErr.message}`)
    existingNames = new Set((existing ?? []).map((r) => normaliseName(r.name as string)))
    if (existingNames.size > 0) {
      await log(`Found ${existingNames.size} existing concept(s) — these will be skipped`)
    }
  }

  // ─── Build insert rows ───
  const toInsert: Array<Record<string, unknown>> = []
  let skipped = 0
  for (const c of payload.concepts as ExtractedConceptWithLocation[]) {
    if (mode === 'skip' && existingNames.has(normaliseName(c.name))) {
      skipped++
      continue
    }
    toInsert.push({
      user_id: opts.ownerUserId,
      name: c.name,
      description: c.description,
      key_facts: c.key_facts ?? [],
      module_ids: [exam.id],
      difficulty: clampDifficulty(c.difficulty),
      source_excerpt: (c.key_facts ?? []).slice(0, 3).join(' · ').slice(0, 500) || c.description.slice(0, 500),
      week: c.week,
      lecture: c.lecture,
      source_chunk_ids: filterValidUuids(c.source_chunk_ids),
    })
  }

  await log(`Will insert ${toInsert.length} concept(s) (${skipped} skipped as duplicates)`)

  if (opts.dryRun) {
    return {
      module: moduleSlug,
      inserted: toInsert.length,
      skipped,
      deleted,
      draft_id: opts.draftId,
      dry_run: true,
    }
  }

  // ─── Insert in batches ───
  let inserted = 0
  if (toInsert.length > 0) {
    const BATCH = 100
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH)
      const { error } = await sb.from('concepts').insert(batch)
      if (error) {
        throw new Error(`Insert failed at batch ${i}-${i + batch.length}: ${error.message}`)
      }
      inserted += batch.length
    }
    await log(`Inserted ${inserted} concept(s)`)
  }

  // Mark the draft as promoted
  await sb
    .from('extracted_concepts')
    .update({ status: 'promoted', promoted_at: new Date().toISOString() })
    .eq('id', opts.draftId)

  return {
    module: moduleSlug,
    inserted,
    skipped,
    deleted,
    draft_id: opts.draftId,
    dry_run: false,
  }
}
