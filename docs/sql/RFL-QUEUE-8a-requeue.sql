-- RFL.QUEUE.8a — requeue the 4 audit jobs the browser-launch hang left behind.
--
-- WRITE-ONLY from Claude Code. Joey pastes this into the Supabase web SQL
-- editor himself; nothing here has been executed by tooling.
--
-- Live run 2026-10-03 20:27 MT (= 2026-10-04 02:27 UTC): search 83686/plumber,
-- the post-QUEUE.8 worker claimed 5 audit_business jobs at 02:27:48Z. One
-- froze the event loop in the screenshot stage's puppeteer-core load; 4 jobs
-- are still 'running' (attempts 1) with their Filter-created audits 'pending'.
--
-- HOW TO RUN
--   0. Stop the hung worker (Ctrl+C; if it ignores that, Stop-Process -Id <its
--      node PID>). Pull the RFL.QUEUE.8a code. Leave SCREENSHOTS_ENABLED unset.
--   1. PART 1 (read-only): expect exactly 4 job rows, each with its pending
--      audit. If the count is not 4, stop and check before going further.
--   2. PART 2: one transaction. It aborts itself unless exactly 4 jobs match.
--      Pending audits → failed, leftover running agent_runs → failed, jobs →
--      queued with attempts 0 (two fresh tries each).
--   3. PART 3 (read-only): verify, then start the worker (npm run dev).
--
-- Without this script the new worker's startup sweep would still requeue the
-- jobs (they are > 10 min stale), but with attempts 1/2 — one try left — and
-- the old pending audits would stay behind.

-- ===========================================================================
-- PART 1 — preview: expect exactly 4 rows
-- ===========================================================================

select j.id as job_id, j.status, j.attempts, j.started_at,
       b.name, b.website_url,
       a.id as pending_audit_id, a.status as audit_status, a.created_at as audit_created_at
from jobs j
join searches s on s.id::text = j.payload->>'search_id'
join businesses b on b.id::text = j.payload->>'business_id'
left join audits a on a.business_id = b.id
  and a.status = 'pending'
  and a.created_at >= '2026-10-04T02:27:48Z' and a.created_at < '2026-10-04T02:28:48Z'
where j.job_type = 'audit_business'
  and j.status = 'running'
  and j.started_at >= '2026-10-04T02:27:48Z' and j.started_at < '2026-10-04T02:28:48Z'
  and s.category = 'plumber' and s.params->>'zip' = '83686'
order by j.started_at;

-- ===========================================================================
-- PART 2 — requeue (one transaction; aborts unless exactly 4 jobs match)
-- ===========================================================================

begin;

do $$
declare n int;
begin
  select count(*) into n
  from jobs j
  join searches s on s.id::text = j.payload->>'search_id'
  where j.job_type = 'audit_business'
    and j.status = 'running'
    and j.started_at >= '2026-10-04T02:27:48Z' and j.started_at < '2026-10-04T02:28:48Z'
    and s.category = 'plumber' and s.params->>'zip' = '83686';
  if n <> 4 then
    raise exception 'RFL.QUEUE.8a: expected 4 stuck jobs, found % — nothing changed', n;
  end if;
end $$;

-- 2a. Their Filter-created pending audits → failed (the re-run inserts fresh rows).
--     Runs before 2c: it finds the businesses through the still-'running' jobs.
update audits a
set status = 'failed',
    error_message = 'stale: worker hung in the screenshot browser launch (RFL.QUEUE.8a)',
    completed_at = now()
from jobs j
join searches s on s.id::text = j.payload->>'search_id'
where a.business_id::text = j.payload->>'business_id'
  and a.status = 'pending'
  and a.created_at >= '2026-10-04T02:27:48Z' and a.created_at < '2026-10-04T02:28:48Z'
  and j.job_type = 'audit_business'
  and j.status = 'running'
  and j.started_at >= '2026-10-04T02:27:48Z' and j.started_at < '2026-10-04T02:28:48Z'
  and s.category = 'plumber' and s.params->>'zip' = '83686'
returning a.id, a.business_id, a.status;

-- 2b. Any agent_runs those jobs left 'running' → failed.
update agent_runs r
set status = 'failed',
    error = 'stale: worker hung (RFL.QUEUE.8a)',
    ended_at = now()
from jobs j
join searches s on s.id::text = j.payload->>'search_id'
where r.job_id = j.id
  and r.status = 'running'
  and j.job_type = 'audit_business'
  and j.status = 'running'
  and j.started_at >= '2026-10-04T02:27:48Z' and j.started_at < '2026-10-04T02:28:48Z'
  and s.category = 'plumber' and s.params->>'zip' = '83686'
returning r.id, r.agent_name;

-- 2c. The 4 jobs → queued, attempts reset so each gets its two tries again.
update jobs j
set status = 'queued',
    attempts = 0,
    error = 'requeued: worker hung in the screenshot browser launch on 2026-10-04 (RFL.QUEUE.8a)',
    started_at = null,
    finished_at = null
from searches s
where s.id::text = j.payload->>'search_id'
  and j.job_type = 'audit_business'
  and j.status = 'running'
  and j.started_at >= '2026-10-04T02:27:48Z' and j.started_at < '2026-10-04T02:28:48Z'
  and s.category = 'plumber' and s.params->>'zip' = '83686'
returning j.id, j.status, j.attempts;

commit;

-- ===========================================================================
-- PART 3 — verify
-- ===========================================================================

-- Expect: running = 0, and the 4 requeued jobs counted under queued.
select s.id, s.status,
       count(*) filter (where j.status = 'running') as running,
       count(*) filter (where j.status = 'queued')  as queued,
       count(*) filter (where j.status = 'done')    as done,
       count(*) filter (where j.status = 'failed')  as failed
from searches s
join jobs j on j.payload->>'search_id' = s.id::text
where s.category = 'plumber' and s.params->>'zip' = '83686'
group by s.id, s.status, s.created_at
order by s.created_at desc
limit 1;

-- Expect: 4 rows, status queued, attempts 0.
select j.id, j.status, j.attempts, b.name
from jobs j
join businesses b on b.id::text = j.payload->>'business_id'
where j.job_type = 'audit_business'
  and j.error like 'requeued: worker hung in the screenshot browser launch%'
  and j.status = 'queued';

-- Expect: no 'pending' audits left from the 02:27 window.
select count(*) as still_pending
from audits
where status = 'pending'
  and created_at >= '2026-10-04T02:27:48Z' and created_at < '2026-10-04T02:28:48Z';
