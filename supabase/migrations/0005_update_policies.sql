-- RapidForge migration 0005 — member UPDATE policies for Sprint 5 (PRD 7.3/7.4, 5.4)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0001–0004.
--
-- Sprint 5 lets the dashboard edit two things members own:
--   * search_results — pipeline status, notes, follow-up timestamps
--     (kanban drag-drop, drawer status dropdown, auto-saved notes)
--   * workspace_config — the cascading agent variables (Settings editor)
--
-- The worker (service role) bypasses RLS either way; these policies exist so
-- the web client can also write these rows directly under the anon key.
-- Postgres RLS is row-level, not column-level — the web client is only ever
-- handed status/notes/follow-up fields to write, and the worker API remains
-- the canonical write path.

create policy search_results_update on search_results
  for update to authenticated
  using (workspace_id in (select public.user_workspace_ids()))
  with check (workspace_id in (select public.user_workspace_ids()));

create policy workspace_config_update on workspace_config
  for update to authenticated
  using (workspace_id in (select public.user_workspace_ids()))
  with check (workspace_id in (select public.user_workspace_ids()));
