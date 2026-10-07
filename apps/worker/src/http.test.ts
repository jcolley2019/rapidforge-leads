/**
 * Route tests for the Sprint 5 API surface, against the real Express app on
 * an ephemeral port with MemoryStore + fixture seams (no external services,
 * no supertest). Memory-store auth maps any Bearer to the dev workspace.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Business, SearchResult, WorkspaceConfig } from "@rapidforge/shared";
import { createApp } from "./http";
import { resetReportRenderer } from "./lib/pdf-report";
import {
  FIXTURE_PHOTO_PNG,
  FixturePlacesClient,
} from "./lib/places/fixture-client";
import { FIXTURE_DETAILS } from "./lib/places/fixtures";
import { FixtureWebProbe } from "./lib/probe";
import { FixturePsiClient } from "./lib/psi";
import {
  FixtureScreenshotCapturer,
  FixtureScreenshotStorage,
} from "./lib/screenshots";
import { FixtureSiteFetcher } from "./lib/site";
import type { OrchestratorDeps } from "./orchestrator";
import type { QueuePoller } from "./queue";
import { MemoryStore } from "./store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID, type LeadView } from "./store/types";

let store: MemoryStore;
let server: Server;
let base: string;

/** Search ids the fake poller was asked to abort (cancel route tests). */
const abortCalls: Array<{ searchId: string; reason: string }> = [];

const idlePoller: QueuePoller = {
  status: "polling",
  stop() {},
  inFlight: () => 0,
  inFlightJobs: () => [],
  tick: async () => undefined,
  abortJobsForSearch: async (searchId, reason) => {
    abortCalls.push({ searchId, reason });
    return [];
  },
};

function makeDeps(s: MemoryStore): OrchestratorDeps {
  return {
    store: s,
    places: new FixturePlacesClient(),
    probe: new FixtureWebProbe(),
    psi: new FixturePsiClient(),
    site: new FixtureSiteFetcher(),
    screenshotCapturer: new FixtureScreenshotCapturer(),
    screenshotStorage: new FixtureScreenshotStorage(),
  };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  token = "dev-offline",
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function seedLead(
  overrides: Partial<Parameters<MemoryStore["upsertBusiness"]>[0]> = {},
): Promise<{
  business: Business;
  result: SearchResult;
}> {
  const search = await store.createSearch({
    workspace_id: DEV_WORKSPACE_ID,
    created_by: DEV_USER_ID,
    mode: "zip_radius",
    params: { zip: "83704", radius_miles: 10 },
    category: "plumber",
  });
  // Unique per call: the store's multi-location rule (RFL-04) would turn a
  // third same-named business into a chain and break the Analyst tests.
  const suffix = Math.random().toString(36).slice(2, 7);
  const business = await store.upsertBusiness({
    workspace_id: DEV_WORKSPACE_ID,
    google_place_id: `fx-${suffix}`,
    name: `Boise Drain Pros ${suffix}`,
    phone: "(208) 555-0102",
    website_url: "https://boisedrainpros.wixsite.com/home",
    address: "7800 W Fairview Ave, Boise, ID 83704",
    lat: 43.62,
    lng: -116.28,
    google_rating: 4.5,
    review_count: 89,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    ...overrides,
  });
  const result = await store.ensureSearchResult(
    DEV_WORKSPACE_ID,
    search.id,
    business.id,
  );
  return { business, result };
}

beforeAll(async () => {
  store = new MemoryStore();
  const app = createApp(makeDeps(store), idlePoller, Date.now());
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

// One store for the whole file — tests seed their own rows and never assume
// an empty store.

describe("auth gate", () => {
  it("401s /api without a Bearer token", async () => {
    const res = await api("GET", "/api/leads", undefined, "");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/searches (map_draw)", () => {
  it("accepts a map_draw request and enqueues scout", async () => {
    const res = await api("POST", "/api/searches", {
      mode: "map_draw",
      category: "electrician",
      params: { lat: 43.6135, lng: -116.2035, radius_miles: 8 },
    });
    expect(res.status).toBe(202);
    const search = await store.getSearch(res.json.search_id);
    expect(search?.mode).toBe("map_draw");
    expect(search?.params).toMatchObject({ lat: 43.6135, radius_miles: 8 });
  });

  it("rejects keyword mode with details", async () => {
    const res = await api("POST", "/api/searches", {
      mode: "keyword",
      category: "plumber",
      params: { query: "plumbers boise" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/leads/:id/status", () => {
  it("persists a status transition and stamps last_contacted_at", async () => {
    const { result } = await seedLead();
    expect(result.status).toBe("new");

    const res = await api("POST", `/api/leads/${result.id}/status`, {
      status: "called",
    });
    expect(res.status).toBe(200);
    expect(res.json.lead.status).toBe("called");
    expect(res.json.lead.last_contacted_at).toBeTruthy();

    const persisted = await store.getSearchResult(result.id);
    expect(persisted?.status).toBe("called");
  });

  it("walks the full pipeline new→called→interested→sold", async () => {
    const { result } = await seedLead();
    for (const status of ["called", "interested", "sold"] as const) {
      const res = await api("POST", `/api/leads/${result.id}/status`, {
        status,
      });
      expect(res.status).toBe(200);
      expect(res.json.lead.status).toBe(status);
    }
    expect((await store.getSearchResult(result.id))?.status).toBe("sold");
  });

  it("persists notes without touching status or last_contacted_at", async () => {
    const { result } = await seedLead();
    const res = await api("POST", `/api/leads/${result.id}/status`, {
      notes: "Owner asked for a callback Tuesday",
    });
    expect(res.status).toBe(200);
    expect(res.json.lead.notes).toContain("Tuesday");
    expect(res.json.lead.status).toBe("new");
    expect(res.json.lead.last_contacted_at).toBeNull();
  });

  it("rejects an unknown status", async () => {
    const { result } = await seedLead();
    const res = await api("POST", `/api/leads/${result.id}/status`, {
      status: "won",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const { result } = await seedLead();
    const res = await api("POST", `/api/leads/${result.id}/status`, {});
    expect(res.status).toBe(400);
  });

  it("404s an unknown lead and a foreign-workspace lead", async () => {
    expect(
      (await api("POST", "/api/leads/nope/status", { status: "called" }))
        .status,
    ).toBe(404);

    const { business } = await seedLead();
    const foreignSearch = await store.createSearch({
      workspace_id: "00000000-0000-4000-8000-00000000ffff",
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83704", radius_miles: 5 },
      category: "plumber",
    });
    const foreign = await store.ensureSearchResult(
      "00000000-0000-4000-8000-00000000ffff",
      foreignSearch.id,
      business.id,
    );
    expect(
      (await api("POST", `/api/leads/${foreign.id}/status`, { status: "called" }))
        .status,
    ).toBe(404);
  });
});

describe("GET /api/searches", () => {
  it("lists recent workspace searches newest first, respecting limit", async () => {
    await seedLead();
    await seedLead();
    await store.createSearch({
      workspace_id: "00000000-0000-4000-8000-00000000ffff",
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "99999", radius_miles: 5 },
      category: "spy",
    });

    const res = await api("GET", "/api/searches?limit=2");
    expect(res.status).toBe(200);
    expect(res.json.searches).toHaveLength(2);
    const [a, b] = res.json.searches;
    expect((a.created_at ?? "") >= (b.created_at ?? "")).toBe(true);
    // Foreign workspace searches never leak.
    expect(
      res.json.searches.every(
        (s: { category: string }) => s.category !== "spy",
      ),
    ).toBe(true);
  });
});

describe("GET /api/leads", () => {
  it("returns workspace leads across searches", async () => {
    const { result } = await seedLead();
    const res = await api("GET", "/api/leads");
    expect(res.status).toBe(200);
    const ids = (res.json.leads as LeadView[]).map((l) => l.result.id);
    expect(ids).toContain(result.id);
  });
});

/** Drain the queue until the given job id comes up (store is shared). */
async function claimJobById(id: string) {
  for (;;) {
    const job = await store.claimNextQueuedJob();
    if (!job || job.id === id) return job;
  }
}

describe("POST /api/businesses/:id/reaudit", () => {
  it("enqueues an audit_business job carrying the force flag", async () => {
    const { business, result } = await seedLead();
    const res = await api("POST", `/api/businesses/${business.id}/reaudit`, {
      force: true,
    });
    expect(res.status).toBe(202);
    expect(res.json.job_id).toBeTruthy();

    const job = await claimJobById(res.json.job_id);
    expect(job?.job_type).toBe("audit_business");
    expect(job?.payload).toMatchObject({
      business_id: business.id,
      search_id: result.search_id,
      force: true,
    });
  });

  it("defaults force to false", async () => {
    const { business } = await seedLead();
    const res = await api("POST", `/api/businesses/${business.id}/reaudit`, {});
    const job = await claimJobById(res.json.job_id);
    expect(job?.payload).toMatchObject({ force: false });
  });

  it("404s a business outside the workspace", async () => {
    const res = await api("POST", "/api/businesses/nope/reaudit", {});
    expect(res.status).toBe(404);
  });
});

describe("GET /api/businesses/:id/audits", () => {
  it("returns audit history newest first", async () => {
    const { business } = await seedLead();
    for (const year of [2024, 2025]) {
      const audit = await store.insertAudit({
        workspace_id: DEV_WORKSPACE_ID,
        business_id: business.id,
        website_url: business.website_url,
        http_status: 200,
        response_ms: 300,
        ssl_valid: true,
        website_health_score: 40 + year - 2024,
        star_grade: 2,
        sellability_score: 80,
        score_breakdown: null,
        issues: null,
        status: "completed",
        error_message: null,
        completed_at: `${year}-06-01T00:00:00.000Z`,
      });
      expect(audit.id).toBeTruthy();
    }
    const res = await api("GET", `/api/businesses/${business.id}/audits`);
    expect(res.status).toBe(200);
    expect(res.json.audits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /api/businesses/:id/costs", () => {
  it("returns per-agent AI spend (highest first) + business/search totals", async () => {
    const { business, result } = await seedLead();
    const seedRun = async (agent: string, cents: number) => {
      const run = await store.insertAgentRun({
        workspace_id: DEV_WORKSPACE_ID,
        agent_name: agent,
        job_id: null,
        target_id: business.id,
        input: { search_id: result.search_id },
      });
      await store.updateAgentRun(run.id, { status: "completed", cost_cents: cents });
    };
    await seedRun("analyst", 7);
    await seedRun("design", 2);

    const res = await api("GET", `/api/businesses/${business.id}/costs`);
    expect(res.status).toBe(200);
    expect(res.json.business_total_cents).toBe(9);
    expect(res.json.search_total_cents).toBe(9);
    expect(res.json.by_agent[0]).toMatchObject({ agent: "analyst", cost_cents: 7 });
  });

  it("404s a foreign business", async () => {
    const res = await api("GET", "/api/businesses/nope/costs");
    expect(res.status).toBe(404);
  });
});

async function seedCompletedAudit(businessId: string) {
  return store.insertAudit({
    workspace_id: DEV_WORKSPACE_ID,
    business_id: businessId,
    website_url: "https://boisedrainpros.wixsite.com/home",
    http_status: 200,
    response_ms: 800,
    ssl_valid: true,
    website_health_score: 36,
    star_grade: 2,
    sellability_score: 82,
    score_breakdown: {
      v15_agents: {
        design: {
          modernity_0_100: 40,
          feels_like_year: 2016,
          critical_issues: ["dated hero"],
        },
        seo: {
          title: { found: true },
          meta_description: { found: false },
          has_sitemap: false,
          summary: { local_fit_score_1_5: 2 },
        },
      },
    },
    issues: [
      { severity: "high", label: "Slow on mobile" },
      { severity: "high", label: "No click-to-call" },
      { severity: "medium", label: "Dated design" },
    ],
    status: "completed",
    error_message: null,
    completed_at: "2026-07-05T00:00:00.000Z",
  });
}

describe("POST /api/businesses/:id/analyst", () => {
  it("409s when the business has no completed audit", async () => {
    const { business } = await seedLead();
    const res = await api("POST", `/api/businesses/${business.id}/analyst`);
    expect(res.status).toBe(409);
  });

  it("runs the Analyst and persists analyst_output", async () => {
    const { business } = await seedLead();
    await seedCompletedAudit(business.id);
    const res = await api("POST", `/api/businesses/${business.id}/analyst`);
    expect(res.status).toBe(200);
    expect(res.json.analyst.verdict).toBeTruthy();
    expect(res.json.analyst.top_3_improvements.length).toBeGreaterThanOrEqual(3);
    const reloaded = await store.getLatestCompletedAuditForBusiness(business.id);
    expect(reloaded?.analyst_output).not.toBeNull();
  });

  it("404s a foreign business", async () => {
    const res = await api("POST", "/api/businesses/nope/analyst");
    expect(res.status).toBe(404);
  });

  it("409s a chain unless ?force=true (RFL-05)", async () => {
    const { business } = await seedLead({ is_chain: true, chain_reason: "known_brand" });
    await seedCompletedAudit(business.id);
    const refused = await api("POST", `/api/businesses/${business.id}/analyst`);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "is_chain" });
    expect(refused.json.error).toMatch(/force=true/);
    expect(
      (await store.getLatestCompletedAuditForBusiness(business.id))?.analyst_output,
    ).toBeNull();

    const forced = await api("POST", `/api/businesses/${business.id}/analyst?force=true`);
    expect(forced.status).toBe(200);
    expect(forced.json.analyst.verdict).toBeTruthy();
  });
});

describe("POST /api/businesses/:id/sales-summary", () => {
  it("409s when the business has no completed audit", async () => {
    const { business } = await seedLead();
    const res = await api("POST", `/api/businesses/${business.id}/sales-summary`);
    expect(res.status).toBe(409);
  });

  it("runs the Sales Summary and persists sales_summary", async () => {
    const { business } = await seedLead();
    await seedCompletedAudit(business.id);
    const res = await api(
      "POST",
      `/api/businesses/${business.id}/sales-summary`,
    );
    expect(res.status).toBe(200);
    expect(res.json.sales_summary.full_talk_track).toBeTruthy();
    expect(
      res.json.sales_summary.anticipated_objections.length,
    ).toBeGreaterThanOrEqual(2);
    const reloaded = await store.getLatestCompletedAuditForBusiness(business.id);
    expect(reloaded?.sales_summary).not.toBeNull();
  });
});

describe("POST /api/businesses/:id/builder-brief", () => {
  it("409s when the business has no completed audit", async () => {
    const { business } = await seedLead();
    const res = await api(
      "POST",
      `/api/businesses/${business.id}/builder-brief`,
    );
    expect(res.status).toBe(409);
  });

  it("returns a complete markdown brief and persists it", async () => {
    const { business } = await seedLead();
    await seedCompletedAudit(business.id);
    const res = await api(
      "POST",
      `/api/businesses/${business.id}/builder-brief`,
    );
    expect(res.status).toBe(200);
    expect(res.json.sections.length).toBe(12);
    expect(res.json.builder_brief_md).toContain("## Deploy instructions");
    const reloaded = await store.getLatestCompletedAuditForBusiness(business.id);
    expect(reloaded?.builder_brief_md).toBeTruthy();
  });
});

describe("stored builder brief / sales summary (RFL.FIX.3h)", () => {
  const runsFor = (businessId: string, agent: string) =>
    store.listAgentRuns().filter((r) => r.target_id === businessId && r.agent_name === agent);

  it("stored builder brief / sales summary returned without a new agent run; ?force=true re-runs", async () => {
    const { business } = await seedLead();
    const audit = await seedCompletedAudit(business.id);
    const storedBrief = [
      "## Project overview\nstored brief",
      "## Business details\nx",
      "## Target audience\nx",
      "## Pages to build\nx",
      "## Design direction\nx",
      "## SEO requirements\nx",
      "## AEO requirements\nx",
      "## Conversion requirements\nx",
      "## Performance requirements\nx",
      "## Content to migrate\nx",
      "## Assets\nx",
      "## Deploy instructions\nx",
    ].join("\n\n");
    const storedScript = {
      opener: "stored opener",
      earned_observation: "mobile scores 32/100",
      pain_hypothesis: "p",
      offer: "o",
      soft_close: "s",
      full_talk_track: "stored talk track",
      anticipated_objections: [
        { objection: "a", response: "b" },
        { objection: "c", response: "d" },
      ],
    };
    await store.updateAudit(audit.id, { builder_brief_md: storedBrief, sales_summary: storedScript });

    // Stored → returned verbatim, stored:true, zero agent_runs rows added.
    const brief = await api("POST", `/api/businesses/${business.id}/builder-brief`);
    expect(brief.status).toBe(200);
    expect(brief.json).toMatchObject({ builder_brief_md: storedBrief, stored: true });
    expect(brief.json.sections).toHaveLength(12);
    expect(brief.json.word_count).toBeGreaterThan(0);
    expect(runsFor(business.id, "builder-brief")).toHaveLength(0);

    const script = await api("POST", `/api/businesses/${business.id}/sales-summary`);
    expect(script.status).toBe(200);
    expect(script.json).toMatchObject({ sales_summary: storedScript, stored: true });
    expect(runsFor(business.id, "sales-summary")).toHaveLength(0);

    // ?force=true → a fresh run, persisted over the stored column, stored:false.
    const forcedBrief = await api("POST", `/api/businesses/${business.id}/builder-brief?force=true`);
    expect(forcedBrief.status).toBe(200);
    expect(forcedBrief.json.stored).toBe(false);
    expect(forcedBrief.json.builder_brief_md).not.toBe(storedBrief);
    expect(runsFor(business.id, "builder-brief")).toHaveLength(1);

    const forcedScript = await api("POST", `/api/businesses/${business.id}/sales-summary?force=true`);
    expect(forcedScript.status).toBe(200);
    expect(forcedScript.json.stored).toBe(false);
    expect(forcedScript.json.sales_summary.full_talk_track).not.toBe("stored talk track");
    expect(runsFor(business.id, "sales-summary")).toHaveLength(1);

    const reloaded = await store.getLatestCompletedAuditForBusiness(business.id);
    expect(reloaded?.builder_brief_md).toBe(forcedBrief.json.builder_brief_md);
    expect(reloaded?.sales_summary).toEqual(forcedScript.json.sales_summary);
  });

  it("first-time generation (nothing stored) still runs the agent and reports stored:false", async () => {
    const { business } = await seedLead();
    await seedCompletedAudit(business.id);
    const res = await api("POST", `/api/businesses/${business.id}/sales-summary`);
    expect(res.status).toBe(200);
    expect(res.json.stored).toBe(false);
    expect(runsFor(business.id, "sales-summary")).toHaveLength(1);
  });
});

describe("GET /api/businesses/:id/report", () => {
  it("409s when the business has no completed audit", async () => {
    const { business } = await seedLead();
    const res = await fetch(`${base}/api/businesses/${business.id}/report`, {
      headers: { authorization: "Bearer dev-offline" },
    });
    expect(res.status).toBe(409);
  });

  it("renders a report (HTML in fixture mode) with the key facts", async () => {
    const { business } = await seedLead();
    await seedCompletedAudit(business.id);
    const res = await fetch(`${base}/api/businesses/${business.id}/report`, {
      headers: { authorization: "Bearer dev-offline" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toContain("audit-report");
    const body = await res.text();
    expect(body).toContain("Boise Drain Pros");
    expect(body).toContain("RAPIDFORGE");
  });

  it("503s 'screenshots disabled' in live mode without SCREENSHOTS_ENABLED (RFL.QUEUE.8a)", async () => {
    const { business } = await seedLead();
    await seedCompletedAudit(business.id);
    const saved = {
      places: process.env.GOOGLE_PLACES_API_KEY,
      force: process.env.RAPIDFORGE_FORCE_FIXTURES,
      screenshots: process.env.SCREENSHOTS_ENABLED,
    };
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    process.env.RAPIDFORGE_FORCE_FIXTURES = "false";
    delete process.env.SCREENSHOTS_ENABLED;
    resetReportRenderer();
    try {
      const res = await fetch(`${base}/api/businesses/${business.id}/report`, {
        headers: { authorization: "Bearer dev-offline" },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("screenshots disabled");
      expect(body.hint).toContain("SCREENSHOTS_ENABLED=true");
    } finally {
      for (const [key, value] of [
        ["GOOGLE_PLACES_API_KEY", saved.places],
        ["RAPIDFORGE_FORCE_FIXTURES", saved.force],
        ["SCREENSHOTS_ENABLED", saved.screenshots],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetReportRenderer();
    }
  });
});

describe("GET /api/usage", () => {
  it("rolls up this month's events by type", async () => {
    await store.logUsageEvent({
      workspace_id: DEV_WORKSPACE_ID,
      event_type: "places_call",
      cost_cents: 3,
      metadata: null,
    });
    await store.logUsageEvent({
      workspace_id: DEV_WORKSPACE_ID,
      event_type: "places_call",
      cost_cents: 3,
      metadata: null,
    });
    const res = await api("GET", "/api/usage");
    expect(res.status).toBe(200);
    expect(res.json.total_cents).toBeGreaterThanOrEqual(6);
    expect(res.json.by_type.places_call.count).toBeGreaterThanOrEqual(2);
    expect(res.json.month_start).toMatch(/^\d{4}-\d{2}-01T00:00:00/);
  });
});

describe("workspace config", () => {
  it("GET returns defaults before any save", async () => {
    const res = await api("GET", "/api/config");
    expect(res.status).toBe(200);
    const config = res.json.config as WorkspaceConfig;
    expect(config.workspace_id).toBe(DEV_WORKSPACE_ID);
    expect(config.user_brand).toBe("RapidForgeAI");
    expect(config.your_offer).toBeNull();
  });

  it("PUT persists a partial patch and GET returns it", async () => {
    const put = await api("PUT", "/api/config", {
      your_offer: "Website rebuilds + local SEO",
      user_location: "Boise, ID",
    });
    expect(put.status).toBe(200);
    expect(put.json.config.your_offer).toContain("SEO");

    const get = await api("GET", "/api/config");
    expect(get.json.config.your_offer).toBe("Website rebuilds + local SEO");
    expect(get.json.config.user_location).toBe("Boise, ID");
    expect(get.json.config.user_brand).toBe("RapidForgeAI"); // default kept
  });

  it("rejects a non-string field", async () => {
    const res = await api("PUT", "/api/config", { your_offer: 42 });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/places/photo/:ref (RFL-06)", () => {
  const ref = encodeURIComponent("places/fx-001/photos/fxphoto-a");

  it("streams the photo bytes with content-type and a 1-day cache header", async () => {
    const res = await fetch(`${base}/api/places/photo/${ref}?maxWidthPx=99999`, {
      headers: { authorization: "Bearer dev-offline" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/png/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(FIXTURE_PHOTO_PNG);
    // Spend is logged like every other Places call.
    const photoEvents = store
      .listUsageEvents()
      .filter((e) => e.metadata?.endpoint === "photo");
    expect(photoEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("400s a malformed reference and 401s without a token", async () => {
    const bad = await api("GET", `/api/places/photo/${encodeURIComponent("../../etc/passwd")}`);
    expect(bad.status).toBe(400);
    const anon = await api("GET", `/api/places/photo/${ref}`, undefined, "");
    expect(anon.status).toBe(401);
  });
});

describe("POST /api/businesses/:id/design-brief (RFL.BRIEF.7)", () => {
  const detailsFor = (name: string) => ({
    ...FIXTURE_DETAILS["fx-001"],
    displayName: { text: name },
    fetchedAt: "2026-07-06T07:00:00.000Z",
  });
  const designRuns = (businessId: string) =>
    store
      .listAgentRuns()
      .filter((r) => r.target_id === businessId && r.agent_name === "design-brief").length;

  it("409s without a completed audit", async () => {
    const { business } = await seedLead();
    const res = await api("POST", `/api/businesses/${business.id}/design-brief`);
    expect(res.status).toBe(409);
  });

  it("generates, persists, then returns the stored brief without a new agent run; ?force=true re-runs", async () => {
    const { business } = await seedLead({ places_details: detailsFor("Boise Drain Pros") });
    await seedCompletedAudit(business.id);

    const first = await api("POST", `/api/businesses/${business.id}/design-brief`);
    expect(first.status).toBe(200);
    expect(first.json.stored).toBe(false);
    expect(first.json.design_brief).toMatchObject({
      vertical: "plumber",
      primary_cta: { kind: "phone" },
      source: { template_fallback: true },
    });
    expect(first.json.design_brief.review_quotes).toHaveLength(3);
    expect(first.json.design_brief.photo_urls[0]).toMatch(/^\/api\/places\/photo\//);
    const persisted = await store.getLatestCompletedAuditForBusiness(business.id);
    expect(persisted?.design_brief).toEqual(first.json.design_brief);
    expect(designRuns(business.id)).toBe(1);

    const second = await api("POST", `/api/businesses/${business.id}/design-brief`);
    expect(second.status).toBe(200);
    expect(second.json.stored).toBe(true);
    expect(second.json.design_brief).toEqual(first.json.design_brief);
    expect(designRuns(business.id)).toBe(1); // no new AI/agent run

    const forced = await api("POST", `/api/businesses/${business.id}/design-brief?force=true`);
    expect(forced.status).toBe(200);
    expect(forced.json.stored).toBe(false);
    expect(designRuns(business.id)).toBe(2);
  });

  it("404s a foreign business", async () => {
    const res = await api("POST", "/api/businesses/nope/design-brief");
    expect(res.status).toBe(404);
  });
});

describe("GET /health queue readings (RFL.QUEUE.8 / finding 14)", () => {
  it("reports jobs_in_flight, jobs_running_over_10m and oldest_queued_age_s", async () => {
    // The store is shared across this file's tests, so compare deltas.
    const base0 = (await store.getQueueHealth()).queued;
    const before = (await fetch(`${base}/health`).then((r) => r.json())) as Record<string, unknown>;
    expect(before).toMatchObject({ ok: true, jobs_in_flight: 0, jobs_running_over_10m: 0 });
    expect(Array.isArray(before.jobs_in_flight_detail)).toBe(true);

    const search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83642", radius_miles: 5 },
      category: "plumber",
    });
    for (const biz of ["biz-q", "biz-r"]) {
      await store.enqueueJob({
        workspace_id: DEV_WORKSPACE_ID,
        job_type: "audit_business",
        payload: { search_id: search.id, business_id: biz },
      });
    }
    const running = (await store.claimNextQueuedJob())!;
    // The DB view 11 minutes from now: that claim counts as running > 10m.
    const later = await store.getQueueHealth(new Date(Date.now() + 11 * 60_000));
    expect(later.running).toBeGreaterThanOrEqual(1);
    expect(later.running_over_10m).toBeGreaterThanOrEqual(1);
    expect(later.queued).toBe(base0 + 1);
    expect(later.oldest_queued_age_s).toBeGreaterThanOrEqual(11 * 60 - 1);

    const res = (await fetch(`${base}/health`).then((r) => r.json())) as Record<string, unknown>;
    expect(res.jobs_queued).toBe(base0 + 1);
    expect(res.jobs_running_db as number).toBeGreaterThanOrEqual(1);
    expect(res.jobs_running_over_10m).toBe(0); // just claimed — not over 10m yet
    expect(typeof res.oldest_queued_age_s).toBe("number");
    await store.finishJob(running.id, { status: "done" });
  });
});

describe("POST /api/searches/:id/cancel (RFL.WEB.10)", () => {
  async function seedRunningSearch() {
    const search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83686", radius_miles: 10 },
      category: "plumber",
    });
    await store.updateSearch(search.id, { status: "auditing" });
    const jobs = [];
    for (let i = 0; i < 3; i += 1) {
      jobs.push(
        await store.enqueueJob({
          workspace_id: DEV_WORKSPACE_ID,
          job_type: "audit_business",
          payload: { search_id: search.id, business_id: `biz-${i}` },
        }),
      );
    }
    return { search, jobs };
  }

  it("fails the queued jobs, asks the poller to abort in-flight ones, settles the search to failed", async () => {
    const { search } = await seedRunningSearch();
    abortCalls.length = 0;

    const res = await api("POST", `/api/searches/${search.id}/cancel`);
    expect(res.status).toBe(200);
    // In-flight aborts are the poller's (queue-cancel.test.ts covers the real
    // one); the route hands it the search id and the user-facing reason.
    expect(res.json).toEqual({ status: "failed", queued_failed: 3, running_aborted: 0 });
    expect(abortCalls).toEqual([{ searchId: search.id, reason: "cancelled by user" }]);

    const detail = await store.getSearchDetail(search.id);
    expect(detail?.search.status).toBe("failed");
    expect(detail?.search.completed_at).toBeTruthy();
    expect(detail?.job_counts).toEqual({ queued: 0, running: 0, done: 0, failed: 3 });
    // Nothing left to cancel on a second call — the rows are already failed.
    expect(await store.failQueuedJobsForSearch(search.id, "x")).toEqual([]);
  });

  it("409s once the search is terminal and 404s an unknown id", async () => {
    const { search } = await seedRunningSearch();
    await store.updateSearch(search.id, { status: "completed" });
    const done = await api("POST", `/api/searches/${search.id}/cancel`);
    expect(done.status).toBe(409);
    expect(done.json.error).toMatch(/already completed/);

    const missing = await api(
      "POST",
      "/api/searches/00000000-0000-4000-8000-00000000dead/cancel",
    );
    expect(missing.status).toBe(404);
  });
});
