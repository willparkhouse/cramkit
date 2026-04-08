-- ============================================================================
-- Seed demo users for the leaderboard.
--
-- Run from the Supabase SQL editor (it executes as the service role so it can
-- write to auth.users + bypass RLS).
--
-- Idempotent: re-running on the same emails is a no-op. Drops nothing.
--
-- Creates 4 users with display names + 7 days of varying study activity,
-- spread across whichever modules currently exist. They CANNOT log in
-- (encrypted_password is a junk hash) — they exist purely so the leaderboard
-- has populated rows for launch.
-- ============================================================================

do $$
declare
  v_user_id  uuid;
  v_modules  uuid[];
  v_mod_count int;
  v_demo     record;
begin
  -- Pull module ids in date order. Demo activity is spread across whatever's
  -- available so the per-module filter actually segments naturally.
  select array_agg(id order by date) into v_modules from public.exams;
  v_mod_count := coalesce(array_length(v_modules, 1), 0);
  if v_mod_count = 0 then
    raise exception 'no modules found in public.exams — create at least one before seeding';
  end if;

  -- (email, display_name, opt_in, qa[7], qc[7])
  -- Activity profiles, brightest first:
  --   Alex   = the keen one        (~96 questions / week)
  --   Priya  = consistent          (~86 / week)
  --   Jamie  = casual              (~50 / week)
  --   Sam    = barely there        (~23 / week)
  for v_demo in
    select * from (values
      ('demo-alex@cramkit.app',  'Alex M.',    true,  18, 14, 22, 17, 12, 10, 25, 19, 8,  6, 11, 9,  6,  5),
      ('demo-priya@cramkit.app', 'Priya S.',   true,  12, 11, 15, 13, 14, 12, 18, 15, 10, 9, 8,  7,  9,  8),
      ('demo-jamie@cramkit.app', 'Jamie',      true,  6,  5,  9,  7,  4,  3,  11, 8,  7,  5, 5,  4,  8,  6),
      ('demo-sam@cramkit.app',   'Sam',        true,  3,  2,  5,  4,  2,  2,  6,  5,  4,  3, 1,  1,  2,  2)
    ) as t(email, display_name, opt_in,
            qa1, qc1, qa2, qc2, qa3, qc3, qa4, qc4, qa5, qc5, qa6, qc6, qa7, qc7)
  loop
    -- Skip if a user with this email already exists
    select id into v_user_id from auth.users where email = v_demo.email;
    if v_user_id is not null then
      raise notice 'demo user % already exists, skipping', v_demo.email;
      continue;
    end if;

    v_user_id := gen_random_uuid();

    insert into auth.users (
      id,
      instance_id,
      email,
      encrypted_password,
      email_confirmed_at,
      created_at,
      updated_at,
      raw_user_meta_data,
      raw_app_meta_data,
      aud,
      role,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change
    ) values (
      v_user_id,
      '00000000-0000-0000-0000-000000000000',
      v_demo.email,
      -- Junk bcrypt hash so logging in is impossible. The string isn't valid
      -- bcrypt; the auth API will reject any password attempt.
      '$2a$10$DEMO.NOT.LOGINABLE.HASH..............................',
      now() - interval '14 days',
      now() - interval '14 days',
      now(),
      '{}'::jsonb,
      '{"provider":"email","providers":["email"]}'::jsonb,
      'authenticated',
      'authenticated',
      '',
      '',
      '',
      ''
    );

    -- The on_auth_user_created trigger from migration 005 inserted the
    -- profile row for us. Patch the display name + opt-in flag.
    update public.profiles
    set display_name = v_demo.display_name,
        leaderboard_opt_in = v_demo.opt_in,
        updated_at = now()
    where id = v_user_id;

    -- 7 days of stats, rotating module attribution so the per-module filter
    -- has something to show for each module the demo touched.
    insert into public.study_stats_daily
      (user_id, day, module_id, questions_answered, questions_correct, active_seconds, chat_messages_sent)
    values
      (v_user_id, current_date - 6, v_modules[(0 % v_mod_count) + 1], v_demo.qa1, v_demo.qc1, 60 * (40 + v_demo.qa1 * 2), greatest(v_demo.qa1 / 4, 0)),
      (v_user_id, current_date - 5, v_modules[(1 % v_mod_count) + 1], v_demo.qa2, v_demo.qc2, 60 * (40 + v_demo.qa2 * 2), greatest(v_demo.qa2 / 4, 0)),
      (v_user_id, current_date - 4, v_modules[(2 % v_mod_count) + 1], v_demo.qa3, v_demo.qc3, 60 * (40 + v_demo.qa3 * 2), greatest(v_demo.qa3 / 4, 0)),
      (v_user_id, current_date - 3, v_modules[(3 % v_mod_count) + 1], v_demo.qa4, v_demo.qc4, 60 * (40 + v_demo.qa4 * 2), greatest(v_demo.qa4 / 4, 0)),
      (v_user_id, current_date - 2, v_modules[(0 % v_mod_count) + 1], v_demo.qa5, v_demo.qc5, 60 * (40 + v_demo.qa5 * 2), greatest(v_demo.qa5 / 4, 0)),
      (v_user_id, current_date - 1, v_modules[(1 % v_mod_count) + 1], v_demo.qa6, v_demo.qc6, 60 * (40 + v_demo.qa6 * 2), greatest(v_demo.qa6 / 4, 0)),
      (v_user_id, current_date,     v_modules[(2 % v_mod_count) + 1], v_demo.qa7, v_demo.qc7, 60 * (40 + v_demo.qa7 * 2), greatest(v_demo.qa7 / 4, 0));

    raise notice 'seeded demo user % (%)', v_demo.display_name, v_demo.email;
  end loop;
end $$;

-- Quick verification — run on its own to inspect.
select
  p.display_name,
  sum(s.questions_answered) as questions_answered,
  sum(s.questions_correct)  as questions_correct,
  round(sum(s.active_seconds) / 60.0) as active_minutes,
  count(distinct s.day) as days_active
from public.profiles p
join public.study_stats_daily s on s.user_id = p.id
where p.display_name in ('Alex M.', 'Priya S.', 'Jamie', 'Sam')
group by p.display_name
order by questions_answered desc;
