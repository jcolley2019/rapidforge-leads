/**
 * Stage budgets (RFL.QUEUE.8) under fake time: a PSI that never answers, a
 * screenshot launch that fails, a probe that never answers — the audit
 * either completes with neutral values + a timed-out issue, or fails fast
 * (probe), and a job never stays running. Also: agent.progress ordering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Business, Job, Search } from "@rapidforge/shared";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import { FixtureWebProbe, type ProbeResult, type WebProbe } from "./lib/probe";
import { FixturePsiClient, type PsiClient, type PsiMetrics, type PsiStrategy } from "./lib/psi";
import {
  DisabledScreenshotCapturer,
  FixtureScreenshotCapturer,
  FixtureScreenshotStorage,
  type ScreenshotCapturer,
  type ScreenshotSet,
} from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import { buildAuditFacts } from "./agents/money-facts";
import { buildAnalystPrompt } from "./agents/prompts/analyst";
import { resolveConfigVars } from "./agents/prompts/config-vars";
import {
  AUDIT_CEILING_MS,
  STAGE_BUDGET_MS,
  handleJob,
  type OrchestratorDeps,
} from "./orchestrator";
import { MemoryStore } from "./store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "./store/types";

const NEVER = new Promise<never>(() => undefined);

/** Captured before any test fakes timers: a REAL timer to yield to I/O. */
const realSetTimeout = globalThis.setTimeout;
/** Fake time advanced per harness step. */
const FAKE_STEP_MS = 250;

class HangingPsi implements PsiClient {
  readonly mode = "fixture" as const;
  run(_url: string, _strategy: PsiStrategy): Promise<PsiMetrics | null> {
    return NEVER;
  }
}
class ThrowingCapturer implements ScreenshotCapturer {
  readonly mode = "real" as const;
  constructor(private readonly message = "Failed to launch the browser process") {}
  async capture(): Promise<ScreenshotSet | null> {
    throw new Error(this.message);
  }
}
/** A capture that simply produced nothing — the no-screenshot baseline. */
class NullCapturer implements ScreenshotCapturer {
  readonly mode = "real" as const;
  async capture(): Promise<ScreenshotSet | null> {
    return null;
  }
}
class HangingProbe implements WebProbe {
  readonly mode = "real" as const;
  probe(): Promise<ProbeResult> {
    return NEVER;
  }
}

interface Harness {
  store: MemoryStore;
  deps: OrchestratorDeps;
  search: Search;
  business: Business;
  job: Job;
}

async function harness(overrides: Partial<OrchestratorDeps>): Promise<Harness> {
  const store = new MemoryStore();
  const deps: OrchestratorDeps = {
    store,
    places: new FixturePlacesClient(),
    probe: new FixtureWebProbe(),
    psi: new FixturePsiClient(),
    site: new FixtureSiteFetcher(),
    screenshotCapturer: new FixtureScreenshotCapturer(),
    screenshotStorage: new FixtureScreenshotStorage(),
    ...overrides,
  };
  const search = await store.createSearch({
    workspace_id: DEV_WORKSPACE_ID,
    created_by: DEV_USER_ID,
    mode: "zip_radius",
    params: { zip: "83642", radius_miles: 10, exclude_chains: false },
    category: "plumber",
  });
  const business = await store.upsertBusiness({
    workspace_id: DEV_WORKSPACE_ID,
    google_place_id: "fx-001",
    name: "Snake River Plumbing Co",
    phone: "(208) 555-0101",
    website_url: "https://snakeriverplumbing.com",
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
  const job = (await store.claimNextQueuedJob())!;
  return { store, deps, search, business, job };
}

/** Run handleJob while advancing fake time until it settles (or `maxMs`). */
async function runWithFakeTime(p: Promise<void>, maxMs: number): Promise<{ settled: boolean; error: unknown }> {
  let settled = false;
  let error: unknown = null;
  p.then(
    () => {
      settled = true;
    },
    (e: unknown) => {
      settled = true;
      error = e;
    },
  );
  let elapsed = 0;
  while (!settled && elapsed < maxMs) {
    // Give real I/O (fixture JPEG reads on the threadpool) real time to land
    // between small fake-time steps. A lone setImmediate per 1s step let fake
    // time outrun a fixture read on a loaded parallel run, tripping the 30s
    // screenshot budget or the step limit (intermittent failures).
    await new Promise((r) => realSetTimeout(r, 1));
    await vi.advanceTimersByTimeAsync(FAKE_STEP_MS);
    elapsed += FAKE_STEP_MS;
  }
  return { settled, error };
}

describe("stage budgets (RFL.QUEUE.8)", () => {
  beforeEach(() => {
    // Fake only the timer APIs budgets use; keep nextTick/setImmediate/fs real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a PSI that never resolves: audit completes under the ceiling with psi_unmeasured + 'psi-mobile timed out'", async () => {
    const h = await harness({ psi: new HangingPsi() });
    const { settled, error } = await runWithFakeTime(handleJob(h.job, h.deps), AUDIT_CEILING_MS);
    expect(settled).toBe(true);
    expect(error).toBeNull();

    const detail = await h.store.getSearchDetail(h.search.id);
    const audit = detail!.leads[0]!.audit!;
    expect(audit.status).toBe("completed");
    const breakdown = audit.score_breakdown as {
      health?: { psi_unmeasured?: boolean; performance?: number };
      stage_timeouts?: string[];
    };
    expect(breakdown.health?.psi_unmeasured).toBe(true);
    expect(breakdown.health?.performance).toBe(50); // neutral, not punitive
    expect(breakdown.stage_timeouts).toEqual(["psi-mobile"]);
    const labels = (audit.issues ?? []).map((i) => i.label);
    expect(labels).toContain("psi-mobile timed out");
    expect(labels).toContain("Performance could not be measured");
    expect((audit.issues ?? []).find((i) => i.label === "psi-mobile timed out")?.severity).toBe("low");
    // The PSI usage row is still logged (ok:false).
    const psiEvents = h.store.listUsageEvents().filter((e) => e.event_type === "pagespeed_call");
    expect(psiEvents).toHaveLength(1);
    expect(psiEvents[0]?.metadata?.ok).toBe(false);
  });

  it("a screenshot failure (RFL.VERIFY.3 V2): URLs null, error logged, issues unchanged, no ERR_ text in the Analyst prompt", async () => {
    // Baseline: the same audit whose capture simply produced nothing.
    const base = await harness({ screenshotCapturer: new NullCapturer() });
    expect((await runWithFakeTime(handleJob(base.job, base.deps), 10_000)).settled).toBe(true);
    const baseAudit = (await base.store.getSearchDetail(base.search.id))!.leads[0]!.audit!;

    const reason = "net::ERR_BLOCKED_BY_CLIENT at http://www.accurbore.com/";
    const h = await harness({ screenshotCapturer: new ThrowingCapturer(reason) });
    const { settled, error } = await runWithFakeTime(handleJob(h.job, h.deps), 10_000);
    expect(settled).toBe(true);
    expect(error).toBeNull();
    const audit = (await h.store.getSearchDetail(h.search.id))!.leads[0]!.audit!;
    expect(audit.status).toBe("completed");
    expect(audit.screenshot_desktop_url).toBeNull();
    expect(audit.screenshot_mobile_url).toBeNull();
    // Issues are exactly what the no-screenshot audit has — nothing added.
    expect(audit.issues).toEqual(baseAudit.issues);
    expect(JSON.stringify(audit.issues)).not.toMatch(/ERR_|[Ss]creenshot/);
    // The reason is kept internally and logged on the stage's end line.
    expect((audit.score_breakdown as { screenshot_unavailable?: string }).screenshot_unavailable).toBe(reason);
    const logSpy = console.log as unknown as { mock: { calls: unknown[][] } };
    const prefix = `[job:${h.job.id} biz:${h.business.id}]`;
    expect(
      logSpy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith(`${prefix} stage=screenshot end ms=`) && l.endsWith(`ERROR ${reason}`)),
    ).toBe(true);
    // Design saw no screenshots (template), and the Analyst's input carries no ERR_ text.
    const design = (audit.score_breakdown as { v15_agents: { design: { used_vision: boolean } } }).v15_agents.design;
    expect(design.used_vision).toBe(false);
    const prompt = buildAnalystPrompt(buildAuditFacts(h.business, audit), resolveConfigVars(null));
    expect(prompt).not.toContain("ERR_");
    expect(prompt).not.toMatch(/[Ss]creenshot unavailable/);
  });

  it("screenshots disabled (the live default): stage skipped and logged, audit completes without screenshots or a screenshot issue", async () => {
    const logSpy = console.log as unknown as { mock: { calls: unknown[][] } };
    const capture = vi.spyOn(DisabledScreenshotCapturer.prototype, "capture");
    const h = await harness({ screenshotCapturer: new DisabledScreenshotCapturer() });
    const { settled, error } = await runWithFakeTime(handleJob(h.job, h.deps), 10_000);
    expect(settled).toBe(true);
    expect(error).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const prefix = `[job:${h.job.id} biz:${h.business.id}]`;
    expect(lines).toContain(`${prefix} stage=screenshot skipped (disabled)`);
    expect(lines).not.toContain(`${prefix} stage=screenshot start`);
    // fetch, psi-mobile and every agent still log start + end.
    for (const stage of ["fetch", "psi-mobile", "health", "conversion", "presence", "traffic", "design", "reputation", "seo", "scorer"]) {
      expect(lines).toContain(`${prefix} stage=${stage} start`);
      expect(lines.some((l) => l.startsWith(`${prefix} stage=${stage} end ms=`))).toBe(true);
    }
    const audit = (await h.store.getSearchDetail(h.search.id))!.leads[0]!.audit!;
    expect(audit.status).toBe("completed");
    expect(audit.website_health_score).not.toBeNull();
    expect(audit.screenshot_desktop_url).toBeNull();
    expect((audit.issues ?? []).map((i) => i.label)).not.toContainEqual(expect.stringMatching(/[Ss]creenshot/));
  });

  it("a probe that never resolves: the audit fails at the probe budget, not the ceiling", async () => {
    const h = await harness({ probe: new HangingProbe() });
    const t0 = Date.now();
    const { settled, error } = await runWithFakeTime(handleJob(h.job, h.deps), AUDIT_CEILING_MS);
    expect(settled).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/probe timed out after 15000ms/);
    expect(Date.now() - t0).toBeLessThan(STAGE_BUDGET_MS.probe + 5_000);
    // No audit row was finalized; the job is the queue's to fail.
    const detail = await h.store.getSearchDetail(h.search.id);
    expect(detail!.leads[0]!.audit).toBeNull();
  });

  it("emits agent.progress between started and completed, in pipeline order, for one business", async () => {
    const logSpy = console.log as unknown as { mock: { calls: unknown[][] } };
    const h = await harness({});
    const { settled } = await runWithFakeTime(handleJob(h.job, h.deps), 10_000);
    expect(settled).toBe(true);
    // Stub events are logged as "(stub) workspace:… → <type>"; stage lines
    // carry the [job:… biz:…] prefix.
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const events = lines.filter((l) => l.includes("(stub)")).map((l) => l.split("→ ")[1]!.trim());
    const progress = events.filter((e) => e === "agent.progress");
    const started = events.filter((e) => e === "agent.started");
    expect(progress.length).toBe(started.length * 2); // one at start, one at end
    // Filter is the first agent: started → progress → … → progress → completed
    const first = events.indexOf("agent.started");
    expect(events[first + 1]).toBe("agent.progress");
    const firstCompleted = events.indexOf("agent.completed");
    expect(events[firstCompleted - 1]).toBe("agent.progress");
    // Stage logging: one start and one end line per stage.
    const stageLines = lines.filter((l) => l.startsWith(`[job:${h.job.id} biz:${h.business.id}] stage=`));
    const starts = stageLines.filter((l) => l.endsWith(" start")).length;
    const ends = stageLines.filter((l) => / end ms=\d+/.test(l)).length;
    expect(starts).toBeGreaterThanOrEqual(10); // fetch, psi, screenshot, 2 paths, 7 agents, scorer, filter…
    expect(ends).toBe(starts);
  });
});
