-- ============================================================================
-- Allow 'resolved' as a module_requests.status value.
--
-- The publish trigger added in migration 010 (handle_module_publish) sets
--   update module_requests set status = 'resolved' where linked_exam_id = ...
-- But the original check constraint only permitted 'pending', 'approved',
-- 'rejected'. The mismatch only fired when an admin actually published a
-- module that had a linked request — silent until the first real use, then
-- a 500 on the publish PATCH.
--
-- Fix: extend the check constraint to include 'resolved'.
-- ============================================================================

alter table public.module_requests
  drop constraint if exists module_requests_status_check;

alter table public.module_requests
  add constraint module_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'resolved'));
