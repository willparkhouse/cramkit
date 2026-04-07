-- ============================================================================
-- cramkit schema
-- Multi-user with row-level security. Open signups (no email restriction).
-- ============================================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- Clean up legacy bham email trigger if it exists (was used during initial
-- development when we tried to restrict signups to bham.ac.uk only).
drop trigger if exists enforce_bham_email_trigger on auth.users;
drop function if exists public.enforce_bham_email;

-- ============================================================================
-- Tables
-- ============================================================================

-- Exams (global, shared across users — not per-user)
create table if not exists public.exams (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  date timestamptz not null,
  weight real not null,
  semester int not null,
  created_at timestamptz default now()
);

-- Concepts (per-user)
create table if not exists public.concepts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  key_facts text[] default '{}',
  module_ids uuid[] not null default '{}',
  difficulty int check (difficulty between 1 and 5),
  source_excerpt text,
  week int,
  lecture text,
  created_at timestamptz default now()
);

-- Questions (per-user)
create table if not exists public.questions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  type text check (type in ('mcq', 'free_form')),
  difficulty int check (difficulty between 1 and 5),
  question text not null,
  options jsonb,
  correct_answer text not null,
  explanation text,
  source text check (source in ('batch', 'runtime')),
  times_used int default 0,
  created_at timestamptz default now()
);

-- Knowledge tracking (per-user)
create table if not exists public.knowledge (
  user_id uuid not null references auth.users(id) on delete cascade,
  concept_id uuid not null references public.concepts(id) on delete cascade,
  score real not null default 0.0,
  last_tested timestamptz,
  history jsonb default '[]',
  updated_at timestamptz default now(),
  primary key (user_id, concept_id)
);

-- Revision slots (per-user)
create table if not exists public.revision_slots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  start_time timestamptz not null,
  end_time timestamptz not null,
  allocated_module_id uuid references public.exams(id),
  calendar_event_id text,
  status text default 'pending' check (status in ('pending', 'completed', 'skipped')),
  created_at timestamptz default now()
);

-- ============================================================================
-- Indexes
-- ============================================================================
create index if not exists idx_concepts_user on public.concepts(user_id);
create index if not exists idx_questions_user on public.questions(user_id);
create index if not exists idx_questions_concept on public.questions(concept_id);
create index if not exists idx_knowledge_user on public.knowledge(user_id);
create index if not exists idx_slots_user on public.revision_slots(user_id);
create index if not exists idx_slots_start on public.revision_slots(start_time);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.exams enable row level security;
alter table public.concepts enable row level security;
alter table public.questions enable row level security;
alter table public.knowledge enable row level security;
alter table public.revision_slots enable row level security;

-- Exams: anyone authenticated can read (they're shared)
drop policy if exists "exams_select_authenticated" on public.exams;
create policy "exams_select_authenticated" on public.exams
  for select using (auth.role() = 'authenticated');

-- Concepts: full CRUD on own concepts
drop policy if exists "concepts_select_own" on public.concepts;
create policy "concepts_select_own" on public.concepts
  for select using (auth.uid() = user_id);

drop policy if exists "concepts_insert_own" on public.concepts;
create policy "concepts_insert_own" on public.concepts
  for insert with check (auth.uid() = user_id);

drop policy if exists "concepts_update_own" on public.concepts;
create policy "concepts_update_own" on public.concepts
  for update using (auth.uid() = user_id);

drop policy if exists "concepts_delete_own" on public.concepts;
create policy "concepts_delete_own" on public.concepts
  for delete using (auth.uid() = user_id);

-- Questions: full CRUD on own questions
drop policy if exists "questions_select_own" on public.questions;
create policy "questions_select_own" on public.questions
  for select using (auth.uid() = user_id);

drop policy if exists "questions_insert_own" on public.questions;
create policy "questions_insert_own" on public.questions
  for insert with check (auth.uid() = user_id);

drop policy if exists "questions_update_own" on public.questions;
create policy "questions_update_own" on public.questions
  for update using (auth.uid() = user_id);

drop policy if exists "questions_delete_own" on public.questions;
create policy "questions_delete_own" on public.questions
  for delete using (auth.uid() = user_id);

-- Knowledge: full CRUD on own knowledge
drop policy if exists "knowledge_select_own" on public.knowledge;
create policy "knowledge_select_own" on public.knowledge
  for select using (auth.uid() = user_id);

drop policy if exists "knowledge_insert_own" on public.knowledge;
create policy "knowledge_insert_own" on public.knowledge
  for insert with check (auth.uid() = user_id);

drop policy if exists "knowledge_update_own" on public.knowledge;
create policy "knowledge_update_own" on public.knowledge
  for update using (auth.uid() = user_id);

drop policy if exists "knowledge_delete_own" on public.knowledge;
create policy "knowledge_delete_own" on public.knowledge
  for delete using (auth.uid() = user_id);

-- Revision slots: full CRUD on own slots
drop policy if exists "slots_select_own" on public.revision_slots;
create policy "slots_select_own" on public.revision_slots
  for select using (auth.uid() = user_id);

drop policy if exists "slots_insert_own" on public.revision_slots;
create policy "slots_insert_own" on public.revision_slots
  for insert with check (auth.uid() = user_id);

drop policy if exists "slots_update_own" on public.revision_slots;
create policy "slots_update_own" on public.revision_slots
  for update using (auth.uid() = user_id);

drop policy if exists "slots_delete_own" on public.revision_slots;
create policy "slots_delete_own" on public.revision_slots
  for delete using (auth.uid() = user_id);

-- ============================================================================
-- Seed exam data
-- ============================================================================
insert into public.exams (name, date, weight, semester) values
  ('Natural Language Processing', '2026-05-12T09:30:00Z', 0.8, 2),
  ('Neural Computation', '2026-05-13T09:30:00Z', 0.8, 1),
  ('Evolutionary Computation', '2026-05-14T14:00:00Z', 0.5, 2),
  ('Security of Real World Systems', '2026-05-18T09:30:00Z', 0.8, 2)
on conflict do nothing;
