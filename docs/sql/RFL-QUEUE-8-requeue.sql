-- RFL.QUEUE.8 — requeue the one job the hung worker left behind (2026-10-03).
--
-- WRITE-ONLY from Claude Code. Joey pastes this into the Supabase web SQL
-- editor himself; nothing here has been executed by tooling.
--
-- Live run 2026-10-03: search 83686/plumber, Accurbore (http://www.accurbore.com/)
-- audit_business job went 'running' at 20:43:47Z (attempts 1) and the worker
-- hung on it. The in-process reclaim skips jobs the process holds, so the row
-- is still 'running' and its Filter-created audit is still 'pending'.
--
-- HOW TO RUN: stop the old worker first (it still "holds" the job).
--   1. PART 1 (read-only) — confirm exactly one row matches.
--   2. PART 2 — one transaction: job back to queued with attempts 0 (the
--      RFL.QUEUE.8 worker re-runs it under stage budgets), pending audit failed.
--   3. PART 3 (read-only) — verify, then start the new worker.

-- ===========================================================================
-- PART 1 — preview: expect exactly one job row
-- ===========================================================================

select j.id, j.status, j.attempts, j.started_at, j.payload->>'business_id' as business_id,
       b.name, b.website_url
from jobs j
join businesses b on b.id::text = j.payload->>'business_id'
where j.job_type = 'audit_business'
  and j.status = 'running'
  and j.started_at >= '2026-10-03T20:43:00Z' and j.started_at < '2026-10-03T20:44:30Z'
  and b.website_url ilike '%accurbore.com%';

-- ===========================================================================
-- PART 2 — requeue (one transaction)
-- ===========================================================================

begin;

-- 2a. The stuck job → queued, attempts reset so it gets its two tries again.
update jobs j
set status = 'queued',
    attempts = 0,
    error = 'requeued: worker hung on this job on 2026-10-03 (RFL.QUEUE.8)',
    started_at = null,
    finished_at = null
from businesses b
where b.id::text = j.payload->>'business_id'
  and j.job_type = 'audit_business'
  and j.status = 'running'
  and j.started_at >= '2026-10-03T20:43:00Z' and j.started_at < '2026-10-03T20:44:30Z'
  and b.website_url ilike '%accurbore.com%'
returning j.id, j.status, j.attempts;

-- 2b. Its Filter-created pending audit → failed (the re-run inserts a fresh row).
update audits a
set status = 'failed',
    error_message = 'stale: worker hung before the audit agents ran (RFL.QUEUE.8)',
    completed_at = now()
from businesses b
where a.business_id = b.id
  and b.website_url ilike '%accurbore.com%'
  and a.status = 'pending'
  and a.created_at >= '2026-10-03T20:43:00Z' and a.created_at < '2026-10-03T20:44:30Z'
returning a.id, a.status;

-- 2c. Any agent_runs left 'running' for that business → failed.
update agent_runs r
set status = 'failed',
    error = 'stale: worker hung (RFL.QUEUE.8)',
    ended_at = now()
from businesses b
where r.target_id = b.id
  and b.website_url ilike '%accurbore.com%'
  and r.status = 'running'
returning r.id, r.agent_name;

commit;

-- ===========================================================================
-- PART 3 — verify
-- ===========================================================================

-- Expect: one queued job with attempts 0, no running job, no pending audit.
select j.status, j.attempts, j.started_at
from jobs j join businesses b on b.id::text = j.payload->>'business_id'
where b.website_url ilike '%accurbore.com%' and j.job_type = 'audit_business'
order by j.created_at desc limit 3;

select a.status, a.created_at, a.completed_at
from audits a join businesses b on b.id = a.business_id
where b.website_url ilike '%accurbore.com%'
order by a.created_at desc limit 3;

-- Search 83686/plumber should show 0 running jobs; its remaining queued jobs
-- (8 at the time) drain once the RFL.QUEUE.8 worker starts.
select s.id, s.status,
       (select count(*) from jobs where payload->>'search_id' = s.id::text and status = 'running') as running,
       (select count(*) from jobs where payload->>'search_id' = s.id::text and status = 'queued')  as queued
from searches s
where s.category = 'plumber' and s.params->>'zip' = '83686'
order by s.created_at desc limit 1;
