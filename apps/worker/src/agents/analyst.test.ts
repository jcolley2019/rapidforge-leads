import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import { buildTemplateAnalyst, runAnalyst } from "./analyst";
import {
  agentsCitedIn,
  countWords,
  makeAnalystGuardrail,
} from "./guardrails/analyst";
import { buildAuditFacts } from "./money-facts";
import type { AnalystOutput } from "./prompts/analyst";

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz-1",
    workspace_id: "ws-1",
    google_place_id: "fx-1",
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
    first_seen_at: null,
    last_refreshed_at: null,
    ...overrides,
  };
}

function makeAudit(overrides: Partial<Audit> = {}): Audit {
  return {
    id: "aud-1",
    workspace_id: "ws-1",
    business_id: "biz-1",
    website_url: "https://boisedrainpros.wixsite.com/home",
    ps_performance: 40,
    ps_mobile_performance: 32,
    ps_accessibility: 70,
    ps_seo: 60,
    ps_best_practices: 70,
    ps_lcp_ms: 4200,
    ps_cls: 0.2,
    http_status: 200,
    ssl_valid: true,
    response_ms: 900,
    platform: "wix",
    copyright_year: 2019,
    has_phone: false,
    has_form: false,
    has_booking: false,
    has_chat: false,
    has_viewport_meta: true,
    has_schema_markup: false,
    gbp_photo_count: null,
    gbp_review_velocity: null,
    has_crux_data: false,
    screenshot_desktop_url: null,
    screenshot_mobile_url: null,
    website_health_score: 36,
    star_grade: 2,
    sellability_score: 82,
    score_breakdown: {
      v15_agents: {
        design: {
          modernity_0_100: 40,
          feels_like_year: 2016,
          critical_issues: ["dated hero", "no mobile menu"],
        },
        reputation: {
          google_rating: 4.5,
          review_count: 89,
          volume_band: "high",
          review_velocity_per_month: 2.1,
          summary: { verdict: "solid" },
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
      { severity: "high", label: "Slow on mobile", detail: "Mobile perf 32/100" },
      { severity: "high", label: "No click-to-call", detail: "No tel: link" },
      { severity: "medium", label: "Dated design", detail: "Feels like 2016" },
      { severity: "low", label: "Missing meta description" },
    ],
    analyst_output: null,
    builder_brief_md: null,
    sales_summary: null,
    status: "completed",
    error_message: null,
    created_at: null,
    completed_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

const VALID: AnalystOutput = {
  verdict: "needs_rebuild",
  sales_lead_priority: "hot",
  top_3_improvements: [
    { priority: 1, improvement: "A", rationale: "a", estimated_impact: "x" },
    { priority: 2, improvement: "B", rationale: "b", estimated_impact: "y" },
    { priority: 3, improvement: "C", rationale: "c", estimated_impact: "z" },
  ],
  reasoning:
    "The health agent scored 36/100. Design rated modernity 40. SEO local fit is 2/5.",
  one_line_verdict: "Dated site leaving calls on the table.",
};

describe("analyst guardrail helpers", () => {
  it("counts words and distinct agents cited", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("   ")).toBe(0);
    expect(agentsCitedIn("health and DESIGN plus seo").sort()).toEqual([
      "design",
      "health",
      "seo",
    ]);
  });
});

describe("makeAnalystGuardrail", () => {
  const guard = makeAnalystGuardrail(2);

  it("accepts a consistent, well-cited verdict", () => {
    expect(guard(VALID).passed).toBe(true);
  });

  it("rejects fewer than 3 improvements", () => {
    const bad = { ...VALID, top_3_improvements: VALID.top_3_improvements.slice(0, 2) };
    expect(guard(bad).passed).toBe(false);
  });

  it("rejects reasoning citing fewer than 3 agents", () => {
    const bad = { ...VALID, reasoning: "The health agent scored 36/100." };
    expect(guard(bad).passed).toBe(false);
  });

  it("rejects a one-line verdict over 20 words", () => {
    const bad = { ...VALID, one_line_verdict: Array(21).fill("word").join(" ") };
    expect(guard(bad).passed).toBe(false);
  });

  it("rejects a verdict inconsistent with the star grade", () => {
    const bad: AnalystOutput = { ...VALID, verdict: "excellent" };
    expect(guard(bad).passed).toBe(false);
  });
});

describe("buildTemplateAnalyst", () => {
  it("produces a guardrail-passing verdict for a dated 2★ site", () => {
    const facts = buildAuditFacts(makeBusiness(), makeAudit());
    const out = buildTemplateAnalyst(facts);
    expect(out.verdict).toBe("needs_rebuild");
    expect(out.top_3_improvements).toHaveLength(3);
    expect(agentsCitedIn(out.reasoning).length).toBeGreaterThanOrEqual(3);
    expect(countWords(out.one_line_verdict)).toBeLessThanOrEqual(20);
    expect(makeAnalystGuardrail(2)(out).passed).toBe(true);
  });

  it("produces an 'excellent' verdict for a 5★ site with no issues", () => {
    const facts = buildAuditFacts(
      makeBusiness({ name: "Stripe" }),
      makeAudit({
        star_grade: 5,
        website_health_score: 96,
        sellability_score: 96,
        issues: [],
        score_breakdown: { v15_agents: {} },
      }),
    );
    const out = buildTemplateAnalyst(facts);
    expect(out.verdict).toBe("excellent");
    expect(out.top_3_improvements).toHaveLength(3);
    expect(makeAnalystGuardrail(5)(out).passed).toBe(true);
  });
});

describe("runAnalyst (template mode, no API key)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("completes with the deterministic template and no model cost", async () => {
    const result = await runAnalyst({
      business: makeBusiness(),
      audit: makeAudit(),
      config: null,
    });
    expect(result.status).toBe("completed");
    expect(result.modelUsed).toBeNull();
    expect(result.costCents).toBe(0);
    expect(result.output?.top_3_improvements).toHaveLength(3);
    expect(result.guardrailPassed).toBe(true);
  });
});
