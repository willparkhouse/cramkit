-- ============================================================================
-- Leaderboard: per-module question stats + display names + opt-out + RPC.
--
-- Design notes:
-- - profiles gains display_name + leaderboard_opt_in (default opt-in).
-- - study_stats_daily gains module_id so question events can be attributed
--   to a specific module. Active time + chat events stay module_id=null.
-- - The (user_id, day) primary key becomes a (user_id, day, module_id) unique
--   index using `nulls not distinct` so that NULL module rows still upsert.
-- - bump_study_activity grows a p_module_id parameter (default null).
-- - get_leaderboard is a SECURITY DEFINER function that filters opted-in users
--   only — direct table SELECTs are still RLS-locked to own rows.
-- ============================================================================

-- ---- profiles columns ------------------------------------------------------

alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists leaderboard_opt_in boolean not null default true;

-- ---- study_stats_daily: per-module attribution -----------------------------

alter table public.study_stats_daily
  add column if not exists module_id uuid references public.exams(id) on delete set null;

-- Drop the existing primary key (user_id, day) and replace with a unique
-- index that includes module_id and treats NULL as a single key value.
alter table public.study_stats_daily drop constraint if exists study_stats_daily_pkey;

create unique index if not exists study_stats_daily_user_day_module_key
  on public.study_stats_daily (user_id, day, module_id) nulls not distinct;

create index if not exists study_stats_daily_module_idx
  on public.study_stats_daily (module_id) where module_id is not null;

-- ---- bump_study_activity: add p_module_id ----------------------------------

drop function if exists public.bump_study_activity(int, int, int, int);

create or replace function public.bump_study_activity(
  p_questions_answered int default 0,
  p_questions_correct int default 0,
  p_active_seconds int default 0,
  p_chat_messages_sent int default 0,
  p_module_id uuid default null
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
    user_id, day, module_id,
    questions_answered, questions_correct, active_seconds, chat_messages_sent,
    updated_at
  )
  values (
    v_user, v_day, p_module_id,
    greatest(p_questions_answered, 0),
    greatest(p_questions_correct, 0),
    greatest(p_active_seconds, 0),
    greatest(p_chat_messages_sent, 0),
    now()
  )
  on conflict (user_id, day, module_id) do update set
    questions_answered = study_stats_daily.questions_answered + greatest(p_questions_answered, 0),
    questions_correct = study_stats_daily.questions_correct + greatest(p_questions_correct, 0),
    active_seconds = study_stats_daily.active_seconds + greatest(p_active_seconds, 0),
    chat_messages_sent = study_stats_daily.chat_messages_sent + greatest(p_chat_messages_sent, 0),
    updated_at = now();
end;
$$;

grant execute on function public.bump_study_activity(int, int, int, int, uuid) to authenticated;

-- ---- Leaderboard RPC -------------------------------------------------------
--
-- Returns the top N opted-in users for a given window + module filter, ranked
-- by questions_answered (with questions_correct shown alongside).
--
-- p_window: 'week' (rolling 7 days) or 'all' (all time)
-- p_module_id: null for "all modules", or a specific exam id
-- p_limit: how many rows to return (capped at 100 server-side)
-- ============================================================================

drop function if exists public.get_leaderboard(text, uuid, int);

create or replace function public.get_leaderboard(
  p_window text default 'week',
  p_module_id uuid default null,
  p_limit int default 25
)
returns table (
  user_id uuid,
  display_name text,
  questions_answered bigint,
  questions_correct bigint,
  rank bigint,
  is_self boolean
)
language plpgsql
security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_cutoff date;
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;

  if p_window = 'week' then
    v_cutoff := (now() at time zone 'utc')::date - interval '7 days';
  else
    v_cutoff := '1970-01-01'::date;
  end if;

  return query
  with totals as (
    select
      s.user_id,
      sum(s.questions_answered)::bigint as qa,
      sum(s.questions_correct)::bigint as qc
    from public.study_stats_daily s
    where s.day >= v_cutoff
      and (p_module_id is null or s.module_id = p_module_id)
    group by s.user_id
  ),
  joined as (
    select
      t.user_id,
      coalesce(p.display_name, 'Anonymous') as display_name,
      t.qa,
      t.qc,
      p.leaderboard_opt_in
    from totals t
    join public.profiles p on p.id = t.user_id
    where p.leaderboard_opt_in is true
      and t.qa > 0
  )
  select
    j.user_id,
    j.display_name,
    j.qa as questions_answered,
    j.qc as questions_correct,
    row_number() over (order by j.qa desc, j.qc desc, j.user_id) as rank,
    (j.user_id = v_caller) as is_self
  from joined j
  order by j.qa desc, j.qc desc, j.user_id
  limit v_limit;
end;
$$;

grant execute on function public.get_leaderboard(text, uuid, int) to authenticated;

-- ---- Caller's own rank (even if outside the top N) -------------------------

create or replace function public.get_my_leaderboard_rank(
  p_window text default 'week',
  p_module_id uuid default null
)
returns table (
  rank bigint,
  questions_answered bigint,
  questions_correct bigint,
  total_participants bigint
)
language plpgsql
security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_cutoff date;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;

  if p_window = 'week' then
    v_cutoff := (now() at time zone 'utc')::date - interval '7 days';
  else
    v_cutoff := '1970-01-01'::date;
  end if;

  return query
  with totals as (
    select
      s.user_id,
      sum(s.questions_answered)::bigint as qa,
      sum(s.questions_correct)::bigint as qc
    from public.study_stats_daily s
    where s.day >= v_cutoff
      and (p_module_id is null or s.module_id = p_module_id)
    group by s.user_id
  ),
  ranked as (
    select
      t.user_id,
      t.qa,
      t.qc,
      row_number() over (order by t.qa desc, t.qc desc, t.user_id) as r
    from totals t
    join public.profiles p on p.id = t.user_id
    where p.leaderboard_opt_in is true
      and t.qa > 0
  )
  select
    r.r as rank,
    r.qa as questions_answered,
    r.qc as questions_correct,
    (select count(*) from ranked) as total_participants
  from ranked r
  where r.user_id = v_caller;
end;
$$;

grant execute on function public.get_my_leaderboard_rank(text, uuid) to authenticated;
