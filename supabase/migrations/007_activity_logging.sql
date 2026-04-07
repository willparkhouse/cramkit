-- ============================================================================
-- Activity logging: chat conversation history + daily study stats.
-- Internal product analytics — surfaced through admin queries, not in the
-- normal user UI. Plaintext + RLS so users can only ever read their own rows.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Chat conversations + messages
-- ----------------------------------------------------------------------------

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Where the chat happened. Today only 'quiz' (post-question help) but
  -- structured so future surfaces (concept page, search page) can reuse it.
  context_type text not null check (context_type in ('quiz', 'concept', 'source')),
  module_id uuid,
  concept_id uuid,
  question_id uuid,
  -- True if the chat was grounded in retrieved source chunks (RAG path) vs
  -- the plain concept-context fallback. Useful for measuring citation usage.
  rag_grounded boolean not null default false,

  -- First user message, truncated — used for listing conversations later.
  title text
);

create index if not exists chat_conversations_user_created_idx
  on public.chat_conversations (user_id, created_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  role text not null check (role in ('user', 'assistant')),
  content text not null
);

create index if not exists chat_messages_conversation_idx
  on public.chat_messages (conversation_id, created_at);

alter table public.chat_conversations enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "users read own conversations" on public.chat_conversations;
create policy "users read own conversations"
  on public.chat_conversations for select using (auth.uid() = user_id);

drop policy if exists "users insert own conversations" on public.chat_conversations;
create policy "users insert own conversations"
  on public.chat_conversations for insert with check (auth.uid() = user_id);

drop policy if exists "users update own conversations" on public.chat_conversations;
create policy "users update own conversations"
  on public.chat_conversations for update using (auth.uid() = user_id);

drop policy if exists "users read own messages" on public.chat_messages;
create policy "users read own messages"
  on public.chat_messages for select using (auth.uid() = user_id);

drop policy if exists "users insert own messages" on public.chat_messages;
create policy "users insert own messages"
  on public.chat_messages for insert with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Daily study stats — one row per (user, day). Updated incrementally via the
-- bump_study_activity RPC below so concurrent writes don't clobber each other.
-- ----------------------------------------------------------------------------

create table if not exists public.study_stats_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  questions_answered int not null default 0,
  questions_correct int not null default 0,
  active_seconds int not null default 0,
  chat_messages_sent int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists study_stats_daily_day_idx
  on public.study_stats_daily (day desc);

alter table public.study_stats_daily enable row level security;

drop policy if exists "users read own daily stats" on public.study_stats_daily;
create policy "users read own daily stats"
  on public.study_stats_daily for select using (auth.uid() = user_id);

-- Inserts/updates happen through the bump_study_activity RPC below, which is
-- security-definer and validates the caller against auth.uid(). Direct writes
-- are forbidden by the absence of an INSERT/UPDATE policy.

create or replace function public.bump_study_activity(
  p_questions_answered int default 0,
  p_questions_correct int default 0,
  p_active_seconds int default 0,
  p_chat_messages_sent int default 0
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  insert into public.study_stats_daily (
    user_id, day,
    questions_answered, questions_correct, active_seconds, chat_messages_sent,
    updated_at
  )
  values (
    v_user, v_day,
    greatest(p_questions_answered, 0),
    greatest(p_questions_correct, 0),
    greatest(p_active_seconds, 0),
    greatest(p_chat_messages_sent, 0),
    now()
  )
  on conflict (user_id, day) do update set
    questions_answered = study_stats_daily.questions_answered + greatest(p_questions_answered, 0),
    questions_correct = study_stats_daily.questions_correct + greatest(p_questions_correct, 0),
    active_seconds = study_stats_daily.active_seconds + greatest(p_active_seconds, 0),
    chat_messages_sent = study_stats_daily.chat_messages_sent + greatest(p_chat_messages_sent, 0),
    updated_at = now();
end;
$$;

grant execute on function public.bump_study_activity(int, int, int, int) to authenticated;
