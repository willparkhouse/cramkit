-- ============================================================================
-- Add a position column to concepts so the study page can render them in
-- lecture order within a week. The extraction pipeline outputs concepts in
-- the order they appear in the lecture; the promote step writes the array
-- index as `position`.
--
-- Nullable so legacy rows (inserted before this column) still work — they
-- just sort after positioned rows, falling back to name alpha.
-- ============================================================================

alter table public.concepts
  add column if not exists position int;

comment on column public.concepts.position is
  'Insertion order within a module — mirrors the extraction pipeline array index. '
  'Used by the Study page to render concepts in lecture order within a week.';
