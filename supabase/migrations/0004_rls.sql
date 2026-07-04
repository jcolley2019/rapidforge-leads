-- RapidForge migration 0004 — Row Level Security (PRD 5.4)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0001–0003.
--
-- Doctrine (PRD 5.4):
--   * Every domain/operational table: workspace members can select/insert
--     via workspace_id in (member subquery).
--   * plans world-readable. workspaces visible to members.
--   * The worker uses the service-role key and bypasses RLS entirely —
--     that key exists ONLY in the worker env, never in the browser.
--
-- Later sprints add update/delete policies via NEW migrations (append-only;
-- never edit this file once applied).

-- ---------------------------------------------------------------------------
-- Helper: the calling user's workspace ids.
-- SECURITY DEFINER so policies on other tables can consult workspace_members
-- without recursive RLS evaluation.
-- ---------------------------------------------------------------------------
create or replace function public.user_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select workspace_id from workspace_members where user_id = auth.uid();
$$;

revoke all on function public.user_workspace_ids() from public, anon;
grant execute on function public.user_workspace_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table plans enable row level security;
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table workspace_config enable row level security;
alter table searches enable row level security;
alter table businesses enable row level security;
alter table search_results enable row level security;
alter table audits enable row level security;
alter table jobs enable row level security;
alter table agent_runs enable row level security;
alter table usage_events enable row level security;

-- ---------------------------------------------------------------------------
-- Tenancy policies
-- ---------------------------------------------------------------------------

-- plans: world-readable (pricing display pre-login)
create policy plans_select on plans
  for select to anon, authenticated
  using (true);

-- workspaces: visible to members (and the owner, pre-membership edge case)
create policy workspaces_select on workspaces
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or id in (select public.user_workspace_ids())
  );

-- workspace_members: users see their own membership rows
create policy workspace_members_select on workspace_members
  for select to authenticated
  using (user_id = (select auth.uid()));

-- workspace_config: members read + write their workspace's cascading variables
create policy workspace_config_select on workspace_config
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));

create policy workspace_config_insert on workspace_config
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

-- ---------------------------------------------------------------------------
-- Domain + operational policies: member select/insert (PRD 5.4)
-- ---------------------------------------------------------------------------

create policy searches_select on searches
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy searches_insert on searches
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

create policy businesses_select on businesses
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy businesses_insert on businesses
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

create policy search_results_select on search_results
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy search_results_insert on search_results
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

create policy audits_select on audits
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy audits_insert on audits
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

create policy jobs_select on jobs
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy jobs_insert on jobs
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

create policy agent_runs_select on agent_runs
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy agent_runs_insert on agent_runs
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

create policy usage_events_select on usage_events
  for select to authenticated
  using (workspace_id in (select public.user_workspace_ids()));
create policy usage_events_insert on usage_events
  for insert to authenticated
  with check (workspace_id in (select public.user_workspace_ids()));

-- ---------------------------------------------------------------------------
-- First-signup bootstrap (PRD Sprint 1): workspace + owner member + Founder
-- plan row + workspace_config defaults. SECURITY DEFINER because the member
-- policies above can't self-bootstrap the first membership row.
-- Idempotent: returns the existing workspace if the user already has one.
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_workspace(
  p_workspace_name text default 'My Workspace'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_workspace uuid;
  v_plan uuid;
begin
  if v_user is null then
    raise exception 'bootstrap_workspace requires an authenticated user';
  end if;

  -- Already a member somewhere → nothing to bootstrap.
  select workspace_id into v_workspace
    from workspace_members
    where user_id = v_user
    order by created_at
    limit 1;
  if v_workspace is not null then
    return v_workspace;
  end if;

  -- Founder plan: unlimited searches/audits, defaults otherwise (PRD 5.1).
  insert into plans (name, monthly_search_limit, monthly_audit_limit)
    values ('founder', null, null)
    on conflict (name) do nothing;
  select id into v_plan from plans where name = 'founder';

  insert into workspaces (name, plan_id, owner_user_id)
    values (p_workspace_name, v_plan, v_user)
    returning id into v_workspace;

  insert into workspace_members (workspace_id, user_id, role)
    values (v_workspace, v_user, 'owner');

  insert into workspace_config (workspace_id)
    values (v_workspace);

  return v_workspace;
end;
$$;

revoke all on function public.bootstrap_workspace(text) from public, anon;
grant execute on function public.bootstrap_workspace(text) to authenticated;
