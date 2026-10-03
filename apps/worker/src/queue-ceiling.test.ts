/**
 * Queue slot accounting + in-process hang recovery (RFL.QUEUE.8): with cap 5
 * and one job that hangs past the ceiling, the other slots keep claiming,
 * the hung job is abandoned and failed at ceiling + 30s, its slot released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@rapidforge/shared";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import { FixtureWebProbe } from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import { FixtureScreenshotCapturer, FixtureScreenshotStorage } from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import { AUDIT_CEILING_MS, type OrchestratorDeps } from "./orchestrator";
import { ABANDON_AFTER_MS, ABANDON_REASON, startQueuePoller, type QueuePoller } from "./queue";
import { MemoryStore } from "./store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "./store/types";

describe("queue slot accounting and ceiling abandon (RFL.QUEUE.8)", () => {
  let store: MemoryStore;
  let deps: OrchestratorDeps;
  let poller: QueuePoller | null = null;
  let searchId: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    const search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83642", radius_miles: 5 },
      category: "plumber",
    });
    searchId = search.id;
    await store.updateSearch(searchId, { status: "auditing" });
  });
  afterEach(() => {
    poller?.stop();
    poller = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function enqueue(n: number): Promise<Job[]> {
    const jobs: Job[] = [];
    for (let i = 0; i < n; i += 1) {
      jobs.push(
        await store.enqueueJob({
          workspace_id: DEV_WORKSPACE_ID,
          job_type: "audit_business",
          payload: { search_id: searchId, business_id: `biz-${i}` },
        }),
      );
    }
    return jobs;
  }

  it("one hung job never blocks the other slots; it is abandoned at ceiling+30s and its slot reused", async () => {
    const jobs = await enqueue(13);
    const hungId = jobs[0]!.id;
    const handled: string[] = [];
    const abortSeen: string[] = [];
    poller = startQueuePoller(deps, {
      cap: 5,
      handle: async (job, _deps, { signal }) => {
        handled.push(job.id);
        if (job.id === hungId) {
          signal?.addEventListener("abort", () => abortSeen.push(job.id));
          return new Promise<never>(() => undefined); // hangs forever, ignores abort
        }
        await new Promise((r) => setTimeout(r, 1_500)); // a normal fast audit
      },
    });

    // First pass: 5 claimed (cap), one of them the hung job.
    await vi.advanceTimersByTimeAsync(10);
    expect(poller.inFlight()).toBe(5);
    expect(handled).toHaveLength(5);

    // Ticks keep claiming into the 4 free slots while #1 hangs.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(handled).toHaveLength(13); // every queued job got claimed
    expect(poller.inFlight()).toBe(1); // only the hung job remains
    const counts = (await store.getSearchDetail(searchId))!.job_counts;
    expect(counts).toMatchObject({ done: 12, running: 1, queued: 0, failed: 0 });

    // Just before the ceiling + grace: still held.
    await vi.advanceTimersByTimeAsync(ABANDON_AFTER_MS - 20_010 - 1_000);
    expect(poller.inFlight()).toBe(1);
    expect(poller.inFlightJobs()[0]).toMatchObject({ id: hungId, business_id: "biz-0" });

    // Past it: abandoned, failed with the reason, slot released, search settled.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poller.inFlight()).toBe(0);
    expect(abortSeen).toEqual([hungId]);
    const after = (await store.getSearchDetail(searchId))!;
    expect(after.job_counts).toMatchObject({ done: 12, failed: 1, running: 0 });
    expect(after.search.status).toBe("completed");
    const reclaim = await store.reclaimStaleWork({
      staleBeforeIso: new Date(Date.now() + 1).toISOString(),
      maxAttempts: 2,
      reason: "x",
    });
    expect(reclaim.requeued).toEqual([]); // nothing left 'running'
    expect(ABANDON_AFTER_MS).toBe(AUDIT_CEILING_MS + 30_000);
    // The failed row carries the ceiling reason (read back via a fresh claim: none).
    expect(await store.claimNextQueuedJob()).toBeNull();
    expect(ABANDON_REASON).toBe("worker: audit exceeded ceiling");
  });

  it("a stuck claim does not wedge the poller: the claim budget expires and later ticks proceed", async () => {
    await enqueue(2);
    let stall = true;
    const realClaim = store.claimNextQueuedJob.bind(store);
    vi.spyOn(store, "claimNextQueuedJob").mockImplementation(() =>
      stall ? new Promise<never>(() => undefined) : realClaim(),
    );
    const handled: string[] = [];
    poller = startQueuePoller(deps, {
      cap: 5,
      handle: async (job) => {
        handled.push(job.id);
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(handled).toHaveLength(0);
    stall = false;
    await vi.advanceTimersByTimeAsync(12_000); // claim budget (10s) + a tick
    expect(handled).toHaveLength(2);
    expect(poller.inFlight()).toBe(0);
  });
});
