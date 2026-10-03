-- RapidForge migration 0007 — Places enrichment columns, FK indexes, migration tracking
-- (RFL-06; audit findings 6 and 15)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor.
-- Requires 0001–0006 (0007a and 0008 may already be applied — order is independent).
--
-- 1. businesses.places_details jsonb — the raw Place Details record Filter
--    fetches for businesses that pass its gates (hours, photos, reviews,
--    editorialSummary, types, priceLevel). audits.design_brief jsonb —
--    empty for now; brick 7's Design Brief agent fills it.
-- 2. btree indexes on the hot paths the performance advisor flagged as
--    unindexed, plus GIN on the two jsonb columns the worker filters on
--    (jobs.payload ->> 'search_id' / @>, agent_runs.input).
-- 3. schema_migrations — hand-applied migrations were untracked
--    (list_migrations was empty). Seeded with everything applied so far.
--
-- Nothing here touches the SECURITY DEFINER functions or any policy.
-- Apply BEFORE running a worker at RFL-06 or later: every business upsert
-- may now write places_details and will fail on a database without it.

-- 1. Enrichment columns -------------------------------------------------------

alter table businesses
  add column if not exists places_details jsonb;

alter table audits
  add column if not exists design_brief jsonb;

-- 2. Indexes --------------------------------------------------------------------

-- getLatestCompletedAuditForBusiness: newest completed audit per business.
create index if not exists audits_business_completed_idx
  on audits (business_id, completed_at desc)
  where status = 'completed';

create index if not exists agent_runs_target_id_idx
  on agent_runs (target_id);

create index if not exists search_results_workspace_id_idx
  on search_results (workspace_id);

create index if not exists search_results_business_id_idx
  on search_results (business_id);

-- jsonb filters: jobs.payload @> {"search_id": …} (countActiveJobsForSearch),
-- agent_runs.input ->> 'search_id' (getSearchDetail). jsonb_path_ops serves
-- containment and the key lookups the worker issues.
create index if not exists jobs_payload_gin_idx
  on jobs using gin (payload jsonb_path_ops);

create index if not exists agent_runs_input_gin_idx
  on agent_runs using gin (input jsonb_path_ops);

-- 3. Migration tracking ------------------------------------------------------

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz default now()
);

insert into schema_migrations (version) values
  ('0001_tenancy'),
  ('0002_domain'),
  ('0003_operational'),
  ('0004_rls'),
  ('0005_update_policies'),
  ('0006_screenshots_bucket'),
  ('0007_enrichment_and_indexes'),
  ('0007a_audits_provisional'),
  ('0008_businesses_chain_reason')
on conflict (version) do nothing;

-- Future migrations end with:
--   insert into schema_migrations (version) values ('00NN_name') on conflict do nothing;
