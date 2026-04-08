-- ============================================================================
-- Publish workflow:
-- - Modules have an explicit `is_published` flag controlled by admins.
-- - Unpublished modules can be "interest-flagged" via the existing
--   module_requests table, which now optionally links to a real exam row.
-- - When a module flips to published, every interested user is auto-enrolled
--   AND a notification row is queued so the next time they log in we can
--   show a "your module just dropped" toast.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- exams: is_published + published_at
-- ----------------------------------------------------------------------------

alter table public.exams add column if not exists is_published boolean not null default true;
alter table public.exams add column if not exists published_at timestamptz;

-- Existing rows are grandfathered in as published. Stamp published_at = created_at
-- (or now() if missing) so the dashboard "new since" comparison has something
-- to compare against.
update public.exams
set published_at = coalesce(published_at, created_at, now())
where is_published is true and published_at is null;

create index if not exists exams_published_idx on public.exams (is_published, published_at desc);

-- ----------------------------------------------------------------------------
-- module_requests: link a free-text request to a real exam row
-- ----------------------------------------------------------------------------
-- Admin links the request once the exam exists; from then on the request is
-- "fulfilled" and any votes act as interest in that real module.

alter table public.module_requests
  add column if not exists linked_exam_id uuid references public.exams(id) on delete set null;

create index if not exists module_requests_linked_idx on public.module_requests (linked_exam_id);

-- ----------------------------------------------------------------------------
-- module_publish_notifications: per-user, per-exam, dismissed-after-seen
-- ----------------------------------------------------------------------------

create table if not exists public.module_publish_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  unique (user_id, exam_id)
);

create index if not exists module_publish_notifications_user_idx
  on public.module_publish_notifications (user_id, seen_at);

alter table public.module_publish_notifications enable row level security;

drop policy if exists "users read own publish notifications" on public.module_publish_notifications;
create policy "users read own publish notifications"
  on public.module_publish_notifications for select using (auth.uid() = user_id);

drop policy if exists "users mark own publish notifications seen" on public.module_publish_notifications;
create policy "users mark own publish notifications seen"
  on public.module_publish_notifications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Inserts happen via the publish trigger below (security definer).

-- ----------------------------------------------------------------------------
-- Publish trigger: when an exam transitions is_published false → true,
--   1. stamp published_at = now()
--   2. find every user who voted for any module_request linked to this exam
--   3. auto-enroll them (idempotent — ignore unique violations)
--   4. queue a publish notification for them (idempotent)
-- ----------------------------------------------------------------------------

create or replace function public.handle_module_publish()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_voter uuid;
begin
  -- Only act on transitions into published state.
  if new.is_published is true and (old.is_published is null or old.is_published is false) then
    new.published_at := now();

    -- Auto-enroll every user who has voted for a request linked to this exam,
    -- plus the user who originally raised the request itself. Wrapped in a
    -- DO block so a duplicate enrollment (existing row) doesn't abort the
    -- whole insert batch.
    for v_voter in
      select distinct u.user_id from (
        select v.user_id
          from public.module_request_votes v
          join public.module_requests r on r.id = v.request_id
         where r.linked_exam_id = new.id
        union
        select r.requested_by as user_id
          from public.module_requests r
         where r.linked_exam_id = new.id and r.requested_by is not null
      ) u
    loop
      begin
        insert into public.module_enrollments (user_id, module_id)
        values (v_voter, new.id);
      exception when unique_violation then
        -- already enrolled, fine
      end;

      -- Queue the notification (idempotent on (user_id, exam_id))
      insert into public.module_publish_notifications (user_id, exam_id)
      values (v_voter, new.id)
      on conflict (user_id, exam_id) do nothing;
    end loop;

    -- Mark linked requests as resolved so the requests panel doesn't keep
    -- showing them as outstanding.
    update public.module_requests
       set status = 'resolved'
     where linked_exam_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists on_exam_publish on public.exams;
create trigger on_exam_publish
  before update of is_published on public.exams
  for each row execute function public.handle_module_publish();
