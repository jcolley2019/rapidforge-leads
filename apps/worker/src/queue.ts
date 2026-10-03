/**
 * Postgres-backed job queue poller (PRD 3.1 / CLAUDE.md Section 4).
 * The queue IS the `jobs` table — a 2s poller, NO BullMQ/Redis, ever.
 *
 * Sprint 2: fully live. The poller runs against whichever DataStore was
 * selected (MemoryStore without env — the queue works with zero external
 * services). Each tick claims jobs until AUDIT_CONCURRENCY_CAP jobs are
 * in flight; failed jobs retry once, then park as 'failed'.
 *
 * Stale-claim reclaim (audit finding 5): on start and every
 * RECLAIM_EVERY_TICKS ticks, jobs/agent_runs left 'running' by a dead
 * worker for over STALE_AFTER_MS are requeued (or failed when out of
 * attempts) so their search can settle.
 */
import type { Job } from "@rapidforge/shared";
import {
  AUDIT_CONCURRENCY_CAP,
  handleJob,
  settleSearchIfDone,
  type OrchestratorDeps,
} from "./orchestrator";
import type { ReclaimStaleResult } from "./store/types";

export const POLL_INTERVAL_MS = 2000;

/** attempts is incremented at claim time; 2 = one retry after failure. */
export const MAX_JOB_ATTEMPTS = 2;

/** A job/agent_run 'running' longer than this was orphaned by a restart. */
export const STALE_AFTER_MS = 10 * 60_000;
/** Re-sweep every N ticks (20 × 2s = 40s) after the startup sweep. */
export const RECLAIM_EVERY_TICKS = 20;
export const STALE_REASON = "stale: reclaimed after worker restart";

export interface QueuePoller {
  status: "polling";
  stop(): void;
  inFlight(): number;
}

export function startQueuePoller(deps: OrchestratorDeps): QueuePoller {
  /** Job ids this process is running — the reclaim sweep never touches them. */
  const inFlight = new Set<string>();
  let stopped = false;
  let ticks = 0;

  async function tick(): Promise<void> {
    while (!stopped && inFlight.size < AUDIT_CONCURRENCY_CAP) {
      const job = await deps.store.claimNextQueuedJob();
      if (!job) return;
      inFlight.add(job.id);
      void processJob(job, deps)
        .catch((err) =>
          console.error(`[queue] job ${job.id} crashed the runner:`, err),
        )
        .finally(() => {
          inFlight.delete(job.id);
        });
    }
  }

  async function reclaim(): Promise<void> {
    try {
      await reclaimStaleJobs(deps, { inFlightJobIds: [...inFlight] });
    } catch (err) {
      console.error("[queue] stale reclaim failed:", err);
    }
  }

  const timer = setInterval(() => {
    ticks += 1;
    if (ticks % RECLAIM_EVERY_TICKS === 0) void reclaim();
    void tick().catch((err) => console.error("[queue] tick failed:", err));
  }, POLL_INTERVAL_MS);
  // Startup: sweep orphans from a previous process first, then an immediate
  // first pass — don't make POST wait 2s.
  void reclaim().then(() =>
    tick().catch((err) => console.error("[queue] tick failed:", err)),
  );

  console.log(
    `[queue] polling jobs every ${POLL_INTERVAL_MS}ms (store: ${deps.store.mode}, cap: ${AUDIT_CONCURRENCY_CAP})`,
  );
  return {
    status: "polling",
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    inFlight: () => inFlight.size,
  };
}

/**
 * One stale-claim sweep. Requeued jobs are picked up by the next tick;
 * jobs out of attempts fail (a failed scout fails its search) and their
 * searches are settled so nothing sits in 'auditing' forever.
 */
export async function reclaimStaleJobs(
  deps: OrchestratorDeps,
  opts: { now?: Date; inFlightJobIds?: readonly string[] } = {},
): Promise<ReclaimStaleResult> {
  const now = opts.now ?? new Date();
  const result = await deps.store.reclaimStaleWork({
    staleBeforeIso: new Date(now.getTime() - STALE_AFTER_MS).toISOString(),
    maxAttempts: MAX_JOB_ATTEMPTS,
    reason: STALE_REASON,
    excludeJobIds: opts.inFlightJobIds,
  });

  for (const job of result.requeued) {
    console.warn(
      `[queue] reclaimed stale job ${job.id} (${job.job_type}, business ${businessIdOf(job)}) → queued, attempt ${job.attempts ?? 0}/${MAX_JOB_ATTEMPTS}`,
    );
  }
  for (const job of result.failed) {
    console.error(
      `[queue] reclaimed stale job ${job.id} (${job.job_type}, business ${businessIdOf(job)}) → failed: ${STALE_REASON}`,
    );
    await markSearchFailedIfScout(job, deps, STALE_REASON);
  }
  for (const run of result.agentRunsFailed) {
    console.warn(
      `[queue] reclaimed stale agent_run ${run.id} (${run.agent_name}, job ${run.job_id ?? "-"}, business ${run.target_id ?? "-"}) → failed`,
    );
  }

  const settled = new Set<string>();
  for (const job of result.failed) {
    const searchId = (job.payload as { search_id?: string }).search_id;
    if (!searchId || settled.has(searchId)) continue;
    settled.add(searchId);
    await settleSearchIfDone(job, deps);
  }
  return result;
}

function businessIdOf(job: Job): string {
  return (job.payload as { business_id?: string }).business_id ?? "-";
}

async function processJob(job: Job, deps: OrchestratorDeps): Promise<void> {
  try {
    await handleJob(job, deps);
    await deps.store.finishJob(job.id, { status: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts ?? 1;
    if (attempts < MAX_JOB_ATTEMPTS) {
      console.warn(
        `[queue] job ${job.id} (${job.job_type}) failed, retrying: ${message}`,
      );
      await deps.store.finishJob(job.id, { status: "queued", error: message });
    } else {
      console.error(
        `[queue] job ${job.id} (${job.job_type}) failed terminally: ${message}`,
      );
      await deps.store.finishJob(job.id, { status: "failed", error: message });
      await markSearchFailedIfScout(job, deps, message);
    }
  }
  await settleSearchIfDone(job, deps);
}

/** A terminally-failed scout means the search itself failed. */
async function markSearchFailedIfScout(
  job: Job,
  deps: OrchestratorDeps,
  error: string,
): Promise<void> {
  if (job.job_type !== "scout") return;
  const searchId = (job.payload as { search_id?: string }).search_id;
  if (!searchId) return;
  await deps.store.updateSearch(searchId, {
    status: "failed",
    completed_at: new Date().toISOString(),
  });
  console.error(`[queue] search ${searchId} failed: ${error}`);
}
