/**
 * Full scoring pipeline on fixture data (Sprint 3 acceptance): an
 * audit_business job runs Filter → Health/Conversion/Presence/Traffic →
 * Scorer entirely offline (MemoryStore + fixture seams), producing real
 * scores, real issues, agent_runs per agent, and usage_events — with the
 * special routing and the 30-day cache intact.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  Audit,
  Business,
  Job,
  Search,
  UsageEvent,
} from "@rapidforge/shared";
import { BLOCKED_ISSUE_LABEL } from "./agents/filter";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import {
  FixtureWebProbe,
  type ProbeResult,
  type WebProbe,
} from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import {
  FixtureScreenshotCapturer,
  FixtureScreenshotStorage,
} from "./lib/screenshots";
import { FixtureSiteFetcher, type FetchedSite, type SiteFetcher } from "./lib/site";
import {
  analystEligible,
  handleJob,
  type OrchestratorDeps,
} from "./orchestrator";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "./store/types";
import { MemoryStore } from "./store/memory";

const FIXTURE_PARAMS = {
  zip: "83642",
  radius_miles: 10,
  min_reviews: 0,
  min_rating: 0,
  exclude_chains: false,
};

interface Harness {
  store: MemoryStore;
  deps: OrchestratorDeps;
  search: Search;
}

async function makeHarness(): Promise<Harness> {
  const store = new MemoryStore();
  const deps: OrchestratorDeps = {
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
    params: FIXTURE_PARAMS,
    category: "plumber",
  });
  return { store, deps, search };
}

async function seedBusiness(
  harness: Harness,
  overrides: Partial<Business> & { google_place_id: string; name: string },
): Promise<Business> {
  const business = await harness.store.upsertBusiness({
    workspace_id: DEV_WORKSPACE_ID,
    phone: "(208) 555-0101",
    website_url: null,
    address: null,
    lat: null,
    lng: null,
    google_rating: 4.5,
    review_count: 50,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    ...overrides,
  } as Parameters<MemoryStore["upsertBusiness"]>[0]);
  await harness.store.ensureSearchResult(
    DEV_WORKSPACE_ID,
    harness.search.id,
    business.id,
  );
  return business;
}

async function runAuditJob(harness: Harness, businessId: string): Promise<Job> {
  await harness.store.enqueueJob({
    workspace_id: DEV_WORKSPACE_ID,
    job_type: "audit_business",
    payload: { search_id: harness.search.id, business_id: businessId },
  });
  const job = await harness.store.claimNextQueuedJob();
  if (!job) throw new Error("no job to claim");
  await handleJob(job, harness.deps);
  return job;
}

async function leadFor(harness: Harness, businessId: string) {
  const detail = await harness.store.getSearchDetail(harness.search.id);
  const lead = detail?.leads.find((l) => l.business.id === businessId);
  if (!lead) throw new Error("lead not found");
  return lead;
}

let harness: Harness;
beforeEach(async () => {
  harness = await makeHarness();
});

describe("audit pipeline on fixture data", () => {
  it("scores a great custom site high health / moderate sellability (snakeriver)", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-001",
      name: "Snake River Plumbing Co",
      website_url: "https://snakeriverplumbing.com",
      address: "1120 N Main St, Meridian, ID 83642",
      google_rating: 4.7,
      review_count: 127,
    });
    await runAuditJob(harness, business.id);
    const lead = await leadFor(harness, business.id);

    expect(lead.audit?.status).toBe("completed");
    expect(lead.audit?.website_health_score).toBeGreaterThanOrEqual(85);
    expect(lead.audit?.star_grade).toBe(5);
    // RFL-05: a healthy site is capped at 55 — not a rebuild prospect (the
    // blend itself is already ~54 under the 0.50 health weight).
    expect(lead.audit?.sellability_score).toBeLessThanOrEqual(55);
    expect(lead.audit?.sellability_score).toBeLessThan(60); // never an Analyst candidate
    expect(
      (lead.audit?.score_breakdown as { capped?: string }).capped,
    ).toBe("healthy_site");
    expect(lead.audit?.platform).toBe("custom");
    expect(lead.audit?.has_crux_data).toBe(true);
    expect(
      (lead.audit?.score_breakdown as { provisional?: boolean }).provisional,
    ).toBeUndefined(); // no more "est"
    expect(lead.audit?.issues ?? []).toEqual([]); // nothing wrong
    // RFL-05: a 5★ site is not a sales target (PRD 4.2) — no Analyst.
    expect(lead.audit?.analyst_output).toBeNull();

    // agent_runs: filter + the seven-agent fan-out (S6 adds design/
    // reputation/seo) + scorer. No Analyst (star 5 > 3, sellability 55 < 60).
    const detail = await harness.store.getSearchDetail(harness.search.id);
    const agents = detail!.agent_states.map((r) => r.agent_name).sort();
    expect(agents).toEqual([
      "conversion",
      "design",
      "filter",
      "health",
      "presence",
      "reputation",
      "scorer",
      "seo",
      "traffic",
    ]);
    expect(detail!.agent_states.every((r) => r.status === "completed")).toBe(
      true,
    );
  });

  it("scores a terrible Wix site low health / high sellability with the right issues", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-002",
      name: "Boise Drain Pros",
      website_url: "https://boisedrainpros.wixsite.com/home",
      address: "7800 W Fairview Ave, Boise, ID 83704",
      google_rating: 4.5,
      review_count: 89,
    });
    await runAuditJob(harness, business.id);
    const lead = await leadFor(harness, business.id);

    const audit = lead.audit!;
    expect(audit.website_health_score).toBeGreaterThanOrEqual(25);
    expect(audit.website_health_score).toBeLessThanOrEqual(45);
    expect(audit.star_grade).toBeLessThanOrEqual(2);
    expect(audit.sellability_score).toBeGreaterThanOrEqual(75);
    expect((audit.score_breakdown as { capped?: string }).capped).toBeUndefined();
    expect(audit.platform).toBe("wix");
    // RFL-05 gate: 2★, ≥ 60, independent, measured → the Analyst auto-ran.
    expect(audit.analyst_output).not.toBeNull();
    const detail = await harness.store.getSearchDetail(harness.search.id);
    expect(detail!.agent_states.map((r) => r.agent_name)).toContain("analyst");
    expect(audit.copyright_year).toBe(2021);

    const labels = (audit.issues ?? []).map((i) => i.label);
    expect(labels).toContain("Mobile page speed is failing");
    expect(labels).toContain("Built on Wix");
    expect(labels).toContain("Copyright year is 2021");
    expect(labels).toContain(
      "Phone or address on the site doesn't match the Google listing",
    );
    expect((audit.score_breakdown as { badge?: string }).badge).toBe(
      "Builder site",
    );

    // Sprint 6: the fixture screenshot pipeline stored both viewport URLs.
    expect(audit.screenshot_desktop_url).toBe(
      "/fixtures/screenshots/boisedrainpros-wixsite-com-desktop.jpg",
    );
    expect(audit.screenshot_mobile_url).toBe(
      "/fixtures/screenshots/boisedrainpros-wixsite-com-mobile.jpg",
    );
  });

  it("the stored Health narration follows the final health band, not PSI alone (RFL.VERIFY.3 V4)", async () => {
    const great = await seedBusiness(harness, {
      google_place_id: "fx-001",
      name: "Snake River Plumbing Co",
      website_url: "https://snakeriverplumbing.com",
      address: "1120 N Main St, Meridian, ID 83642",
    });
    const wix = await seedBusiness(harness, {
      google_place_id: "fx-002",
      name: "Boise Drain Pros",
      website_url: "https://boisedrainpros.wixsite.com/home",
      address: "7800 W Fairview Ave, Boise, ID 83704",
    });
    for (const [business, band] of [
      [great, "healthy"],
      [wix, "poor"],
    ] as const) {
      await runAuditJob(harness, business.id);
      const audit = (await leadFor(harness, business.id)).audit!;
      const run = harness.store
        .listAgentRuns()
        .find((r) => r.agent_name === "health" && r.target_id === business.id)!;
      const oneLiner = (run.output as { summary: { summary_one_liner: string } }).summary.summary_one_liner;
      expect(oneLiner.startsWith(
        `Site is ${band}: health ${audit.website_health_score}/100 (${audit.star_grade}★), platform ${audit.platform};`,
      )).toBe(true);
      expect(run.status).toBe("completed");
    }
  });

  it("audits.completed_at is stamped when the pipeline finishes, at or after the last agent_runs.ended_at (RFL.VERIFY.3 V5)", async () => {
    const great = await seedBusiness(harness, {
      google_place_id: "fx-001",
      name: "Snake River Plumbing Co",
      website_url: "https://snakeriverplumbing.com",
      address: "1120 N Main St, Meridian, ID 83642",
    });
    const wix = await seedBusiness(harness, {
      google_place_id: "fx-002",
      name: "Boise Drain Pros",
      website_url: "https://boisedrainpros.wixsite.com/home",
      address: "7800 W Fairview Ave, Boise, ID 83704",
    });
    // Snake River: Scorer last (no Analyst). Drain Pros: the Analyst runs last.
    for (const [business, lastAgent] of [
      [great, "scorer"],
      [wix, "analyst"],
    ] as const) {
      await runAuditJob(harness, business.id);
      const audit = (await leadFor(harness, business.id)).audit!;
      const runs = harness.store.listAgentRuns().filter((r) => r.target_id === business.id);
      expect(runs.map((r) => r.agent_name)).toContain(lastAgent);
      const lastEnded = runs
        .map((r) => r.ended_at)
        .filter((t): t is string => t !== null)
        .sort()
        .at(-1)!;
      expect(audit.completed_at).not.toBeNull();
      expect(Date.parse(audit.completed_at!)).toBeGreaterThanOrEqual(Date.parse(lastEnded));
      expect(Date.parse(audit.completed_at!)).toBeGreaterThanOrEqual(Date.parse(audit.created_at!));
    }
  });

  it("keeps special routing intact: no-website stays a 95 hot lead, dead site stays health 10", async () => {
    const noSite = await seedBusiness(harness, {
      google_place_id: "fx-003",
      name: "Nampa Rooter & Drain",
      website_url: null,
      website_kind: "none",
      review_count: 214,
      google_rating: 4.8,
    });
    const dead = await seedBusiness(harness, {
      google_place_id: "fx-005",
      name: "Old Faithful Plumbing",
      website_url: "http://www.oldfaithfulplumbing.com",
      review_count: 45,
      google_rating: 4.2,
    });
    await runAuditJob(harness, noSite.id);
    await runAuditJob(harness, dead.id);

    const hotLead = await leadFor(harness, noSite.id);
    expect(hotLead.audit?.sellability_score).toBe(95);
    expect(hotLead.audit?.website_health_score).toBeNull();

    const deadLead = await leadFor(harness, dead.id);
    expect(deadLead.audit?.website_health_score).toBe(10);
    expect(deadLead.audit?.star_grade).toBe(1);

    // Neither route runs the audit agents.
    const detail = await harness.store.getSearchDetail(harness.search.id);
    expect(detail!.agent_states.map((r) => r.agent_name)).toEqual([
      "filter",
      "filter",
    ]);
  });

  it("logs pagespeed_call x1 (mobile; desktop opt-in) and audit_run x1 usage events per audited business", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-025",
      name: "Precision Plumbing Idaho",
      website_url: "https://precisionplumbingidaho.com",
      review_count: 512,
      google_rating: 4.9,
    });
    await runAuditJob(harness, business.id);

    const events = harness.store.listUsageEvents();
    const byType = (type: UsageEvent["event_type"]) =>
      events.filter((e) => e.event_type === type);
    expect(byType("pagespeed_call")).toHaveLength(1);
    expect(byType("audit_run")).toHaveLength(1);
  });

  it("reuses a fresh completed audit via the 30-day cache (no second pipeline run)", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-013",
      name: "Kuna Electric",
      website_url: "https://kunaelectric.squarespace.com",
      address: "751 W Main St, Kuna, ID 83634",
      review_count: 19,
      google_rating: 4.9,
    });
    await runAuditJob(harness, business.id);
    const firstLead = await leadFor(harness, business.id);
    const firstAuditId = firstLead.result.latest_audit_id;

    // Second search, same business — Filter must cache-hit.
    const secondSearch = await harness.store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: FIXTURE_PARAMS,
      category: "plumber",
    });
    await harness.store.ensureSearchResult(
      DEV_WORKSPACE_ID,
      secondSearch.id,
      business.id,
    );
    await harness.store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: { search_id: secondSearch.id, business_id: business.id },
    });
    const job = await harness.store.claimNextQueuedJob();
    await handleJob(job!, harness.deps);

    const secondDetail = await harness.store.getSearchDetail(secondSearch.id);
    const secondLead = secondDetail!.leads.find(
      (l) => l.business.id === business.id,
    )!;
    expect(secondLead.result.latest_audit_id).toBe(firstAuditId); // reused
    expect(secondDetail!.agent_states.map((r) => r.agent_name)).toEqual([
      "filter",
    ]); // no audit agents ran
    const filterRun = secondDetail!.agent_states[0]!;
    expect(
      (filterRun.output as { outcome?: string } | null)?.outcome,
    ).toBe("cache_hit");
    // Only the first run's PSI calls exist.
    expect(
      harness.store
        .listUsageEvents()
        .filter((e) => e.event_type === "pagespeed_call"),
    ).toHaveLength(1);
  });

  it("force=true bypasses the 30-day cache and runs a fresh pipeline (Sprint 5 re-audit)", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-013",
      name: "Kuna Electric",
      website_url: "https://kunaelectric.squarespace.com",
      address: "751 W Main St, Kuna, ID 83634",
      review_count: 19,
      google_rating: 4.9,
    });
    await runAuditJob(harness, business.id);
    const firstLead = await leadFor(harness, business.id);
    const firstAuditId = firstLead.result.latest_audit_id;
    expect(firstAuditId).toBeTruthy();

    // Re-audit with force — same search context, cache must NOT short-circuit.
    await harness.store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: {
        search_id: harness.search.id,
        business_id: business.id,
        force: true,
      },
    });
    const job = await harness.store.claimNextQueuedJob();
    await handleJob(job!, harness.deps);

    const lead = await leadFor(harness, business.id);
    expect(lead.result.latest_audit_id).not.toBe(firstAuditId); // fresh audit
    expect(lead.audit?.status).toBe("completed");
    // RFL.WEB.10: the pointer was repointed at completion, to the audit shown.
    expect(lead.result.latest_audit_id).toBe(lead.audit?.id);
    // Two full pipeline runs → 2 PSI strategy pairs.
    expect(
      harness.store
        .listUsageEvents()
        .filter((e) => e.event_type === "pagespeed_call"),
    ).toHaveLength(2);
  });

  it("a forced re-audit that fails keeps the pointer and the lead on the completed audit (RFL.WEB.10)", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-013",
      name: "Kuna Electric",
      website_url: "https://kunaelectric.squarespace.com",
      address: "751 W Main St, Kuna, ID 83634",
      review_count: 19,
      google_rating: 4.9,
    });
    await runAuditJob(harness, business.id);
    const firstLead = await leadFor(harness, business.id);
    const firstAuditId = firstLead.result.latest_audit_id;
    expect(firstLead.audit?.status).toBe("completed");

    // Second run: Filter inserts its pending row, then the homepage fetch
    // blows up and the job fails (the old write path left the pointer on
    // that pending row — the Accurbore case).
    const failingSite: SiteFetcher = {
      mode: harness.deps.site.mode,
      fetchHomepage: async () => {
        throw new Error("socket hang up");
      },
      checkPath: (url, path) => harness.deps.site.checkPath(url, path),
    };
    const failingDeps: OrchestratorDeps = { ...harness.deps, site: failingSite };
    await harness.store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: { search_id: harness.search.id, business_id: business.id, force: true },
    });
    const job = await harness.store.claimNextQueuedJob();
    await expect(handleJob(job!, failingDeps)).rejects.toThrow("socket hang up");

    const lead = await leadFor(harness, business.id);
    expect(lead.result.latest_audit_id).toBe(firstAuditId);
    expect(lead.audit?.id).toBe(firstAuditId);
    expect(lead.audit?.status).toBe("completed");
    // The failed attempt's pending row exists in history but is not shown.
    const history = await harness.store.listAuditsForBusiness(business.id);
    expect(history).toHaveLength(2);
    expect(history.map((a) => a.status).sort()).toEqual(["completed", "pending"]);
  });

  it("sorts the full mix by sellability: money + pain on top, healthy sites at the bottom", async () => {
    const great = await seedBusiness(harness, {
      google_place_id: "fx-001",
      name: "Snake River Plumbing Co",
      website_url: "https://snakeriverplumbing.com",
      address: "1120 N Main St, Meridian, ID 83642",
      google_rating: 4.7,
      review_count: 127,
    });
    // Successful business (89 reviews, 4.5★) on a terrible Wix site —
    // the exact "money + pain" profile Sellability exists to surface.
    const moneyAndPain = await seedBusiness(harness, {
      google_place_id: "fx-002",
      name: "Boise Drain Pros",
      website_url: "https://boisedrainpros.wixsite.com/home",
      address: "7800 W Fairview Ave, Boise, ID 83704",
      google_rating: 4.5,
      review_count: 89,
    });
    const hot = await seedBusiness(harness, {
      google_place_id: "fx-024",
      name: "Ten Mile Plumbing LLC",
      website_url: null,
      website_kind: "none",
      google_rating: 4.3,
      review_count: 31,
    });
    for (const b of [great, moneyAndPain, hot]) {
      await runAuditJob(harness, b.id);
    }

    const detail = await harness.store.getSearchDetail(harness.search.id);
    const names = detail!.leads.map((l) => l.business.name);
    expect(names).toEqual([
      "Ten Mile Plumbing LLC", // 95 hot lead
      "Boise Drain Pros", // busy business, terrible site
      "Snake River Plumbing Co", // healthy site → weakest lead
    ]);
    const scores = detail!.leads.map((l) => l.audit?.sellability_score ?? -1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

// ---------------------------------------------------------------------------
// Blocked ≠ dead ≠ alive (audit finding 4)
// ---------------------------------------------------------------------------

/** Probe stub: answers from a script, records every probed URL. */
class ScriptedProbe implements WebProbe {
  readonly mode = "real" as const;
  readonly calls: string[] = [];
  constructor(public next: ProbeResult) {}
  async probe(url: string): Promise<ProbeResult> {
    this.calls.push(url);
    return this.next;
  }
}

const BLOCKED_PROBE: ProbeResult = {
  alive: "unknown",
  httpStatus: 403,
  responseMs: 180,
  sslValid: true,
  note: "Cloudflare bot protection (HTTP 403)",
  blockedBy: "cloudflare-just-a-moment",
};

const ALIVE_PROBE: ProbeResult = {
  alive: "yes",
  httpStatus: 200,
  responseMs: 320,
  sslValid: true,
  note: null,
  blockedBy: null,
};

/** Fixture fetcher whose homepage answer is a Cloudflare challenge page. */
class ChallengeSiteFetcher extends FixtureSiteFetcher {
  override async fetchHomepage(url: string): Promise<FetchedSite | null> {
    return {
      html: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>",
      httpStatus: 403,
      responseMs: 150,
      finalUrl: url,
      sslValid: true,
      headers: { "cf-mitigated": "challenge", server: "cloudflare" },
    };
  }
}

async function seedDrainPros(h: Harness): Promise<Business> {
  // The Wix fixture that otherwise yields "no phone match" / builder / stale
  // findings — none of which may appear when the site was never seen.
  return seedBusiness(h, {
    google_place_id: "fx-002",
    name: "Boise Drain Pros",
    website_url: "https://boisedrainpros.wixsite.com/home",
    address: "7800 W Fairview Ave, Boise, ID 83704",
    google_rating: 4.5,
    review_count: 89,
  });
}

function expectSingleBlockedAudit(audit: Audit | null | undefined): void {
  expect(audit?.status).toBe("completed");
  expect(audit?.provisional).toBe(true);
  expect(audit?.issues).toEqual([
    expect.objectContaining({ severity: "low", label: BLOCKED_ISSUE_LABEL }),
  ]);
  expect(audit?.website_health_score).toBe(50);
  expect(audit?.star_grade).toBeNull();
  const breakdown = audit?.score_breakdown as {
    health?: { blocked?: boolean };
    badge?: string;
  };
  expect(breakdown.health?.blocked).toBe(true);
  expect(breakdown.badge).toBeUndefined(); // never "Site broken — urgent"
  expect(audit?.analyst_output).toBeNull();
}

describe("bot-blocked businesses (finding 4)", () => {
  it("probe 'unknown' → exactly one low issue, provisional, no page analysis", async () => {
    const probe = new ScriptedProbe(BLOCKED_PROBE);
    harness.deps.probe = probe;
    const business = await seedDrainPros(harness);

    await runAuditJob(harness, business.id);

    const lead = await leadFor(harness, business.id);
    expectSingleBlockedAudit(lead.audit);
    expect(lead.audit?.http_status).toBe(403);
    // Only Filter ran: no Health/Conversion/Presence/Design/…, no PSI spend.
    const detail = await harness.store.getSearchDetail(harness.search.id);
    expect(detail!.agent_states.map((r) => r.agent_name)).toEqual(["filter"]);
    expect(
      harness.store
        .listUsageEvents()
        .filter((e) => e.event_type === "pagespeed_call"),
    ).toHaveLength(0);
  });

  it("probe passes but the homepage fetch is a challenge page → same single issue, agents skipped", async () => {
    harness.deps.site = new ChallengeSiteFetcher();
    const business = await seedDrainPros(harness);

    await runAuditJob(harness, business.id);

    const lead = await leadFor(harness, business.id);
    expectSingleBlockedAudit(lead.audit);
    expect(lead.audit?.screenshot_desktop_url).toBeNull(); // no block-page shots
    const detail = await harness.store.getSearchDetail(harness.search.id);
    expect(detail!.agent_states.map((r) => r.agent_name)).toEqual(["filter"]);
  });

  it("a blocked audit is never a cache hit; forced re-audit re-probes and runs the full pipeline", async () => {
    const probe = new ScriptedProbe(BLOCKED_PROBE);
    harness.deps.probe = probe;
    const business = await seedDrainPros(harness);

    await runAuditJob(harness, business.id);
    const blockedAuditId = (await leadFor(harness, business.id)).result
      .latest_audit_id;
    expect(probe.calls).toHaveLength(1);

    // Plain re-run inside the 30-day window: provisional result is not reused.
    await runAuditJob(harness, business.id);
    expect(probe.calls).toHaveLength(2);

    // Site is reachable now; forced manual re-audit (POST /reaudit force=true).
    probe.next = ALIVE_PROBE;
    await harness.store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: {
        search_id: harness.search.id,
        business_id: business.id,
        force: true,
      },
    });
    const job = await harness.store.claimNextQueuedJob();
    await handleJob(job!, harness.deps);

    expect(probe.calls).toHaveLength(3);
    const lead = await leadFor(harness, business.id);
    expect(lead.result.latest_audit_id).not.toBe(blockedAuditId);
    expect(lead.audit?.provisional).toBe(false);
    expect(lead.audit?.platform).toBe("wix"); // full pipeline measured it
    expect((lead.audit?.issues ?? []).map((i) => i.label)).toContain(
      "Built on Wix",
    );
  });
});

// ---------------------------------------------------------------------------
// Analyst gate (RFL-05, audit finding 2)
// ---------------------------------------------------------------------------

describe("analystEligible", () => {
  const ok = { starGrade: 3, sellabilityScore: 60, isChain: false, provisional: false };

  it("passes only when all four conditions hold", () => {
    expect(analystEligible(ok)).toBe(true);
    expect(analystEligible({ ...ok, starGrade: 1, sellabilityScore: 95 })).toBe(true);
  });

  it("star grade above 3 fails (4–5★ are not sales targets, PRD 4.2)", () => {
    expect(analystEligible({ ...ok, starGrade: 4 })).toBe(false);
    expect(analystEligible({ ...ok, starGrade: 5, sellabilityScore: 90 })).toBe(false);
    expect(analystEligible({ ...ok, starGrade: null })).toBe(false);
  });

  it("sellability below 60 fails", () => {
    expect(analystEligible({ ...ok, sellabilityScore: 59 })).toBe(false);
    expect(analystEligible({ ...ok, sellabilityScore: null })).toBe(false);
  });

  it("chains fail regardless of score", () => {
    expect(analystEligible({ ...ok, isChain: true, sellabilityScore: 95, starGrade: 1 })).toBe(false);
  });

  it("provisional (bot-blocked) audits fail regardless of score", () => {
    expect(analystEligible({ ...ok, provisional: true, sellabilityScore: 95, starGrade: 1 })).toBe(false);
  });

  it("a chain never gets the Analyst in the pipeline even with a terrible site", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-002",
      name: "Boise Drain Pros",
      website_url: "https://boisedrainpros.wixsite.com/home",
      address: "7800 W Fairview Ave, Boise, ID 83704",
      google_rating: 4.5,
      review_count: 89,
      is_chain: true,
    });
    await runAuditJob(harness, business.id);
    const lead = await leadFor(harness, business.id);
    expect(lead.audit?.sellability_score).toBeLessThanOrEqual(40);
    expect(lead.audit?.analyst_output).toBeNull();
    const detail = await harness.store.getSearchDetail(harness.search.id);
    expect(detail!.agent_states.map((r) => r.agent_name)).not.toContain("analyst");
  });
});

// ---------------------------------------------------------------------------
// RFL-06: enrichment rides the audit row
// ---------------------------------------------------------------------------

describe("Place Details enrichment through the pipeline (RFL-06)", () => {
  it("Filter persists places_details; Presence/Reputation/Scorer consume it", async () => {
    const business = await seedBusiness(harness, {
      google_place_id: "fx-001",
      name: "Snake River Plumbing Co",
      website_url: "https://snakeriverplumbing.com",
      address: "1120 N Main St, Meridian, ID 83642",
      google_rating: 4.7,
      review_count: 127,
    });
    await runAuditJob(harness, business.id);

    const stored = await harness.store.getBusiness(business.id);
    expect(stored?.places_details).not.toBeNull();

    const lead = await leadFor(harness, business.id);
    const v15 = (lead.audit?.score_breakdown as {
      v15_agents?: {
        conversion?: Record<string, unknown>;
        presence?: Record<string, unknown>;
        reputation?: { reviews_considered?: number };
      };
    }).v15_agents;
    expect(v15?.conversion).toMatchObject({
      has_tel_link: expect.any(Boolean),
      cta_candidates: expect.any(Array),
    });
    expect(v15?.conversion).toHaveProperty("booking_url");
    expect(v15?.conversion).toHaveProperty("visible_phone");
    expect(v15?.presence).toMatchObject({
      social_links: expect.any(Array),
      hours_completeness: "complete", // fx-001's seven weekdayDescriptions
      gbp_photo_count: 2,
    });
    expect(v15?.reputation?.reviews_considered).toBe(3);
    // Only Filter fetched details: exactly one 'details' usage event.
    expect(
      harness.store
        .listUsageEvents()
        .filter((e) => e.metadata?.endpoint === "details"),
    ).toHaveLength(1);
  });
});
