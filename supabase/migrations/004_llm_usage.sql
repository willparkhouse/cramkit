-- ============================================================================
-- LLM usage tracking
-- One row per LLM API call (OpenAI / Anthropic). Server-side inserts only,
-- via the service role. Users may read their own rows; admins read all (via
-- service role from the admin routes).
-- ============================================================================

create table if not exists public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null,
  endpoint text not null,            -- e.g. 'source-search', 'extract-concepts'

  input_tokens int not null default 0,
  output_tokens int not null default 0,
  total_tokens int generated always as (input_tokens + output_tokens) stored,

  -- Estimated cost in USD. Computed server-side from a price table.
  cost_usd numeric(12, 6) not null default 0,

  -- Optional free-form metadata (module slug, request id, etc.)
  meta jsonb
);

create index if not exists llm_usage_user_created_idx
  on public.llm_usage (user_id, created_at desc);

create index if not exists llm_usage_created_idx
  on public.llm_usage (created_at desc);

alter table public.llm_usage enable row level security;

-- Users can read their own usage
drop policy if exists "users read own llm usage" on public.llm_usage;
create policy "users read own llm usage"
  on public.llm_usage
  for select
  using (auth.uid() = user_id);

-- No insert/update/delete from clients — service role bypasses RLS.
