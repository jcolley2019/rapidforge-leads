import {
  NO_WEBSITE_SELLABILITY_SCORE,
  SPECIAL_CASE_BADGES,
  UNVERIFIED_REPUTATION_LABEL,
  ZipRadiusParamsSchema,
  type Business,
  type ZipRadiusParams,
} from "@rapidforge/shared";
import { describe, expect, it } from "vitest";
import { FixtureWebProbe, type ProbeResult } from "../lib/probe";
import { MemoryStore } from "../store/memory";
import {
  DEV_USER_ID,
  DEV_WORKSPACE_ID,
  type UpsertBusinessInput,
} from "../store/types";
import {
  BLOCKED_ISSUE_LABEL,
  evaluateGates,
  planFilterOutcome,
  runFilter,
} from "./filter";

const params: ZipRadiusParams = ZipRadiusParamsSchema.parse({
  zip: "83686",
  radius_miles: 10,
});

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: "00000000-0000-4000-8000-0000000000bb",
    workspace_id: DEV_WORKSPACE_ID,
    google_place_id: "fx-test",
    name: "Test Plumbing",
    phone: "(208) 555-0000",
    website_url: "https://testplumbing.com",
    address: "1 Main St, Nampa, ID",
    lat: 43.58,
    lng: -116.56,
    google_rating: 4.5,
    review_count: 50,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    first_seen_at: null,
    last_refreshed_at: null,
    ...overrides,
  };
}

const aliveProbe: ProbeResult = {
  alive: "yes",
  httpStatus: 200,
  responseMs: 300,
  sslValid: true,
  note: null,
  blockedBy: null,
};

const deadProbe: ProbeResult = {
  alive: "no",
  httpStatus: null,
  responseMs: 10_000,
  sslValid: false,
  note: "Unreachable: connection timed out",
  blockedBy: null,
};

// ---------------------------------------------------------------------------
// Deterministic gates (PRD 6.2)
// ---------------------------------------------------------------------------

describe("evaluateGates", () => {
  it("passes a healthy operational business", () => {
    expect(evaluateGates(makeBusiness(), params)).toBeNull();
  });

  it("skips non-operational statuses", () => {
    expect(
      evaluateGates(makeBusiness({ business_status: "CLOSED_PERMANENTLY" }), params),
    ).toMatch(/CLOSED_PERMANENTLY/);
    expect(
      evaluateGates(makeBusiness({ business_status: "CLOSED_TEMPORARILY" }), params),
    ).toMatch(/CLOSED_TEMPORARILY/);
  });

  it("passes null business_status (missing data is unknown, not invented)", () => {
    expect(evaluateGates(makeBusiness({ business_status: null }), params)).toBeNull();
  });

  it("enforces min_reviews; a null review count is unknown and PASSES (finding 8)", () => {
    const strict = { ...params, min_reviews: 50 };
    expect(evaluateGates(makeBusiness({ review_count: 49 }), strict)).toMatch(/49 reviews/);
    expect(evaluateGates(makeBusiness({ review_count: 0 }), strict)).toMatch(/0 reviews/);
    expect(evaluateGates(makeBusiness({ review_count: null }), strict)).toBeNull();
    expect(evaluateGates(makeBusiness({ review_count: 50 }), strict)).toBeNull();
    // Same for a null rating under a min_rating gate.
    expect(
      evaluateGates(makeBusiness({ google_rating: null }), { ...params, min_rating: 4 }),
    ).toBeNull();
  });

  it("null reputation adds the low 'Unverified reputation' issue on every completed plan", () => {
    const unknownRep = { review_count: null, google_rating: null };
    const hot = planFilterOutcome(
      makeBusiness({ ...unknownRep, website_url: null, website_kind: "none" }),
      params,
      null,
    );
    expect(hot.issues.map((i) => i.label)).toEqual([
      SPECIAL_CASE_BADGES.noWebsite,
      UNVERIFIED_REPUTATION_LABEL,
    ]);
    expect(hot.issues[1]?.severity).toBe("low");
    const dead = planFilterOutcome(makeBusiness(unknownRep), params, deadProbe);
    expect(dead.issues.map((i) => i.label)).toContain(UNVERIFIED_REPUTATION_LABEL);
    // Measured reputation: no such issue.
    const measured = planFilterOutcome(makeBusiness(), params, deadProbe);
    expect(measured.issues.map((i) => i.label)).not.toContain(UNVERIFIED_REPUTATION_LABEL);
  });

  it("enforces min_rating only when set", () => {
    const strict = { ...params, min_rating: 4 };
    expect(evaluateGates(makeBusiness({ google_rating: 3.2 }), strict)).toMatch(/3.2/);
    expect(evaluateGates(makeBusiness({ google_rating: 4.0 }), strict)).toBeNull();
    // min_rating 0 (default) ignores even null ratings
    expect(evaluateGates(makeBusiness({ google_rating: null }), params)).toBeNull();
  });

  it("excludes chains by default and admits them only when exclude_chains=false (RFL-04)", () => {
    // `params` is parsed without exclude_chains → schema default (true).
    expect(params.exclude_chains).toBe(true);
    expect(evaluateGates(makeBusiness({ is_chain: true }), params)).toMatch(/[Cc]hain/);
    expect(
      planFilterOutcome(makeBusiness({ is_chain: true }), params, null),
    ).toMatchObject({ outcome: "skip", auditStatus: "skipped" });
    // Independents pass the gate either way.
    expect(evaluateGates(makeBusiness({ is_chain: false }), params)).toBeNull();
    // Opting in admits the chain.
    const optIn = { ...params, exclude_chains: false };
    expect(evaluateGates(makeBusiness({ is_chain: true }), optIn)).toBeNull();
    expect(
      planFilterOutcome(makeBusiness({ is_chain: true }), optIn, null).outcome,
    ).toBe("needs_probe");
  });
});

// ---------------------------------------------------------------------------
// Special routing (CLAUDE.md 6.7 — routing is law)
// ---------------------------------------------------------------------------

describe("planFilterOutcome — hot leads", () => {
  it("no-website → sellability 95, never audited, health null", () => {
    const plan = planFilterOutcome(
      makeBusiness({ website_url: null, website_kind: "none" }),
      params,
      null,
    );
    expect(plan.outcome).toBe("hot_lead");
    expect(plan.sellability).toBe(NO_WEBSITE_SELLABILITY_SCORE);
    expect(plan.health).toBeNull();
    expect(plan.star).toBeNull();
    expect(plan.badge).toBe(SPECIAL_CASE_BADGES.noWebsite);
    expect(plan.auditStatus).toBe("completed");
    expect(plan.issues[0]?.severity).toBe("high");
  });

  it("social-only → same 95 treatment with its own badge", () => {
    const plan = planFilterOutcome(
      makeBusiness({
        website_url: "https://www.facebook.com/testplumbing",
        website_kind: "social_only",
      }),
      params,
      null,
    );
    expect(plan.outcome).toBe("hot_lead");
    expect(plan.sellability).toBe(NO_WEBSITE_SELLABILITY_SCORE);
    expect(plan.badge).toBe(SPECIAL_CASE_BADGES.socialOnly);
  });

  it("gates run BEFORE hot-lead routing: closed + no website = skip", () => {
    const plan = planFilterOutcome(
      makeBusiness({
        website_url: null,
        website_kind: "none",
        business_status: "CLOSED_PERMANENTLY",
      }),
      params,
      null,
    );
    expect(plan.outcome).toBe("skip");
    expect(plan.auditStatus).toBe("skipped");
    expect(plan.reason).toMatch(/CLOSED_PERMANENTLY/);
  });
});

describe("planFilterOutcome — real websites", () => {
  it("requires a probe before deciding", () => {
    expect(planFilterOutcome(makeBusiness(), params, null).outcome).toBe("needs_probe");
    // unknown kind is treated like real — probe decides
    expect(
      planFilterOutcome(makeBusiness({ website_kind: "unknown" }), params, null).outcome,
    ).toBe("needs_probe");
  });

  it("dead site → health 10, 1 star, boosted sellability, urgent badge", () => {
    const plan = planFilterOutcome(
      makeBusiness({ review_count: 45, google_rating: 4.2 }),
      params,
      deadProbe,
    );
    expect(plan.outcome).toBe("dead_site");
    expect(plan.health).toBe(10);
    expect(plan.star).toBe(1);
    expect(plan.badge).toBe(SPECIAL_CASE_BADGES.deadSite);
    // 0.4·(100−10) + 0.2·80 + 0.15·100 + 0.1·100 + 0.1·100 + 0.05·100 = 92
    expect(plan.sellability).toBe(92);
    expect(plan.auditStatus).toBe("completed");
    expect(plan.issues[0]?.label).toBe(SPECIAL_CASE_BADGES.deadSite);
  });

  it("blocked site (probe unknown) → one low issue, neutral 50, no badge, not dead", () => {
    const blockedProbe: ProbeResult = {
      alive: "unknown",
      httpStatus: 403,
      responseMs: 210,
      sslValid: true,
      note: "Cloudflare bot protection (HTTP 403)",
      blockedBy: "cloudflare-just-a-moment",
    };
    const plan = planFilterOutcome(
      makeBusiness({ review_count: 127, google_rating: 4.7 }),
      params,
      blockedProbe,
    );
    expect(plan.outcome).toBe("blocked");
    expect(plan.auditStatus).toBe("completed");
    expect(plan.health).toBe(50);
    expect(plan.star).toBeNull();
    expect(plan.badge).toBeNull();
    expect(plan.issues).toEqual([
      {
        severity: "low",
        label: BLOCKED_ISSUE_LABEL,
        detail: "Cloudflare bot protection (HTTP 403)",
      },
    ]);
    expect(
      (plan.breakdown?.health as { blocked?: boolean } | undefined)?.blocked,
    ).toBe(true);
    expect(plan.breakdown?.blocked_by).toBe("cloudflare-just-a-moment");
  });

  it("live site → provisional pending audit, marked provisional", () => {
    const plan = planFilterOutcome(
      makeBusiness({ review_count: 127, google_rating: 4.7 }),
      params,
      aliveProbe,
    );
    expect(plan.outcome).toBe("pending_audit");
    expect(plan.health).toBeNull();
    expect(plan.auditStatus).toBe("pending");
    expect(plan.breakdown?.provisional).toBe(true);
    // neutral health 50 → 0.5·50 + 0.15·100 + 0.1·100 + 0.1·100 + 0.1·100 + 0.05·100 = 75
    expect(plan.sellability).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// runFilter — persistence wiring
// ---------------------------------------------------------------------------

describe("runFilter (MemoryStore + FixtureWebProbe)", () => {
  async function setup(businessOverrides: Partial<UpsertBusinessInput>) {
    const store = new MemoryStore();
    const search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83686", radius_miles: 10, min_reviews: 0, min_rating: 0, exclude_chains: false },
      category: "plumber",
    });
    const business = await store.upsertBusiness({
      workspace_id: DEV_WORKSPACE_ID,
      google_place_id: "fx-test",
      name: "Test Plumbing",
      phone: "(208) 555-0000",
      website_url: "https://testplumbing.com",
      address: null,
      lat: null,
      lng: null,
      google_rating: 4.5,
      review_count: 50,
      category: "plumber",
      business_status: "OPERATIONAL",
      is_chain: false,
      website_kind: "real",
      ...businessOverrides,
    });
    await store.ensureSearchResult(DEV_WORKSPACE_ID, search.id, business.id);
    return { store, search, business };
  }

  it("persists the hot-lead audit and points latest_audit_id at it", async () => {
    const { store, search, business } = await setup({
      website_url: null,
      website_kind: "none",
    });
    const result = await runFilter({
      store,
      probe: new FixtureWebProbe(),
      search,
      business,
      jobId: null,
      cachedAudit: null,
    });

    expect(result.status).toBe("completed");
    expect(result.output?.outcome).toBe("hot_lead");

    const detail = await store.getSearchDetail(search.id);
    const lead = detail?.leads[0];
    expect(lead?.result.latest_audit_id).toBe(result.output?.audit_id);
    expect(lead?.audit?.sellability_score).toBe(NO_WEBSITE_SELLABILITY_SCORE);
    expect(lead?.audit?.website_health_score).toBeNull();
    expect(lead?.audit?.status).toBe("completed");
  });

  it("probes real sites and records dead-site audits", async () => {
    const { store, search, business } = await setup({
      website_url: "http://www.oldfaithfulplumbing.com", // DEAD_FIXTURE_HOSTS
      website_kind: "real",
    });
    const result = await runFilter({
      store,
      probe: new FixtureWebProbe(),
      search,
      business,
      jobId: null,
      cachedAudit: null,
    });

    expect(result.output?.outcome).toBe("dead_site");
    const detail = await store.getSearchDetail(search.id);
    expect(detail?.leads[0]?.audit?.website_health_score).toBe(10);
    expect(detail?.leads[0]?.audit?.star_grade).toBe(1);
  });

  it("sorts hot leads above provisional leads in search detail", async () => {
    const store = new MemoryStore();
    const search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83686", radius_miles: 10, min_reviews: 0, min_rating: 0, exclude_chains: false },
      category: "plumber",
    });
    const probe = new FixtureWebProbe();

    const hot = await store.upsertBusiness({
      workspace_id: DEV_WORKSPACE_ID,
      google_place_id: "fx-hot",
      name: "No Site Plumbing",
      phone: "(208) 555-0001",
      website_url: null,
      address: null,
      lat: null,
      lng: null,
      google_rating: 4.8,
      review_count: 200,
      category: "plumber",
      business_status: "OPERATIONAL",
      is_chain: false,
      website_kind: "none",
    });
    const live = await store.upsertBusiness({
      workspace_id: DEV_WORKSPACE_ID,
      google_place_id: "fx-live",
      name: "Aardvark Plumbing", // alphabetically first — sort must be by score
      phone: "(208) 555-0002",
      website_url: "https://aardvarkplumbing.com",
      address: null,
      lat: null,
      lng: null,
      google_rating: 4.9,
      review_count: 300,
      category: "plumber",
      business_status: "OPERATIONAL",
      is_chain: false,
      website_kind: "real",
    });
    for (const business of [live, hot]) {
      await store.ensureSearchResult(DEV_WORKSPACE_ID, search.id, business.id);
      await runFilter({ store, probe, search, business, jobId: null, cachedAudit: null });
    }

    const detail = await store.getSearchDetail(search.id);
    expect(detail?.leads.map((l) => l.business.name)).toEqual([
      "No Site Plumbing", // 95
      "Aardvark Plumbing", // provisional 80
    ]);
  });
});
