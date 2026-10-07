/**
 * money-facts (Sprint 7 shared view) — the Design block used to drop every
 * {issue, evidence} object because it only kept strings, so Analyst /
 * Builder Brief / Sales Summary always saw `critical_issues: []` (RFL.FIX.3g).
 */
import { describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import { buildAnalystPrompt } from "./prompts/analyst";
import { resolveConfigVars } from "./prompts/config-vars";
import { buildAuditFacts, factsToPromptJson } from "./money-facts";

function business(): Business {
  return {
    id: "biz-1",
    workspace_id: "ws-1",
    google_place_id: "fx-1",
    name: "Landers Home Services",
    phone: "(208) 250-0058",
    website_url: "https://landershomeservices.com/",
    address: "11567 Lake Shore Dr, Nampa, ID 83686, USA",
    lat: null,
    lng: null,
    google_rating: 4.8,
    review_count: 33,
    category: "general_contractor",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    first_seen_at: null,
    last_refreshed_at: null,
  };
}

function audit(design: unknown): Audit {
  return {
    id: "aud-1",
    workspace_id: "ws-1",
    business_id: "biz-1",
    website_url: "https://landershomeservices.com/",
    ps_performance: 50,
    ps_mobile_performance: 50,
    ps_accessibility: 70,
    ps_seo: 60,
    ps_best_practices: 70,
    ps_lcp_ms: 15951,
    ps_cls: 0.1,
    http_status: 200,
    ssl_valid: true,
    response_ms: 900,
    platform: "wordpress",
    copyright_year: null,
    has_phone: true,
    has_form: false,
    has_booking: false,
    has_chat: false,
    has_viewport_meta: true,
    has_schema_markup: true,
    gbp_photo_count: null,
    gbp_review_velocity: null,
    has_crux_data: false,
    screenshot_desktop_url: null,
    screenshot_mobile_url: null,
    website_health_score: 58,
    star_grade: 3,
    sellability_score: 68,
    score_breakdown: { v15_agents: { design } },
    issues: [],
    analyst_output: null,
    builder_brief_md: null,
    sales_summary: null,
    status: "completed",
    error_message: null,
    created_at: null,
    completed_at: "2026-10-04T07:34:00.000Z",
  } as Audit;
}

describe("factsToPromptJson — dedup (RFL.FIX.3h)", () => {
  it("drops agents_run and the duplicated reputation rating/count, keeps everything else", () => {
    const facts = buildAuditFacts(
      business(),
      {
        ...audit({ modernity_0_100: 67, feels_like_year: 2019, critical_issues: [] }),
        score_breakdown: {
          v15_agents: {
            design: { modernity_0_100: 67, feels_like_year: 2019, critical_issues: [] },
            reputation: {
              google_rating: 4.8,
              review_count: 33,
              volume_band: "moderate",
              review_velocity_per_month: null,
              summary: { verdict: "strong" },
            },
          },
        },
      } as Audit,
    );
    const json = JSON.parse(factsToPromptJson(facts)) as Record<string, unknown>;
    expect(json.agents_run).toBeUndefined();
    expect(json.reputation).toEqual({ verdict: "strong", volume_band: "moderate", review_velocity_per_month: null });
    // The business block still carries the one copy of rating and count.
    expect((json.business as Record<string, unknown>).google_rating).toBe(4.8);
    expect((json.business as Record<string, unknown>).review_count).toBe(33);
    expect(json.scores).toEqual(facts.scores);
    expect(json.health).toEqual(facts.health);
    expect(json.design).toEqual(facts.design);
    // facts itself is untouched for the guardrails.
    expect(facts.agents_run).toContain("reputation");
    expect(facts.reputation?.google_rating).toBe(4.8);
    expect(factsToPromptJson(facts).length).toBeLessThan(JSON.stringify(facts, null, 2).length);
  });

  it("a null reputation block stays null", () => {
    const json = JSON.parse(factsToPromptJson(buildAuditFacts(business(), audit(undefined))));
    expect(json.reputation).toBeNull();
  });
});

describe("buildAuditFacts — design critical issues", () => {
  it("design critical issues reach the money agents (object form, as Design persists them)", () => {
    const facts = buildAuditFacts(
      business(),
      audit({
        modernity_0_100: 67,
        feels_like_year: 2019,
        used_vision: false,
        critical_issues: [
          {
            issue: "Stock wordpress template appearance is likely",
            evidence: "wordpress platform fingerprints in the page source (measured, not visual)",
          },
        ],
      }),
    );
    expect(facts.design).not.toBeNull();
    expect(facts.design!.critical_issues).toEqual([
      "Stock wordpress template appearance is likely",
    ]);
    // ...and the Analyst prompt carries it instead of `"critical_issues": []`.
    const prompt = buildAnalystPrompt(facts, resolveConfigVars(null));
    expect(prompt).toContain("Stock wordpress template appearance is likely");
  });

  it("keeps plain-string issues (older rows) and drops malformed entries", () => {
    const facts = buildAuditFacts(
      business(),
      audit({
        modernity_0_100: 40,
        feels_like_year: 2016,
        critical_issues: ["dated hero", { issue: "no mobile menu", evidence: "x" }, { nope: 1 }, 7, ""],
      }),
    );
    expect(facts.design!.critical_issues).toEqual(["dated hero", "no mobile menu"]);
  });

  it("design absent → null block; non-array critical_issues → []", () => {
    expect(buildAuditFacts(business(), audit(undefined)).design).toBeNull();
    expect(
      buildAuditFacts(business(), audit({ modernity_0_100: 55, critical_issues: "nope" })).design!
        .critical_issues,
    ).toEqual([]);
  });
});
