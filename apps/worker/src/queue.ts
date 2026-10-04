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
import { StageAbortedError, withBudget } from "./lib/budget";
import {
  AUDIT_CEILING_MS,
  AUDIT_CONCURRENCY_CAP,
  handleJob,
  settleSearchIfDone,
  type HandleJobOptions,
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

/**
 * In-process hang recovery (RFL.QUEUE.8): a job this process still holds
 * past the whole-audit ceiling + this grace is abandoned — its controller
 * aborted, the job failed, the slot released. The DB-side reclaim above
 * deliberately skips jobs this process holds; this covers them.
 */
export const ABANDON_GRACE_MS = 30_000;
export const ABANDON_AFTER_MS = AUDIT_CEILING_MS + ABANDON_GRACE_MS;
export const ABANDON_REASON = "worker: audit exceeded ceiling";
/** A claim that does not answer in this long must not wedge the tick. */
export const CLAIM_BUDGET_MS = 10_000;

/**
 * Liveness watchdog (RFL.QUEUE.8a): one "[queue] tick" line every 10s. If
 * these lines stop, the event loop is blocked; a line that arrives late
 * reports how long it was blocked.
 */
export const WATCHDOG_INTERVAL_MS = 10_000;
/** A watchdog firing this much later than scheduled = the loop was blocked. */
export const WATCHDOG_LAG_WARN_MS = 2_000;

export interface InFlightJob {
  id: string;
  job_type: string;
  business_id: string | null;
  started_at: string;
  age_ms: number;
}

export interface QueuePoller {
  status: "polling";
  stop(): void;
  inFlight(): number;
  /** Jobs this process holds right now, oldest first (for /health). */
  inFlightJobs(): InFlightJob[];
  /** Run one poller pass now (tests; the interval calls this). */
  tick(): Promise<void>;
}

export interface QueueOptions {
  /** Job runner (tests inject a stub). */
  handle?: (job: Job, deps: OrchestratorDeps, opts: HandleJobOptions) => Promise<void>;
  cap?: number;
  abandonAfterMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

interface Slot {
  job: Job;
  startedAt: number;
  controller: AbortController;
}

export function startQueuePoller(
  deps: OrchestratorDeps,
  options: QueueOptions = {},
): QueuePoller {
  const handle = options.handle ?? handleJob;
  const cap = options.cap ?? AUDIT_CONCURRENCY_CAP;
  const abandonAfterMs = options.abandonAfterMs ?? ABANDON_AFTER_MS;
  const now = options.now ?? (() => Date.now());
  /** Jobs this process is running — the reclaim sweep never touches them. */
  const inFlight = new Map<string, Slot>();
  let stopped = false;
  let ticks = 0;
  /** One tick at a time: a slow claim must not stack ticks on itself. */
  let ticking = false;

  async function abandonOverrun(): Promise<void> {
    const cutoff = now() - abandonAfterMs;
    for (const [id, slot] of inFlight) {
      if (slot.startedAt > cutoff) continue;
      inFlight.delete(id); // slot released first — the next claim can proceed
      slot.controller.abort(new StageAbortedError("audit"));
      console.error(
        `[queue] job ${id} (${slot.job.job_type}, business ${businessIdOf(slot.job)}) abandoned after ${Math.round((now() - slot.startedAt) / 1000)}s — ${ABANDON_REASON}`,
      );
      try {
        await deps.store.finishJob(id, { status: "failed", error: ABANDON_REASON });
        await markSearchFailedIfScout(slot.job, deps, ABANDON_REASON);
        await settleSearchIfDone(slot.job, deps);
      } catch (err) {
        console.error(`[queue] abandon bookkeeping for ${id} failed:`, err);
      }
    }
  }

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await abandonOverrun();
      // N free slots → up to N claims, every tick, regardless of what the
      // other slots are doing.
      while (!stopped && inFlight.size < cap) {
        const job = await withBudget("claim", CLAIM_BUDGET_MS, () =>
          deps.store.claimNextQueuedJob(),
        );
        if (!job) return;
        const controller = new AbortController();
        inFlight.set(job.id, { job, startedAt: now(), controller });
        console.log(
          `[queue] claimed job ${job.id} (${job.job_type}, business ${businessIdOf(job)}) — in flight ${inFlight.size}/${cap}`,
        );
        void processJob(job, deps, handle, controller.signal)
          .catch((err) =>
            console.error(`[queue] job ${job.id} crashed the runner:`, err),
          )
          .finally(() => {
            inFlight.delete(job.id);
          });
      }
    } finally {
      ticking = false;
    }
  }

  async function reclaim(): Promise<void> {
    try {
      await reclaimStaleJobs(deps, { inFlightJobIds: [...inFlight.keys()] });
    } catch (err) {
      console.error("[queue] stale reclaim failed:", err);
    }
  }

  const timer = setInterval(() => {
    ticks += 1;
    if (ticks % RECLAIM_EVERY_TICKS === 0) void reclaim();
    void tick().catch((err) => console.error("[queue] tick failed:", err));
  }, POLL_INTERVAL_MS);

  let lastBeat = now();
  const watchdog = setInterval(() => {
    const beat = now();
    const lagMs = Math.max(0, beat - lastBeat - WATCHDOG_INTERVAL_MS);
    lastBeat = beat;
    let oldestMs = 0;
    for (const slot of inFlight.values()) oldestMs = Math.max(oldestMs, beat - slot.startedAt);
    console.log(
      `[queue] tick jobs_in_flight=${inFlight.size}/${cap}${inFlight.size > 0 ? ` oldest_s=${Math.round(oldestMs / 1000)}` : ""} lag_ms=${lagMs}`,
    );
    if (lagMs > WATCHDOG_LAG_WARN_MS) {
      console.warn(
        `[queue] event loop was blocked for ~${Math.round(lagMs / 1000)}s — a synchronous call stalled the worker`,
      );
    }
  }, WATCHDOG_INTERVAL_MS);
  // Startup: sweep orphans from a previous process first, then an immediate
  // first pass — don't make POST wait 2s.
  void reclaim().then(() =>
    tick().catch((err) => console.error("[queue] tick failed:", err)),
  );

  console.log(
    `[queue] polling jobs every ${POLL_INTERVAL_MS}ms (store: ${deps.store.mode}, cap: ${cap}, abandon after ${Math.round(abandonAfterMs / 1000)}s)`,
  );
  return {
    status: "polling",
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearInterval(watchdog);
    },
    inFlight: () => inFlight.size,
    inFlightJobs: () =>
      [...inFlight.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((s) => ({
          id: s.job.id,
          job_type: s.job.job_type,
          business_id: businessIdOf(s.job) === "-" ? null : businessIdOf(s.job),
          started_at: new Date(s.startedAt).toISOString(),
          age_ms: now() - s.startedAt,
        })),
    tick,
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

async function processJob(
  job: Job,
  deps: OrchestratorDeps,
  handle: NonNullable<QueueOptions["handle"]>,
  signal: AbortSignal,
): Promise<void> {
  try {
    await handle(job, deps, { signal });
    if (signal.aborted) return; // abandoned meanwhile — the queue already failed it
    await deps.store.finishJob(job.id, { status: "done" });
  } catch (err) {
    if (signal.aborted) return; // the abandon path owns the bookkeeping
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
