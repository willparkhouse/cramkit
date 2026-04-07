-- ============================================================================
-- Lecture transcripts + RAG (pgvector)
-- Stores Panopto lecture metadata and embedded transcript chunks so the
-- in-app chat can cite specific timestamps with deep-links.
-- ============================================================================

create extension if not exists vector;

-- Lectures: one row per Panopto recording
create table if not exists public.lectures (
  id uuid primary key default uuid_generate_v4(),
  module text not null,
  code text not null unique,           -- e.g. "nc3.4"
  week int not null,
  lecture text not null,               -- "1", "2", "extra", ...
  title text,
  panopto_url text not null,           -- base Viewer URL (no &start=)
  created_at timestamptz default now()
);

-- Transcript chunks (~60s windows of speech, embedded for similarity search)
create table if not exists public.transcript_chunks (
  id uuid primary key default uuid_generate_v4(),
  lecture_id uuid not null references public.lectures(id) on delete cascade,
  chunk_index int not null,
  start_seconds int not null,
  end_seconds int not null,
  text text not null,
  embedding vector(1536),              -- OpenAI text-embedding-3-small
  created_at timestamptz default now(),
  unique (lecture_id, chunk_index)
);

create index if not exists idx_chunks_lecture on public.transcript_chunks(lecture_id);
create index if not exists idx_chunks_embedding on public.transcript_chunks
  using hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- RLS: lectures + chunks are read-only for authenticated users.
-- Writes happen out-of-band via the ingest script (service role).
-- ============================================================================
alter table public.lectures enable row level security;
alter table public.transcript_chunks enable row level security;

drop policy if exists "lectures_select_authenticated" on public.lectures;
create policy "lectures_select_authenticated" on public.lectures
  for select using (auth.role() = 'authenticated');

drop policy if exists "chunks_select_authenticated" on public.transcript_chunks;
create policy "chunks_select_authenticated" on public.transcript_chunks
  for select using (auth.role() = 'authenticated');

-- ============================================================================
-- match_lecture_chunks: top-k cosine similarity over a query embedding,
-- optionally filtered by module. Joins lecture metadata so callers get
-- everything needed to build a Panopto deep link in one round trip.
-- ============================================================================
create or replace function public.match_lecture_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  module_filter text default null
)
returns table (
  chunk_id uuid,
  lecture_id uuid,
  lecture_code text,
  module text,
  panopto_url text,
  start_seconds int,
  end_seconds int,
  chunk_text text,
  similarity float
)
language sql stable security definer
set search_path = public
as $$
  select
    c.id,
    l.id,
    l.code,
    l.module,
    l.panopto_url,
    c.start_seconds,
    c.end_seconds,
    c.text,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.transcript_chunks c
  join public.lectures l on l.id = c.lecture_id
  where module_filter is null or l.module = module_filter
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_lecture_chunks(vector, int, text) to authenticated;
