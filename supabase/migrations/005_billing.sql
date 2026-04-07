-- ============================================================================
-- Billing: profiles table + Stripe subscription tracking
-- One row per auth user, populated lazily on first sign-in or first
-- billing-related action. Stores Stripe customer + subscription state and
-- (eventually) BYOK API keys.
-- ============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Stripe
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  subscription_status text,                 -- active | trialing | past_due | canceled | incomplete | null
  subscription_tier text not null default 'free',  -- free | pro
  current_period_end timestamptz,

  -- BYOK (bring-your-own-key) — users on free tier can paste their own
  -- provider keys instead of paying. Stored as plain text for now; rotate to
  -- pgsodium / vault before going wide.
  byok_openai_key text,
  byok_anthropic_key text
);

create index if not exists profiles_stripe_customer_idx
  on public.profiles (stripe_customer_id);

alter table public.profiles enable row level security;

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Inserts and Stripe-driven updates happen via the service role from the server.

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for existing users
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;
