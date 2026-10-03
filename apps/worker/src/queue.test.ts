/**
 * Stale-claim reclaim (audit finding 5) against MemoryStore: jobs and
 * agent_runs a dead worker left 'running' are requeued or failed, fresh
 * claims are untouched, and the search settles out of 'auditing'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, Search } from "@rapidforge/shared";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import { FixtureWebProbe } from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import {
  FixtureScreenshotCapturer,
  FixtureScreenshotStorage,
} from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import type { OrchestratorDeps } from "./orchestrator";
import {
  MAX_JOB_ATTEMPTS,
  STALE_AFTER_MS,
  STALE_REASON,
  reclaimStaleJobs,
} from "./queue";
import { MemoryStore } from "./store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "./store/types";

const T0 = new Date("2026-07-06T07:00:00.000Z");
const MINUTE = 60_000;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

describe("reclaimStaleJobs (MemoryStore)", () => {
  let store: MemoryStore;
  let deps: OrchestratorDeps;
  let search: Search;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83642", radius_miles: 10 },
      category: "plumber",
    });
    await store.updateSearch(search.id, { status: "auditing" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function enqueueAudit(businessId: string): Promise<Job> {
    return store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: { search_id: search.id, business_id: businessId },
    });
  }

  /** Claim the next queued job at the given time (sets started_at). */
  async function claimAt(when: Date): Promise<Job> {
    vi.setSystemTime(when);
    const job = await store.claimNextQueuedJob();
    if (!job) throw new Error("nothing to claim");
    return job;
  }

  it("requeues a stale running job that still has attempts left", async () => {
    await enqueueAudit("biz-1");
    const job = await claimAt(T0);
    expect(job.attempts).toBe(1);

    const result = await reclaimStaleJobs(deps, { now: at(11 * MINUTE) });

    expect(result.requeued.map((j) => j.id)).toEqual([job.id]);
    expect(result.requeued[0]).toMatchObject({
      status: "queued",
      error: STALE_REASON,
      finished_at: null,
    });
    expect(result.failed).toEqual([]);
    // Back in the queue: the next claim picks it up as attempt 2.
    const reclaimed = await claimAt(at(12 * MINUTE));
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.attempts).toBe(MAX_JOB_ATTEMPTS);
    // Still active, so the search is not settled.
    expect((await store.getSearch(search.id))?.status).toBe("auditing");
  });

  it("fails a stale job that is out of attempts and settles its search", async () => {
    await enqueueAudit("biz-1");
    const first = await claimAt(T0);
    await store.finishJob(first.id, { status: "queued", error: "boom" });
    const second = await claimAt(at(1 * MINUTE));
    expect(second.attempts).toBe(MAX_JOB_ATTEMPTS);

    const result = await reclaimStaleJobs(deps, { now: at(12 * MINUTE) });

    expect(result.requeued).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      id: first.id,
      status: "failed",
      error: STALE_REASON,
    });
    expect(result.failed[0]?.finished_at).not.toBeNull();
    expect(await store.claimNextQueuedJob()).toBeNull();
    // settleSearchIfDone fired: no active jobs left → search leaves 'auditing'.
    const settled = await store.getSearch(search.id);
    expect(settled?.status).toBe("completed");
    expect(settled?.completed_at).not.toBeNull();
    expect((await store.getSearchDetail(search.id))?.job_counts).toMatchObject({
      queued: 0,
      running: 0,
      failed: 1,
    });
  });

  it("leaves a fresh running job alone and does not settle early", async () => {
    await enqueueAudit("biz-stale");
    await enqueueAudit("biz-fresh");
    const stale = await claimAt(T0);
    const fresh = await claimAt(at(5 * MINUTE));

    const result = await reclaimStaleJobs(deps, { now: at(11 * MINUTE) });

    expect(result.requeued.map((j) => j.id)).toEqual([stale.id]);
    expect(result.failed).toEqual([]);
    const counts = (await store.getSearchDetail(search.id))?.job_counts;
    expect(counts).toMatchObject({ queued: 1, running: 1 });
    expect(fresh.status).toBe("running");
    expect((await store.getSearch(search.id))?.status).toBe("auditing");
  });

  it("never reclaims jobs (or their runs) this process still has in flight", async () => {
    await enqueueAudit("biz-1");
    const job = await claimAt(T0);
    await store.insertAgentRun({
      workspace_id: DEV_WORKSPACE_ID,
      agent_name: "filter",
      job_id: job.id,
      target_id: "biz-1",
      input: { search_id: search.id },
    });

    const result = await reclaimStaleJobs(deps, {
      now: at(30 * MINUTE),
      inFlightJobIds: [job.id],
    });

    expect(result).toEqual({ requeued: [], failed: [], agentRunsFailed: [] });
  });

  it("fails stale agent_runs and leaves fresh ones running", async () => {
    vi.setSystemTime(T0);
    const staleRun = await store.insertAgentRun({
      workspace_id: DEV_WORKSPACE_ID,
      agent_name: "health",
      job_id: null,
      target_id: "biz-1",
      input: { search_id: search.id },
    });
    vi.setSystemTime(at(8 * MINUTE));
    const freshRun = await store.insertAgentRun({
      workspace_id: DEV_WORKSPACE_ID,
      agent_name: "design",
      job_id: null,
      target_id: "biz-2",
      input: { search_id: search.id },
    });

    const result = await reclaimStaleJobs(deps, { now: at(11 * MINUTE) });

    expect(result.agentRunsFailed).toHaveLength(1);
    expect(result.agentRunsFailed[0]).toMatchObject({
      id: staleRun.id,
      status: "failed",
      error: STALE_REASON,
    });
    expect(result.agentRunsFailed[0]?.ended_at).not.toBeNull();
    const states = (await store.getSearchDetail(search.id))?.agent_states ?? [];
    expect(states.find((r) => r.id === freshRun.id)?.status).toBe("running");
  });

  it("fails the search when a stale scout job is out of attempts", async () => {
    const scout = await store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "scout",
      payload: { search_id: search.id },
    });
    await store.updateSearch(search.id, { status: "scouting" });
    await claimAt(T0);
    await store.finishJob(scout.id, { status: "queued", error: "boom" });
    await claimAt(T0);

    const result = await reclaimStaleJobs(deps, {
      now: at(STALE_AFTER_MS + MINUTE),
    });

    expect(result.failed.map((j) => j.id)).toEqual([scout.id]);
    expect((await store.getSearch(search.id))?.status).toBe("failed");
  });
});
