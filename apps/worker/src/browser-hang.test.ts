/**
 * RFL.QUEUE.8a — a browser launch can never block the worker. The real queue
 * → orchestrator → PuppeteerScreenshotCapturer → shared browser path, with
 * puppeteer-core mocked:
 *   - a launch that never resolves: the "[queue] tick" watchdog keeps
 *     printing, the 20s launch budget frees the screenshot stage, audits
 *     complete with "Screenshot unavailable (…)" long before the ceiling;
 *   - a job wedged on a never-resolving launch with NO budget at all: ticks
 *     keep printing and the queue abandons it at ceiling + 30s;
 *   - a launch that throws synchronously: same clean degrade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Search } from "@rapidforge/shared";

const pptr = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("puppeteer-core", () => ({ launch: pptr.launch, default: { launch: pptr.launch } }));

import { resetSharedBrowser } from "./lib/browser";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import { FixtureWebProbe } from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import { FixtureScreenshotStorage, PuppeteerScreenshotCapturer } from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import { AUDIT_CEILING_MS, type OrchestratorDeps } from "./orchestrator";
import {
  ABANDON_AFTER_MS,
  ABANDON_REASON,
  WATCHDOG_INTERVAL_MS,
  startQueuePoller,
  type QueuePoller,
} from "./queue";
import { MemoryStore } from "./store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "./store/types";

const NEVER = new Promise<never>(() => undefined);
/** Captured before any test fakes timers: a REAL timer to yield to I/O. */
const realSetTimeout = globalThis.setTimeout;

/** Advance fake time in chunks (no real I/O pending). */
async function advance(ms: number, step = 250): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await new Promise((r) => realSetTimeout(r, 1));
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
  }
}

/** Creep fake time while real I/O (the executable check) is in flight. */
async function until(cond: () => boolean, maxFakeMs = 5_000): Promise<void> {
  for (let t = 0; t < maxFakeMs && !cond(); t += 10) {
    await new Promise((r) => realSetTimeout(r, 2));
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(cond()).toBe(true);
}

type Calls = { mock: { calls: unknown[][] } };
const lines = (fn: unknown) => (fn as Calls).mock.calls.map((c) => String(c[0]));
const tickLines = () => lines(console.log).filter((l) => l.startsWith("[queue] tick "));

describe("a browser launch never blocks the worker (RFL.QUEUE.8a)", () => {
  let store: MemoryStore;
  let deps: OrchestratorDeps;
  let search: Search;
  let poller: QueuePoller | null = null;
  const saved = {
    enabled: process.env.SCREENSHOTS_ENABLED,
    exe: process.env.PUPPETEER_EXECUTABLE_PATH,
  };

  beforeEach(async () => {
    await resetSharedBrowser();
    pptr.launch.mockReset();
    process.env.SCREENSHOTS_ENABLED = "true";
    process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath; // exists everywhere
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
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
      screenshotCapturer: new PuppeteerScreenshotCapturer(),
      screenshotStorage: new FixtureScreenshotStorage(),
    };
    search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83686", radius_miles: 10, exclude_chains: false },
      category: "plumber",
    });
    await store.updateSearch(search.id, { status: "auditing" });
  });
  afterEach(() => {
    poller?.stop();
    poller = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [key, value] of [
      ["SCREENSHOTS_ENABLED", saved.enabled],
      ["PUPPETEER_EXECUTABLE_PATH", saved.exe],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Two live-site businesses with queued audit jobs. */
  async function enqueueAudits(): Promise<void> {
    const sites = [
      ["fx-001", "Snake River Plumbing Co", "https://snakeriverplumbing.com"],
      ["fx-002", "Boise Drain Pros", "https://boisedrainpros.wixsite.com/"],
    ] as const;
    for (const [placeId, name, url] of sites) {
      const business = await store.upsertBusiness({
        workspace_id: DEV_WORKSPACE_ID,
        google_place_id: placeId,
        name,
        phone: "(208) 555-0101",
        website_url: url,
        address: "1120 N Main St, Meridian, ID 83642",
        lat: null,
        lng: null,
        google_rating: 4.7,
        review_count: 127,
        category: "plumber",
        business_status: "OPERATIONAL",
        is_chain: false,
        website_kind: "real",
      });
      await store.ensureSearchResult(DEV_WORKSPACE_ID, search.id, business.id);
      await store.enqueueJob({
        workspace_id: DEV_WORKSPACE_ID,
        job_type: "audit_business",
        payload: { search_id: search.id, business_id: business.id },
      });
    }
  }

  async function auditIssueLabels(): Promise<string[][]> {
    const detail = (await store.getSearchDetail(search.id))!;
    return detail.leads.map((l) => {
      expect(l.audit?.status).toBe("completed");
      expect(l.audit?.screenshot_desktop_url).toBeNull();
      return (l.audit?.issues ?? []).map((i) => i.label);
    });
  }

  it("never-resolving launch: ticks keep printing, the 20s launch budget frees the stage, audits complete well before the ceiling", async () => {
    let launchSignal: AbortSignal | undefined;
    pptr.launch.mockImplementation((opts: { signal?: AbortSignal }) => {
      launchSignal = opts.signal;
      return NEVER;
    });
    await enqueueAudits();
    poller = startQueuePoller(deps, { cap: 5 });
    const t0 = Date.now();
    await until(() => pptr.launch.mock.calls.length === 1);
    expect(poller.inFlight()).toBe(2); // both audits wait on the one pending launch

    // Mid-hang: the loop is alive — the watchdog fired and reports both jobs.
    await advance(WATCHDOG_INTERVAL_MS);
    expect(poller.inFlight()).toBe(2);
    expect(tickLines().at(-1)).toMatch(/^\[queue\] tick jobs_in_flight=2\/5 oldest_s=\d+ lag_ms=0$/);

    // The launch budget (20s) fires; both screenshot stages degrade; audits finish.
    await advance(15_000);
    expect(poller.inFlight()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(AUDIT_CEILING_MS / 4);
    expect(launchSignal?.aborted).toBe(true); // puppeteer kills the spawn on abort
    expect(pptr.launch).toHaveBeenCalledTimes(1);
    for (const labels of await auditIssueLabels()) {
      expect(labels).toContain("Screenshot unavailable (launch timed out after 20s)");
      expect(labels).not.toContain("screenshot timed out");
    }
    const counts = (await store.getSearchDetail(search.id))!.job_counts;
    expect(counts).toMatchObject({ done: 2, running: 0, failed: 0 });
    expect(lines(console.warn).filter((l) => l.startsWith("[browser] launch timed out"))).toHaveLength(1);
    expect(lines(console.log).filter((l) => /stage=screenshot end ms=\d+ ERROR browser unavailable: launch timed out/.test(l))).toHaveLength(2);
    // Every stage that started also ended.
    const stageLines = lines(console.log).filter((l) => / stage=/.test(l));
    expect(stageLines.filter((l) => l.endsWith(" start")).length).toBe(
      stageLines.filter((l) => / end ms=\d+/.test(l)).length,
    );

    await advance(WATCHDOG_INTERVAL_MS);
    expect(tickLines().at(-1)).toBe("[queue] tick jobs_in_flight=0/5 lag_ms=0");
  });

  it("a job wedged on a never-resolving launch with no budget: ticks keep printing and the queue abandons it at the ceiling", async () => {
    pptr.launch.mockImplementation(() => NEVER);
    await store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: { search_id: search.id, business_id: "biz-wedged" },
    });
    // Worst case: awaits the raw launch with no budget and ignores its abort signal.
    poller = startQueuePoller(deps, {
      cap: 5,
      handle: async () => {
        const puppeteer = await import("puppeteer-core");
        await puppeteer.launch({});
      },
    });
    await until(() => pptr.launch.mock.calls.length === 1);
    const ticksBefore = tickLines().length;

    // No real I/O while wedged: step a watchdog interval at a time. 250ms steps
    // meant ~880 real 1ms yields, ~13s on Windows (~15ms timer granularity).
    await advance(ABANDON_AFTER_MS - 10_000, WATCHDOG_INTERVAL_MS);
    expect(poller.inFlight()).toBe(1); // still held — but the loop never stopped
    const during = tickLines().slice(ticksBefore);
    expect(during.length).toBeGreaterThanOrEqual(Math.floor((ABANDON_AFTER_MS - 10_000) / WATCHDOG_INTERVAL_MS) - 1);
    expect(during.every((l) => l.startsWith("[queue] tick jobs_in_flight=1/5 "))).toBe(true);

    await advance(15_000);
    expect(poller.inFlight()).toBe(0);
    expect(lines(console.error).some((l) => l.includes("abandoned after") && l.includes(ABANDON_REASON))).toBe(true);
    const detail = (await store.getSearchDetail(search.id))!;
    expect(detail.job_counts).toMatchObject({ failed: 1, running: 0 });
    expect(detail.search.status).toBe("completed");
    await advance(WATCHDOG_INTERVAL_MS);
    expect(tickLines().at(-1)).toBe("[queue] tick jobs_in_flight=0/5 lag_ms=0");
  });

  it("a launch that throws synchronously: audits complete with the reason, logged once, ticks continue", async () => {
    pptr.launch.mockImplementation(() => {
      throw new Error("spawn UNKNOWN");
    });
    await enqueueAudits();
    poller = startQueuePoller(deps, { cap: 5 });
    await until(() => pptr.launch.mock.calls.length === 1);
    await until(() => poller!.inFlight() === 0);
    for (const labels of await auditIssueLabels()) {
      expect(labels).toContain("Screenshot unavailable (launch failed: spawn UNKNOWN)");
    }
    expect(pptr.launch).toHaveBeenCalledTimes(1);
    expect(lines(console.warn).filter((l) => l.startsWith("[browser] launch failed"))).toHaveLength(1);
    const before = tickLines().length;
    await advance(2 * WATCHDOG_INTERVAL_MS);
    expect(tickLines().length - before).toBe(2);
    expect(tickLines().at(-1)).toBe("[queue] tick jobs_in_flight=0/5 lag_ms=0");
  });
});
