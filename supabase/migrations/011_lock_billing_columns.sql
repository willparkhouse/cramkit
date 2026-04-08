-- ============================================================================
-- Lock down user-controlled writes to profile billing columns.
--
-- Background: migration 005 added a "users update own profile" RLS policy
-- so users can edit display_name + leaderboard_opt_in. But that policy lets
-- them update *any* column on their own row — including subscription_tier,
-- subscription_status, stripe_customer_id, current_period_end. A motivated
-- user could call:
--
--   supabase.from('profiles')
--     .update({ subscription_tier: 'pro', subscription_status: 'active' })
--     .eq('id', myId)
--
-- ...and instantly become Pro for free, because requirePro reads both fields
-- straight from the row.
--
-- Postgres RLS policies can express row-level predicates but not
-- "this column may not change". A BEFORE UPDATE trigger is the standard
-- workaround — it runs as the row owner, sees both OLD and NEW, and can
-- raise an exception or silently revert protected columns.
-- ============================================================================

create or replace function public.profiles_block_billing_writes()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- auth.uid() returns the JWT-claimed user id for any client request via
  -- PostgREST (anon or authenticated role) and NULL for direct postgres /
  -- service-role connections. So "is this a client write?" is exactly
  -- "is auth.uid() not null?". The earlier role-string detection didn't
  -- work — Supabase's request runs under the `authenticator` role, not
  -- `service_role`, so my bypass always matched and the revert never fired.
  if auth.uid() is not null then
    new.subscription_tier      := old.subscription_tier;
    new.subscription_status    := old.subscription_status;
    new.stripe_customer_id     := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.current_period_end     := old.current_period_end;
    -- email is the auth.users mirror; users shouldn't be able to spoof it
    new.email                  := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_block_billing_writes_trg on public.profiles;
create trigger profiles_block_billing_writes_trg
  before update on public.profiles
  for each row execute function public.profiles_block_billing_writes();
