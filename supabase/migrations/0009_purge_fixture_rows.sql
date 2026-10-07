-- RapidForge migration 0009 — purge fixture rows from the live workspace (RFL.FIX.3j, audit finding 9)
-- WRITE-ONLY: Joey pastes this into the Supabase web SQL editor. Data only, no schema change.
-- Requires 0001–0008.
--
-- Fixture-mode workers (RAPIDFORGE_FORCE_FIXTURES, or no Places key) once ran
-- against this database and left the 25 sample businesses (google_place_id
-- 'fx-001'…'fx-025') beside real Google rows. They show in Leads/Pipeline
-- and were pulled as Builder Brief "competitors". The worker now refuses
-- that setup unless RAPIDFORGE_ALLOW_FIXTURES_IN_SUPABASE=true.
--
-- Fixture rows are identified the way apps/worker/scripts/audit2-probe.ts
-- does: businesses.google_place_id like 'fx-%'. A fixture-mode search is a
-- search whose results include an fx- business and NO other business (a
-- search that ever returned a real business is never touched).
--
-- Deleted, children first (FKs from 0002/0003):
--   1. agent_runs     target_id = an fx- business, or job_id = a purged job,
--                     or input->>'search_id' = a fixture search
--                     (agent_runs.job_id → jobs has no cascade)
--   2. jobs           payload->>'business_id' = an fx- business, or
--                     payload->>'search_id' = a fixture search
--   3. audits         business_id = an fx- business
--   4. search_results business_id = an fx- business, or search_id = a fixture
--                     search (search_results.business_id → businesses has
--                     no cascade)
--   5. businesses     google_place_id like 'fx-%'
--   6. searches       the fixture searches
-- Kept: usage_events (the cost ledger; no FK to any of the above).
--
-- One transaction: any error rolls back everything. Counts print as
-- NOTICEs (Supabase SQL editor: the Messages/Notices pane). Re-running is
-- safe: the second run finds nothing and deletes 0 rows.

begin;

do $$
declare
  n_runs int; n_jobs int; n_audits int; n_results int; n_businesses int; n_searches int;
begin
  create temp table purge_businesses on commit drop as
    select id from businesses where google_place_id like 'fx-%';

  create temp table purge_searches on commit drop as
    select s.id from searches s
    where exists (
            select 1 from search_results sr
            join businesses b on b.id = sr.business_id
            where sr.search_id = s.id and b.google_place_id like 'fx-%')
      and not exists (
            select 1 from search_results sr
            join businesses b on b.id = sr.business_id
            where sr.search_id = s.id and b.google_place_id not like 'fx-%');

  create temp table purge_jobs on commit drop as
    select j.id from jobs j
    where j.payload->>'business_id' in (select id::text from purge_businesses)
       or j.payload->>'search_id' in (select id::text from purge_searches);

  -- Before ------------------------------------------------------------------
  select count(*) into n_runs from agent_runs
    where target_id in (select id from purge_businesses)
       or job_id in (select id from purge_jobs)
       or input->>'search_id' in (select id::text from purge_searches);
  select count(*) into n_jobs from purge_jobs;
  select count(*) into n_audits from audits
    where business_id in (select id from purge_businesses);
  select count(*) into n_results from search_results
    where business_id in (select id from purge_businesses)
       or search_id in (select id from purge_searches);
  select count(*) into n_businesses from purge_businesses;
  select count(*) into n_searches from purge_searches;
  raise notice 'BEFORE fixture rows: agent_runs=% jobs=% audits=% search_results=% businesses=% searches=%',
    n_runs, n_jobs, n_audits, n_results, n_businesses, n_searches;
  raise notice 'BEFORE table totals: agent_runs=% jobs=% audits=% search_results=% businesses=% searches=%',
    (select count(*) from agent_runs), (select count(*) from jobs),
    (select count(*) from audits), (select count(*) from search_results),
    (select count(*) from businesses), (select count(*) from searches);

  -- Delete, children first ---------------------------------------------------
  delete from agent_runs
    where target_id in (select id from purge_businesses)
       or job_id in (select id from purge_jobs)
       or input->>'search_id' in (select id::text from purge_searches);
  get diagnostics n_runs = row_count;
  delete from jobs where id in (select id from purge_jobs);
  get diagnostics n_jobs = row_count;
  delete from audits where business_id in (select id from purge_businesses);
  get diagnostics n_audits = row_count;
  delete from search_results
    where business_id in (select id from purge_businesses)
       or search_id in (select id from purge_searches);
  get diagnostics n_results = row_count;
  delete from businesses where id in (select id from purge_businesses);
  get diagnostics n_businesses = row_count;
  delete from searches where id in (select id from purge_searches);
  get diagnostics n_searches = row_count;
  raise notice 'DELETED: agent_runs=% jobs=% audits=% search_results=% businesses=% searches=%',
    n_runs, n_jobs, n_audits, n_results, n_businesses, n_searches;

  -- After -------------------------------------------------------------------
  raise notice 'AFTER fixture rows (expect all 0): businesses fx-%%=% audits=% search_results=% jobs=% agent_runs=%',
    (select count(*) from businesses where google_place_id like 'fx-%'),
    (select count(*) from audits a join businesses b on b.id = a.business_id
       where b.google_place_id like 'fx-%'),
    (select count(*) from search_results sr join businesses b on b.id = sr.business_id
       where b.google_place_id like 'fx-%'),
    (select count(*) from jobs where id in (select id from purge_jobs)),
    (select count(*) from agent_runs
       where target_id in (select id from purge_businesses)
          or job_id in (select id from purge_jobs));
  raise notice 'AFTER table totals: agent_runs=% jobs=% audits=% search_results=% businesses=% searches=%',
    (select count(*) from agent_runs), (select count(*) from jobs),
    (select count(*) from audits), (select count(*) from search_results),
    (select count(*) from businesses), (select count(*) from searches);
end $$;

insert into schema_migrations (version) values ('0009_purge_fixture_rows')
on conflict (version) do nothing;

commit;
