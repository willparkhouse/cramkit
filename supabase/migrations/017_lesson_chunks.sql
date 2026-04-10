-- ============================================================================
-- Add source_chunk_ids to lesson_explanations.
--
-- The walkthrough now emits inline [[CITE:n]] tokens that point at the chunks
-- it was grounded on. Those n indices are only meaningful relative to the
-- exact chunk set used at generation time, so we have to persist them with
-- the body — otherwise a fresh retrieval on cache hit would shuffle the
-- ordering and the citations would point at the wrong sources.
--
-- Column is nullable so legacy rows (generated before citations were added)
-- still work — they have no [[CITE:n]] tokens, so the renderer is a no-op
-- and the citation strip just falls back to whatever fresh retrieval finds.
-- ============================================================================

alter table public.lesson_explanations
  add column if not exists source_chunk_ids uuid[];

comment on column public.lesson_explanations.source_chunk_ids is
  'Ordered chunk_ids the walkthrough was grounded on. The [[CITE:n]] tokens '
  'in body are 1-indexed into this array, so the order MUST be preserved.';
