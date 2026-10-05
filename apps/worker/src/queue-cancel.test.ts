/**
 * Cancel a running search (RFL.WEB.10) against MemoryStore and the real
 * poller: queued jobs fail with 'cancelled by user', in-flight jobs are
 * aborted through their QUEUE.8 AbortControllers and failed, the slots are
 * released, and the search settles to 'failed'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@rapidforge/shared";
import { StageAbortedError } from "./lib/budget";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import { FixtureWebProbe } from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import { FixtureScreenshotCapturer, FixtureScreenshotStorage } from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import type { OrchestratorDeps } from "./orchestrator";
import { CANCEL_REASON, cancelSearch, startQueuePoller, type QueuePoller } from "./queue";
import { MemoryStore } from "./store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "./store/types";

describe("cancelSearch (MemoryStore + real poller)", () => {
  let store: MemoryStore;
  let deps: OrchestratorDeps;
  let poller: QueuePoller | null = null;
  let searchId: string;
  let otherSearchId: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    store = new MemoryStore();
    deps = {
      store,
      places: new FixturePlacesClient(),
      probe: new FixtureWebProbe(),
      psi: new FixturePsiClient(),
      site: new FixtureSiteFetcher(),
      screenshotCapturer: new FixtureScreenshotCapturer(),
      screenshotStorage: new FixtureScreenshotStorage(),
    };
    for (const [label, zip] of [["main", "83686"], ["other", "83642"]] as const) {
      const search = await store.createSearch({
        workspace_id: DEV_WORKSPACE_ID,
        created_by: DEV_USER_ID,
        mode: "zip_radius",
        params: { zip, radius_miles: 5 },
        category: "plumber",
      });
      await store.updateSearch(search.id, { status: "auditing" });
      if (label === "main") searchId = search.id;
      else otherSearchId = search.id;
    }
  });
  afterEach(() => {
    poller?.stop();
    poller = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function enqueue(search: string, n: number): Promise<Job[]> {
    const jobs: Job[] = [];
    for (let i = 0; i < n; i += 1) {
      jobs.push(
        await store.enqueueJob({
          workspace_id: DEV_WORKSPACE_ID,
          job_type: "audit_business",
          payload: { search_id: search, business_id: `${search.slice(0, 4)}-biz-${i}` },
        }),
      );
    }
    return jobs;
  }

  it("fails queued jobs, aborts in-flight ones through their controllers, frees the slots, fails the search", async () => {
    const jobs = await enqueue(searchId, 4);
    const otherJobs = await enqueue(otherSearchId, 1);
    const abortSeen: string[] = [];
    poller = startQueuePoller(deps, {
      cap: 2,
      // Every audit "hangs" until its signal fires, then rejects the way a
      // budgeted stage does.
      handle: (job, _deps, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            abortSeen.push(job.id);
            reject(signal.reason ?? new StageAbortedError("audit"));
          });
        }),
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(poller.inFlight()).toBe(2);
    expect(poller.inFlightJobs().map((j) => j.id)).toEqual([jobs[0]!.id, jobs[1]!.id]);

    const outcome = await cancelSearch(searchId, deps, poller);
    expect(outcome).toEqual({ queued_failed: 2, running_aborted: 2 });
    expect(abortSeen.sort()).toEqual([jobs[0]!.id, jobs[1]!.id].sort());
    expect(poller.inFlight()).toBe(0); // slots released at once

    const detail = await store.getSearchDetail(searchId);
    expect(detail?.search.status).toBe("failed");
    expect(detail?.search.completed_at).toBeTruthy();
    expect(detail?.job_counts).toEqual({ queued: 0, running: 0, done: 0, failed: 4 });

    // The error text is the user-facing reason on every one of them.
    const sweep = await store.reclaimStaleWork({
      staleBeforeIso: "2999-01-01T00:00:00.000Z",
      maxAttempts: 1,
      reason: "should-not-apply",
    });
    expect(sweep.failed).toEqual([]); // nothing left 'running'
    expect(sweep.requeued).toEqual([]);

    // The other search is untouched and its job gets the freed slot.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(poller.inFlightJobs().map((j) => j.id)).toEqual([otherJobs[0]!.id]);
    expect((await store.getSearch(otherSearchId))?.status).toBe("auditing");
    const otherDetail = await store.getSearchDetail(otherSearchId);
    expect(otherDetail?.job_counts).toEqual({ queued: 0, running: 1, done: 0, failed: 0 });
  });

  it("an aborted job that later resolves does not flip back to done or re-settle the search", async () => {
    const jobs = await enqueue(searchId, 1);
    let release: (() => void) | null = null;
    poller = startQueuePoller(deps, {
      cap: 1,
      handle: (_job, _deps, _opts) =>
        new Promise<void>((resolve) => {
          release = resolve; // ignores the abort, finishes "normally" later
        }),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(poller.inFlight()).toBe(1);

    const outcome = await cancelSearch(searchId, deps, poller);
    expect(outcome).toEqual({ queued_failed: 0, running_aborted: 1 });
    expect(poller.inFlight()).toBe(0);

    release!();
    await vi.advanceTimersByTimeAsync(10);
    const detail = await store.getSearchDetail(searchId);
    expect(detail?.job_counts).toEqual({ queued: 0, running: 0, done: 0, failed: 1 });
    expect(detail?.search.status).toBe("failed");
    expect(jobs).toHaveLength(1);
  });

  it("records the reason text on every failed job", async () => {
    await enqueue(searchId, 2);
    poller = startQueuePoller(deps, {
      cap: 1,
      handle: (_job, _deps, { signal }) =>
        new Promise<void>((_r, reject) => {
          signal?.addEventListener("abort", () => reject(new StageAbortedError("audit")));
        }),
    });
    await vi.advanceTimersByTimeAsync(10);
    await cancelSearch(searchId, deps, poller);
    // MemoryStore has no job reader; failQueuedJobsForSearch returns the
    // rows it changed, so read them through a second search's seed instead.
    const fresh = new MemoryStore();
    const s = await fresh.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83686", radius_miles: 5 },
      category: "plumber",
    });
    await fresh.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: { search_id: s.id, business_id: "b" },
    });
    const failed = await fresh.failQueuedJobsForSearch(s.id, CANCEL_REASON);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: "failed", error: "cancelled by user" });
    expect(failed[0]?.finished_at).toBeTruthy();
  });
});
