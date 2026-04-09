-- ============================================================================
-- Add source_chunk_ids to concepts so concepts can carry the exact chunks
-- they were extracted from. This lets the wrong-answer panel prefer the
-- chunks that ground the concept directly, instead of running a fresh
-- similarity search at runtime — better grounding, deterministic, and free
-- once extraction has run.
-- ============================================================================

alter table public.concepts
  add column if not exists source_chunk_ids uuid[] not null default '{}';

comment on column public.concepts.source_chunk_ids is
  'Optional list of source_chunks.id that this concept was extracted from. '
  'Populated by the extract-concepts pipeline. The wrong-answer panel uses '
  'these as a high-precision grounding pool before falling back to similarity.';
