-- RFL-WEB-10 — repoint search_results.latest_audit_id at each business's
-- newest COMPLETED audit (one-off backfill for the rows the old write path
-- left behind).
--
-- WRITE-ONLY from Claude Code. Joey pastes this into the Supabase web SQL
-- editor himself; nothing here has been executed by tooling.
--
-- Why: until RFL.WEB.10 the pointer was set when Filter INSERTED an audit
-- row ('pending' for a live site) and never moved again — so a forced
-- re-audit that hung or failed left the lead pointing at a failed/pending
-- row while a completed audit existed (Accurbore, business e08e4ffd:
-- pointer on a failed row, completed audit aaa0e4ce health 72 / sell 55,
-- 2026-10-04T07:34Z). The worker now (a) resolves the displayed audit from
-- the audits table on read, (b) repoints on completion, and (c) refuses to
-- let a pending/failed audit displace a completed pointer. This script
-- brings the stored pointers in line with (b) for history.
--
-- Rule: for every search_results row whose business has at least one
-- completed audit, latest_audit_id := that business's newest completed
-- audit (completed_at desc, created_at desc). Rows whose business has NO
-- completed audit are left alone — they keep pointing at the newest
-- pending/failed row, which is exactly what the read-side fallback shows
-- (RFL-03 "Could not audit" / "auditing…" chips).
--
-- HOW TO RUN
--   1. Select PART 1 and run it (read-only). The first result is the count
--      of rows that will change, split by what they point at today; the
--      second lists them; the third is the Accurbore row specifically.
--   2. Select PART 2 and run it (one transaction, ends in COMMIT). The
--      RETURNING rows are what changed.
--   3. Select PART 3 and run it (read-only): 0 rows still differ, and
--      Accurbore's row points at aaa0e4ce….
--   The worker can keep running throughout — a job finishing mid-script
--   sets the same value this script would.


-- ===========================================================================
-- PART 1 — preview (read-only): how many rows change, and which
-- ===========================================================================

with newest as (
  select distinct on (business_id)
         business_id, id as audit_id, completed_at
  from audits
  where status = 'completed' and completed_at is not null
  order by business_id, completed_at desc, created_at desc
)
select count(*)                                                as rows_to_repoint,
       count(*) filter (where sr.latest_audit_id is null)      as from_null_pointer,
       count(*) filter (where cur.status = 'failed')           as from_failed_pointer,
       count(*) filter (where cur.status = 'pending')          as from_pending_pointer,
       count(*) filter (where cur.status = 'skipped')          as from_skipped_pointer,
       count(*) filter (where cur.status = 'completed')        as from_older_completed,
       count(distinct sr.business_id)                          as businesses_affected
from search_results sr
join newest n on n.business_id = sr.business_id
left join audits cur on cur.id = sr.latest_audit_id
where sr.latest_audit_id is distinct from n.audit_id;

-- Row-by-row: old pointer → new pointer.
with newest as (
  select distinct on (business_id)
         business_id, id as audit_id, completed_at,
         website_health_score, sellability_score
  from audits
  where status = 'completed' and completed_at is not null
  order by business_id, completed_at desc, created_at desc
)
select sr.id                      as search_result_id,
       sr.search_id,
       b.name,
       sr.latest_audit_id         as old_audit_id,
       cur.status                 as old_status,
       cur.created_at             as old_created_at,
       n.audit_id                 as new_audit_id,
       n.completed_at             as new_completed_at,
       n.website_health_score     as new_health,
       n.sellability_score        as new_sellability
from search_results sr
join businesses b on b.id = sr.business_id
join newest n on n.business_id = sr.business_id
left join audits cur on cur.id = sr.latest_audit_id
where sr.latest_audit_id is distinct from n.audit_id
order by b.name, sr.created_at;

-- The reported case: every search_results row for Accurbore, with what it
-- points at today and every audit the business has.
select sr.id as search_result_id, sr.search_id, sr.latest_audit_id, cur.status as pointed_status
from search_results sr
join businesses b on b.id = sr.business_id
left join audits cur on cur.id = sr.latest_audit_id
where b.id::text like 'e08e4ffd%';

select a.id, a.status, a.website_health_score, a.sellability_score, a.created_at, a.completed_at
from audits a
join businesses b on b.id = a.business_id
where b.id::text like 'e08e4ffd%'
order by a.created_at desc;


-- ===========================================================================
-- PART 2 — repoint (one transaction)
-- ===========================================================================

begin;

with newest as (
  select distinct on (business_id)
         business_id, id as audit_id
  from audits
  where status = 'completed' and completed_at is not null
  order by business_id, completed_at desc, created_at desc
)
update search_results sr
set latest_audit_id = n.audit_id
from newest n
where n.business_id = sr.business_id
  and sr.latest_audit_id is distinct from n.audit_id
returning sr.id as search_result_id, sr.search_id, sr.business_id, sr.latest_audit_id as new_audit_id;

commit;


-- ===========================================================================
-- PART 3 — verify (read-only)
-- ===========================================================================

-- Expect 0.
with newest as (
  select distinct on (business_id)
         business_id, id as audit_id
  from audits
  where status = 'completed' and completed_at is not null
  order by business_id, completed_at desc, created_at desc
)
select count(*) as rows_still_differing
from search_results sr
join newest n on n.business_id = sr.business_id
where sr.latest_audit_id is distinct from n.audit_id;

-- Expect every Accurbore row to point at aaa0e4ce… with status 'completed'.
select sr.id as search_result_id, sr.latest_audit_id, a.status, a.website_health_score, a.sellability_score, a.completed_at
from search_results sr
join businesses b on b.id = sr.business_id
left join audits a on a.id = sr.latest_audit_id
where b.id::text like 'e08e4ffd%';

-- Pointers that still sit on a non-completed audit: businesses that have
-- never completed one (expected: these show the RFL-03 chips in the UI).
select a.status, count(*) as rows
from search_results sr
join audits a on a.id = sr.latest_audit_id
where a.status <> 'completed'
group by a.status
order by a.status;
