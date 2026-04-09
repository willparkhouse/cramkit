-- ============================================================================
-- Concept extraction draft table.
--
-- Purpose: stores the output of the whole-week concept extraction pipeline as
-- a draft "version" before any admin promotes it into the live `concepts`
-- table. The CLI extract-concepts.ts script writes JSON to disk; the new
-- admin-pipeline route writes to this table instead so drafts survive across
-- container restarts and are visible from any deploy.
--
-- Lifecycle:
--   1. Admin clicks "Extract" → new row inserted with status='pending'
--   2. Background worker fills in `payload` and sets status='ready'
--   3. Admin reviews, then clicks "Promote" → status='promoted', concepts copied
--      into the live `concepts` table (with module_ids set, owned by the admin)
--   4. Admin can also discard a draft → status='discarded'
--
-- Multiple drafts per module can coexist (versioning is "by row, not column").
-- ============================================================================

create table if not exists public.extracted_concepts (
  id uuid primary key default uuid_generate_v4(),
  module text not null,                                  -- mirrors sources.module / exams.slug
  status text not null default 'pending'
    check (status in ('pending', 'running', 'ready', 'failed', 'promoted', 'discarded')),
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz default now(),
  promoted_at timestamptz,
  -- The full extraction output, shape mirrors data/extracted-concepts/{module}.json:
  --   { module, generated_at, total_concepts, by_week, concepts: [...] }
  payload jsonb not null default '{}'::jsonb,
  -- Coverage gaps report (free text from the model)
  coverage_report text,
  -- Job tracking: surfaces extraction progress in the admin UI without needing
  -- a separate jobs table. NULL until extraction starts.
  progress jsonb,                                        -- { weeks_done, weeks_total, last_week, started_at }
  error_message text,                                    -- populated if status='failed'
  created_at timestamptz default now()
);

create index if not exists idx_extracted_concepts_module on public.extracted_concepts(module, generated_at desc);
create index if not exists idx_extracted_concepts_status on public.extracted_concepts(status);

-- ============================================================================
-- RLS: admin-only via service role. No client-side access; the admin pipeline
-- routes use the service-role key, so the policies just need to deny
-- everyone else.
-- ============================================================================
alter table public.extracted_concepts enable row level security;

drop policy if exists "extracted_concepts_no_client_access" on public.extracted_concepts;
create policy "extracted_concepts_no_client_access" on public.extracted_concepts
  for all using (false);

comment on table public.extracted_concepts is
  'Drafts produced by the admin concept-extraction pipeline. A row represents one '
  'extraction run for one module. Admins review the payload and either promote '
  'it into the live concepts table or discard it. Multiple drafts per module '
  'can coexist; the most recent ready/promoted one is the "current" snapshot.';
