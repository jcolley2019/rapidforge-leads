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
import { FixturePlacesClient } from "./lib/places/fixture-client";
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

const idlePoller: QueuePoller = {
  status: "polling",
  stop() {},
  inFlight: () => 0,
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

async function seedLead(): Promise<{
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
  const business = await store.upsertBusiness({
    workspace_id: DEV_WORKSPACE_ID,
    google_place_id: `fx-${Math.random().toString(36).slice(2)}`,
    name: "Boise Drain Pros",
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
