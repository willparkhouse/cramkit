-- ============================================================================
-- question_flags — admin-only review queue for questions that need attention.
--
-- An admin marks a question as "flagged" while quizzing or while reading the
-- study walkthrough (typo, ambiguous wording, wrong answer, etc.) and
-- optionally attaches a comment. The flag persists until an admin clears it.
--
-- One row per question: flagging an already-flagged question updates the
-- comment in place rather than creating a duplicate. Service-role-only —
-- there are no RLS policies for client roles, so all access goes through
-- the /admin/question-flags endpoints.
-- ============================================================================

create table if not exists public.question_flags (
  question_id uuid primary key references public.questions(id) on delete cascade,
  flagged_by  uuid references auth.users(id) on delete set null,
  comment     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists question_flags_created_at_idx
  on public.question_flags (created_at desc);

alter table public.question_flags enable row level security;

comment on table public.question_flags is
  'Admin review queue for flagged questions. One row per flagged question; '
  'all reads/writes go through service-role admin endpoints.';
