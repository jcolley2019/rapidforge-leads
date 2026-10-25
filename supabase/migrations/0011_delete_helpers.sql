-- RapidForge migration 0011 — delete helpers (RFL.DATA.1: delete a search; clear all workspace data)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0001–0003 (tables) and 0007 (schema_migrations).
--
-- supabase-js cannot run a multi-statement transaction, so the two deletes
-- the worker needs are plpgsql functions: one call, one transaction, any
-- error rolls back everything. The worker calls them with the service-role
-- key (SupabaseStore.deleteSearch / clearWorkspaceData); the web never
-- calls them (execute is revoked from anon and authenticated).
--
-- Both follow migration 0009's child-first order and FK notes:
--   1. agent_runs     (agent_runs.job_id → jobs has no cascade)
--   2. jobs
--   3. audits         (would cascade from businesses; deleted explicitly for the count)
--   4. search_results (search_results.business_id → businesses has no cascade)
--   5. businesses
--   6. searches
-- Kept, always: workspaces, workspace_members, workspace_config, usage_events
-- (the cost ledger; no FK to any of the above).
--
-- delete_search(workspace, search)
--   Refuses (raises 'search_not_found') when the search is not in the
--   workspace and ('search_active') while its status is anything other than
--   completed / failed — cancel first. Removes the search's search_results,
--   then every business of the workspace left with NO search_results row
--   (the orphans) with their audits, the jobs and agent_runs of those
--   businesses, the jobs and agent_runs of the search itself, and the search.
--   A business that another search also found survives, audits included.
--
-- clear_workspace_data(workspace)
--   Same six tables, every row of the workspace, same order.
--
-- Both return jsonb counts:
--   {"results", "businesses", "audits", "jobs", "agent_runs", "searches"}

begin;

create or replace function public.delete_search(p_workspace_id uuid, p_search_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_businesses uuid[];
  v_jobs uuid[];
  n_runs int; n_jobs int; n_audits int; n_results int; n_businesses int; n_searches int;
begin
  select status into v_status
    from searches
    where id = p_search_id and workspace_id = p_workspace_id;
  if not found then
    raise exception 'search_not_found' using errcode = 'P0002';
  end if;
  if v_status is distinct from 'completed' and v_status is distinct from 'failed' then
    raise exception 'search_active' using errcode = 'P0001';
  end if;

  -- Orphans: workspace businesses that no OTHER search's results reference.
  select coalesce(array_agg(b.id), '{}'::uuid[]) into v_businesses
    from businesses b
    where b.workspace_id = p_workspace_id
      and not exists (
        select 1 from search_results sr
        where sr.business_id = b.id and sr.search_id <> p_search_id);

  select coalesce(array_agg(j.id), '{}'::uuid[]) into v_jobs
    from jobs j
    where j.workspace_id = p_workspace_id
      and (j.payload->>'search_id' = p_search_id::text
           or j.payload->>'business_id' = any(v_businesses::text[]));

  delete from agent_runs
    where workspace_id = p_workspace_id
      and (target_id = any(v_businesses)
           or job_id = any(v_jobs)
           or input->>'search_id' = p_search_id::text);
  get diagnostics n_runs = row_count;

  delete from jobs where id = any(v_jobs);
  get diagnostics n_jobs = row_count;

  delete from audits where business_id = any(v_businesses);
  get diagnostics n_audits = row_count;

  delete from search_results where search_id = p_search_id;
  get diagnostics n_results = row_count;

  delete from businesses where id = any(v_businesses);
  get diagnostics n_businesses = row_count;

  delete from searches where id = p_search_id;
  get diagnostics n_searches = row_count;

  return jsonb_build_object(
    'results', n_results,
    'businesses', n_businesses,
    'audits', n_audits,
    'jobs', n_jobs,
    'agent_runs', n_runs,
    'searches', n_searches);
end;
$$;

create or replace function public.clear_workspace_data(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_runs int; n_jobs int; n_audits int; n_results int; n_businesses int; n_searches int;
begin
  delete from agent_runs where workspace_id = p_workspace_id;
  get diagnostics n_runs = row_count;

  delete from jobs where workspace_id = p_workspace_id;
  get diagnostics n_jobs = row_count;

  delete from audits where workspace_id = p_workspace_id;
  get diagnostics n_audits = row_count;

  delete from search_results where workspace_id = p_workspace_id;
  get diagnostics n_results = row_count;

  delete from businesses where workspace_id = p_workspace_id;
  get diagnostics n_businesses = row_count;

  delete from searches where workspace_id = p_workspace_id;
  get diagnostics n_searches = row_count;

  return jsonb_build_object(
    'results', n_results,
    'businesses', n_businesses,
    'audits', n_audits,
    'jobs', n_jobs,
    'agent_runs', n_runs,
    'searches', n_searches);
end;
$$;

-- Worker only (service-role). The web's anon/authenticated roles never
-- call these — deletes go through the worker API, which checks the JWT's
-- workspace first.
revoke all on function public.delete_search(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_search(uuid, uuid) to service_role;
revoke all on function public.clear_workspace_data(uuid) from public, anon, authenticated;
grant execute on function public.clear_workspace_data(uuid) to service_role;

insert into schema_migrations (version) values ('0011_delete_helpers')
on conflict (version) do nothing;

commit;
