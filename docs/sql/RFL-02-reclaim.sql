-- RFL-02 — one-off production cleanup for audit finding 5 (stale claims).
--
-- WRITE-ONLY from Claude Code. Joey pastes this into the Supabase web SQL
-- editor himself; nothing here has been executed by tooling.
--
-- Applies the rule the worker now runs on start and every 20 ticks
-- (apps/worker/src/queue.ts → reclaimStaleJobs) to the rows the worker left
-- behind when it was killed on 2026-07-06 (28 jobs, 15 agent_runs, search
-- be85194e frozen in 'auditing' with 12 pending audits at audit time):
--
--   jobs 'running', started_at older than 10 minutes:
--     attempts < 2  → 'queued'  (the worker re-runs them on next start)
--     attempts >= 2 → 'failed'
--   agent_runs 'running', started_at older than 10 minutes → 'failed'
--   error text: 'stale: reclaimed after worker restart'
--
-- plus the settle step the worker does in code: a search whose scout job
-- failed is 'failed'; a search with jobs but none queued/running is
-- 'completed'. Orphaned 'pending' audit rows (older than 10 minutes) are
-- marked 'failed' — a re-run job inserts a fresh audit row and repoints
-- search_results.latest_audit_id, so the old pending row is never finished.
--
-- HOW TO RUN
--   0. Stop the worker first, so nothing is genuinely mid-flight.
--   1. Select PART 1 and run it (read-only). Note the counts.
--   2. Select PART 2 and run it. It is one transaction (all or nothing,
--      ends in COMMIT); the RETURNING rows are what changed. Choose 2a or
--      OPTION B before running — see SPEND NOTE.
--   3. Select PART 3 and run it (read-only) to verify.
--   4. Start the worker (npm run dev). Requeued jobs re-run immediately;
--      when the last one finishes the worker settles their search itself.
--
-- SPEND NOTE: requeued audit_business jobs re-run Filter + PSI + the audit
-- agents (and the AI agents if ANTHROPIC_API_KEY is set). If you would
-- rather NOT re-run the 2026-07-06 hair-salon jobs, use the OPTION B
-- statement in PART 2 instead of 2a (it fails every stale job) and then
-- every affected search settles from this script alone.


-- ===========================================================================
-- PART 1 — preview (read-only)
-- ===========================================================================

select status, count(*) as jobs,
       count(*) filter (where coalesce(attempts, 0) < 2) as would_requeue,
       count(*) filter (where coalesce(attempts, 0) >= 2) as would_fail,
       min(started_at) as oldest_started, max(started_at) as newest_started
from jobs
where status = 'running'
  and started_at < now() - interval '10 minutes'
group by status;

select count(*) as stale_agent_runs, min(started_at), max(started_at)
from agent_runs
where status = 'running'
  and started_at < now() - interval '10 minutes';

select count(*) as orphaned_pending_audits, min(created_at), max(created_at)
from audits
where status = 'pending'
  and created_at < now() - interval '10 minutes';

-- Search be85194e (the frozen hair-salon search) — full id, state, job mix,
-- and how many of its leads point at a pending audit.
select s.id, s.status, s.category, s.created_at,
       (select count(*) from jobs j
         where j.payload->>'search_id' = s.id::text
           and j.status = 'running') as running_jobs,
       (select count(*) from jobs j
         where j.payload->>'search_id' = s.id::text
           and j.status = 'queued') as queued_jobs,
       (select count(*) from search_results sr
          join audits a on a.id = sr.latest_audit_id
         where sr.search_id = s.id and a.status = 'pending') as pending_audits
from searches s
where s.id::text like 'be85194e%';


-- ===========================================================================
-- PART 2 — cleanup (one transaction)
-- ===========================================================================

begin;

-- 2a. Stale jobs with attempts left → back to the queue.
update jobs
set status = 'queued',
    error = 'stale: reclaimed after worker restart',
    finished_at = null
where status = 'running'
  and started_at < now() - interval '10 minutes'
  and coalesce(attempts, 0) < 2
returning id, job_type, payload->>'search_id' as search_id,
          payload->>'business_id' as business_id, attempts, 'queued' as now_status;

-- OPTION B (instead of 2a — no re-run spend): fail every stale job.
-- update jobs
-- set status = 'failed',
--     error = 'stale: reclaimed after worker restart',
--     finished_at = now()
-- where status = 'running'
--   and started_at < now() - interval '10 minutes'
-- returning id, job_type, payload->>'search_id' as search_id,
--           payload->>'business_id' as business_id, attempts, 'failed' as now_status;

-- 2b. Stale jobs out of attempts → failed.
update jobs
set status = 'failed',
    error = 'stale: reclaimed after worker restart',
    finished_at = now()
where status = 'running'
  and started_at < now() - interval '10 minutes'
  and coalesce(attempts, 0) >= 2
returning id, job_type, payload->>'search_id' as search_id,
          payload->>'business_id' as business_id, attempts, 'failed' as now_status;

-- 2c. Stale agent_runs → failed.
update agent_runs
set status = 'failed',
    error = 'stale: reclaimed after worker restart',
    ended_at = now()
where status = 'running'
  and started_at < now() - interval '10 minutes'
returning id, agent_name, job_id, target_id as business_id;

-- 2d. Orphaned pending audits → failed (re-runs insert a fresh audit row).
update audits
set status = 'failed',
    error_message = 'stale: reclaimed after worker restart',
    completed_at = now()
where status = 'pending'
  and created_at < now() - interval '10 minutes'
returning id, business_id;

-- 2e. A search whose scout job failed (and never succeeded) is failed —
--     same as the worker's markSearchFailedIfScout.
update searches s
set status = 'failed',
    completed_at = now()
where s.status not in ('completed', 'failed')
  and exists (select 1 from jobs j
               where j.job_type = 'scout'
                 and j.payload->>'search_id' = s.id::text
                 and j.status = 'failed')
  and not exists (select 1 from jobs j
                   where j.job_type = 'scout'
                     and j.payload->>'search_id' = s.id::text
                     and j.status in ('queued', 'running', 'done'))
returning s.id, s.category, 'failed' as now_status;

-- 2f. Settle: a search with jobs but none queued/running is completed —
--     same as the worker's settleSearchIfDone. With 2a (requeue), searches
--     that still have queued jobs stay 'auditing' until the worker finishes
--     them and settles them itself.
update searches s
set status = 'completed',
    completed_at = now()
where s.status not in ('completed', 'failed')
  and exists (select 1 from jobs j
               where j.payload->>'search_id' = s.id::text)
  and not exists (select 1 from jobs j
                   where j.payload->>'search_id' = s.id::text
                     and j.status in ('queued', 'running'))
returning s.id, s.category, 'completed' as now_status;

commit;


-- ===========================================================================
-- PART 3 — verify (read-only)
-- ===========================================================================

-- Expect 0 rows in both.
select id, job_type, started_at from jobs
where status = 'running' and started_at < now() - interval '10 minutes';

select id, agent_name, started_at from agent_runs
where status = 'running' and started_at < now() - interval '10 minutes';

-- be85194e: with 2a expect status 'auditing' + queued_jobs > 0 until the
-- worker drains them (then 'completed'); with OPTION B expect 'completed'
-- and 0 queued. pending_audits should be 0 either way.
select s.id, s.status, s.completed_at,
       (select count(*) from jobs j
         where j.payload->>'search_id' = s.id::text
           and j.status = 'queued') as queued_jobs,
       (select count(*) from search_results sr
          join audits a on a.id = sr.latest_audit_id
         where sr.search_id = s.id and a.status = 'pending') as pending_audits
from searches s
where s.id::text like 'be85194e%';
