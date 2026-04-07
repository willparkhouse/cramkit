-- ============================================================================
-- Drop unused BYOK columns from profiles.
-- The active BYOK flow stores the user's Anthropic key in auth.users
-- user_metadata (see client/src/lib/apiKey.ts), not in profiles. The columns
-- added in 005 were never read from anywhere.
-- ============================================================================

alter table public.profiles drop column if exists byok_openai_key;
alter table public.profiles drop column if exists byok_anthropic_key;
