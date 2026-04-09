-- ============================================================================
-- exams.short_name — compact label used in badges, dashboard cards, etc.
--
-- Until now this lived in the client-side MODULE_SHORT_NAMES constant map,
-- which meant every new module needed a code change + redeploy. Moving it to
-- the DB lets the admin set it from the module create/edit form.
--
-- The constant map stays as a lookup helper falls back to it for null rows,
-- but new modules created from the admin UI must specify a short_name up front.
-- ============================================================================

alter table public.exams add column if not exists short_name text;

-- Backfill from the historical hardcoded MODULE_SHORT_NAMES map. Any module
-- not listed here keeps short_name = null and the admin will fill it in.
update public.exams set short_name = case name
  when 'Natural Language Processing' then 'NLP'
  when 'Neural Computation' then 'NC'
  when 'Evolutionary Computation' then 'EC'
  when 'Security of Real World Systems' then 'SRWS'
  when 'Security and Networks' then 'SandN'
  when 'Computer Vision and Imaging' then 'CVI'
  when 'Advanced Networking' then 'AdvNet'
  else short_name
end
where short_name is null;

comment on column public.exams.short_name is
  'Short label (3-6 chars) used in compact UI surfaces (badges, dashboard cards, progress filters). Required for new modules — see admin form.';
