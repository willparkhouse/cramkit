-- ============================================================================
-- lesson_explanations — generic AI walkthrough cache for the Study page.
--
-- Each row is a Sonnet-generated 2-3 paragraph explanation of one concept,
-- grounded in its source chunks. The text is identical for every user
-- (revision content isn't personalised), so we cache it once and serve from
-- the cache forever after.
--
-- Lifecycle:
--   1. User clicks "study this concept"
--   2. Server checks for a cache hit (concept_id PK)
--   3. Hit → stream the cached body back
--   4. Miss → call Sonnet, stream tokens to user, persist on completion
-- ============================================================================

create table if not exists public.lesson_explanations (
  concept_id uuid primary key references public.concepts(id) on delete cascade,
  body text not null,
  model text not null,
  generated_at timestamptz not null default now()
);

-- ============================================================================
-- RLS: read-only for any authenticated user. Writes happen via the
-- service-role key from the lesson route.
-- ============================================================================
alter table public.lesson_explanations enable row level security;

drop policy if exists "lesson_explanations_select_authenticated" on public.lesson_explanations;
create policy "lesson_explanations_select_authenticated" on public.lesson_explanations
  for select using (auth.role() = 'authenticated');

comment on table public.lesson_explanations is
  'Generic AI walkthrough cache. One row per concept, generated on first access. '
  'Same body for every student — revision content is not personalised.';
