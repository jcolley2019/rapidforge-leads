/**
 * Full scoring pipeline on fixture data (Sprint 3 acceptance): an
 * audit_business job runs Filter → Health/Conversion/Presence/Traffic →
 * Scorer entirely offline (MemoryStore + fixture seams), producing real
 * scores, real issues, agent_runs per agent, and usage_events — with the
 * special routing and the 30-day cache intact.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Business, Job, Search, UsageEvent } from "@rapidforge/shared";
import { FixturePlacesClient } from "./lib/places/fixture-client";
import { FixtureWebProbe } from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import {
  FixtureScreenshotCapturer,
  FixtureScreenshotStorage,
} from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import { handleJob, type OrchestratorDeps } from "./orchestrator";
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
    expect(lead.audit?.sellability_score).toBeLessThanOrEqual(70);
    expect(lead.audit?.platform).toBe("custom");
    expect(lead.audit?.has_crux_data).toBe(true);
    expect(
      (lead.audit?.score_breakdown as { provisional?: boolean }).provisional,
    ).toBeUndefined(); // no more "est"
    expect(lead.audit?.issues ?? []).toEqual([]); // nothing wrong

    // agent_runs: filter + health + conversion + presence + traffic + scorer
    const detail = await harness.store.getSearchDetail(harness.search.id);
    const agents = detail!.agent_states.map((r) => r.agent_name).sort();
    expect(agents).toEqual(
      ["conversion", "filter", "health", "presence", "scorer", "traffic"],
    );
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
    expect(audit.platform).toBe("wix");
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

  it("logs pagespeed_call x2 and audit_run x1 usage events per audited business", async () => {
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
    expect(byType("pagespeed_call")).toHaveLength(2);
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
    ).toHaveLength(2);
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
    // Two full pipeline runs → 2 PSI strategy pairs.
    expect(
      harness.store
        .listUsageEvents()
        .filter((e) => e.event_type === "pagespeed_call"),
    ).toHaveLength(4);
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
