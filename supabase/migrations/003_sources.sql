-- ============================================================================
-- Generalize lectures + transcript_chunks into sources + source_chunks.
-- A "source" is any piece of teaching material — lecture recording, slide
-- deck, past paper, notes — and its chunks share the same embedding pool.
-- Type-specific positional info (timestamp, slide page, question number)
-- lives in the chunk's locator JSONB so the schema stays uniform.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- sources (was: lectures)
-- ----------------------------------------------------------------------------
alter table public.lectures rename to sources;

alter table public.sources add column if not exists source_type text not null default 'lecture';
alter table public.sources rename column panopto_url to url;
alter table public.sources alter column lecture drop not null;
alter table public.sources alter column week drop not null;
alter table public.sources add column if not exists metadata jsonb not null default '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- source_chunks (was: transcript_chunks)
-- Pack the old start_seconds/end_seconds into the new locator jsonb so all
-- positional info is uniform across source types.
-- ----------------------------------------------------------------------------
alter table public.transcript_chunks rename to source_chunks;
alter table public.source_chunks rename column lecture_id to source_id;
alter table public.source_chunks add column if not exists locator jsonb not null default '{}'::jsonb;

update public.source_chunks
   set locator = jsonb_build_object(
     'start_seconds', start_seconds,
     'end_seconds', end_seconds
   )
 where locator = '{}'::jsonb;

alter table public.source_chunks drop column if exists start_seconds;
alter table public.source_chunks drop column if exists end_seconds;

alter index if exists idx_chunks_lecture rename to idx_source_chunks_source;
alter index if exists idx_chunks_embedding rename to idx_source_chunks_embedding;

-- ----------------------------------------------------------------------------
-- RLS: rename existing policies to match the new table names
-- ----------------------------------------------------------------------------
drop policy if exists "lectures_select_authenticated" on public.sources;
drop policy if exists "chunks_select_authenticated" on public.source_chunks;

create policy "sources_select_authenticated" on public.sources
  for select using (auth.role() = 'authenticated');

create policy "source_chunks_select_authenticated" on public.source_chunks
  for select using (auth.role() = 'authenticated');

-- ----------------------------------------------------------------------------
-- Replace the retrieval RPC with a generalised version that supports
-- filtering by source_type. Returns the locator jsonb so the server can
-- build the right deep-link per source type.
-- ----------------------------------------------------------------------------
drop function if exists public.match_lecture_chunks(vector, int, text);

create or replace function public.match_source_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  module_filter text default null,
  source_types text[] default null
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_code text,
  source_type text,
  module text,
  url text,
  locator jsonb,
  chunk_text text,
  similarity float
)
language sql stable security definer
set search_path = public
as $$
  select
    c.id,
    s.id,
    s.code,
    s.source_type,
    s.module,
    s.url,
    c.locator,
    c.text,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.source_chunks c
  join public.sources s on s.id = c.source_id
  where (module_filter is null or s.module = module_filter)
    and (source_types is null or s.source_type = any(source_types))
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_source_chunks(vector, int, text, text[]) to authenticated;
