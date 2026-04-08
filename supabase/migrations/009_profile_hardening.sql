-- ============================================================================
-- Pre-launch hardening for profiles:
-- 1. Length check on display_name to stop abusive inputs hitting RLS reads.
-- 2. INSERT policy so users can self-upsert their own profile row in the
--    rare case the on_auth_user_created trigger didn't fire.
-- ============================================================================

-- Drop any prior constraint with the same name (idempotent re-runs)
alter table public.profiles drop constraint if exists profiles_display_name_length_check;
alter table public.profiles
  add constraint profiles_display_name_length_check
  check (display_name is null or length(display_name) between 1 and 40);

drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);
