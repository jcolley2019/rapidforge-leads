/**
 * Postgres-backed job queue poller (PRD 3.1 / CLAUDE.md Section 4).
 * The queue IS the `jobs` table — a 2s poller, NO BullMQ/Redis, ever.
 *
 * Sprint 1: skeleton only. Without Supabase env vars it logs once and
 * no-ops gracefully — `npm run dev` must never crash on a fresh clone.
 */

export const POLL_INTERVAL_MS = 2000;

export interface QueuePoller {
  status: "polling" | "disabled";
  stop(): void;
}

export function startQueuePoller(): QueuePoller {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    console.warn(
      "[queue] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — poller disabled (graceful no-op).",
    );
    return { status: "disabled", stop: () => {} };
  }

  const timer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);

  console.log(`[queue] polling jobs table every ${POLL_INTERVAL_MS}ms`);
  return {
    status: "polling",
    stop: () => clearInterval(timer),
  };
}

/**
 * One poll tick.
 *
 * TODO(Sprint 2):
 *   1. Claim the next queued job atomically — single UPDATE with
 *      `where id = (select id from jobs where status = 'queued'
 *      order by created_at limit 1 for update skip locked)` →
 *      status 'running', started_at, attempts + 1.
 *   2. Dispatch by job_type to the orchestrator (see orchestrator.ts),
 *      respecting the 5-concurrent audit cap (CLAUDE.md Section 8).
 *   3. On success → status 'done', finished_at; on failure → status
 *      'failed' + error text (retry policy decided in Sprint 2).
 */
async function pollOnce(): Promise<void> {
  // Sprint 1: intentionally empty.
}
