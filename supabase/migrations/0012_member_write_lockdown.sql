-- RapidForge migration 0012 — members cannot write pipeline tables (RFL.SEC.1 / RFL.RLS.1)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0004 (RLS), 0005 (update policies) and 0007 (schema_migrations).
--
-- Why (docs/AUDIT-2026-11-13.md, P0-3): 0004 gave every signed-in member an
-- INSERT policy on the pipeline tables. With the public anon key plus a
-- session, a member could insert a business whose website_url points at an
-- internal address, or a job row naming any search or business id, and the
-- worker (service-role, no RLS) would run it.
--
-- What the web really does through supabase-js (checked 2026-11-13):
--   * select on workspace_members   (apps/web/src/features/auth/useAuth.ts)
--   * select on agent_runs          (apps/web/src/features/live/useWorkspaceLive.ts)
--   * rpc bootstrap_workspace       (useAuth.ts)
--   * a Realtime broadcast channel  (apps/web/src/lib/realtime.ts)
-- Every write goes through the worker API, which checks the JWT's workspace.
-- So nothing the web does needs the policies dropped here.
--
-- Dropped: the seven member INSERT policies from 0004, and the member UPDATE
-- policy on search_results from 0005 (status / notes / follow-up are saved
-- through POST /api/leads/:id/status, never directly).
-- Kept: every SELECT policy (the dashboard and Realtime read through them),
-- and workspace_config insert/update (a member's own Settings row; not a
-- pipeline table).
--
-- RLS stays enabled on every table, so with no INSERT / UPDATE / DELETE
-- policy left, anon and authenticated are denied those commands. The worker's
-- service-role key bypasses RLS and is unaffected.
--
-- Safe to re-run: every statement is "if exists" / "on conflict do nothing".

begin;

drop policy if exists searches_insert        on searches;
drop policy if exists businesses_insert      on businesses;
drop policy if exists search_results_insert  on search_results;
drop policy if exists search_results_update  on search_results;
drop policy if exists audits_insert          on audits;
drop policy if exists jobs_insert            on jobs;
drop policy if exists agent_runs_insert      on agent_runs;
drop policy if exists usage_events_insert    on usage_events;

-- 0010_business_demo.sql was applied but never recorded itself (audit P2-3).
insert into schema_migrations (version) values ('0010_business_demo')
on conflict (version) do nothing;

insert into schema_migrations (version) values ('0012_member_write_lockdown')
on conflict (version) do nothing;

commit;

-- Check afterwards (expect only *_select rows for these seven tables):
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public'
--     and tablename in ('searches','businesses','search_results','audits',
--                       'jobs','agent_runs','usage_events')
--   order by tablename, policyname;
