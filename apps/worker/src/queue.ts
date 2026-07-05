/**
 * Postgres-backed job queue poller (PRD 3.1 / CLAUDE.md Section 4).
 * The queue IS the `jobs` table — a 2s poller, NO BullMQ/Redis, ever.
 *
 * Sprint 2: fully live. The poller runs against whichever DataStore was
 * selected (MemoryStore without env — the queue works with zero external
 * services). Each tick claims jobs until AUDIT_CONCURRENCY_CAP jobs are
 * in flight; failed jobs retry once, then park as 'failed'.
 */
import type { Job } from "@rapidforge/shared";
import {
  AUDIT_CONCURRENCY_CAP,
  handleJob,
  settleSearchIfDone,
  type OrchestratorDeps,
} from "./orchestrator";

export const POLL_INTERVAL_MS = 2000;

/** attempts is incremented at claim time; 2 = one retry after failure. */
export const MAX_JOB_ATTEMPTS = 2;

export interface QueuePoller {
  status: "polling";
  stop(): void;
  inFlight(): number;
}

export function startQueuePoller(deps: OrchestratorDeps): QueuePoller {
  let inFlight = 0;
  let stopped = false;

  async function tick(): Promise<void> {
    while (!stopped && inFlight < AUDIT_CONCURRENCY_CAP) {
      const job = await deps.store.claimNextQueuedJob();
      if (!job) return;
      inFlight += 1;
      void processJob(job, deps)
        .catch((err) =>
          console.error(`[queue] job ${job.id} crashed the runner:`, err),
        )
        .finally(() => {
          inFlight -= 1;
        });
    }
  }

  const timer = setInterval(() => {
    void tick().catch((err) => console.error("[queue] tick failed:", err));
  }, POLL_INTERVAL_MS);
  void tick(); // immediate first pass — don't make POST wait 2s

  console.log(
    `[queue] polling jobs every ${POLL_INTERVAL_MS}ms (store: ${deps.store.mode}, cap: ${AUDIT_CONCURRENCY_CAP})`,
  );
  return {
    status: "polling",
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    inFlight: () => inFlight,
  };
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
