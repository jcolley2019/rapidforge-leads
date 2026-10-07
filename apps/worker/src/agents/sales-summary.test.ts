import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import { countWords } from "./guardrails/analyst";
import {
  bannedWordsIn,
  isSpecificObservation,
  salesSummaryGuardrail,
} from "./guardrails/sales-summary";
import { buildAuditFacts } from "./money-facts";
import { buildTemplateSalesSummary, runSalesSummary } from "./sales-summary";
import { buildSalesSummarySystem, type SalesSummaryOutput } from "./prompts/sales-summary";
import { CONFIG_DEFAULTS, resolveConfigVars } from "./prompts/config-vars";

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
    score_breakdown: { v15_agents: {} },
    issues: [{ severity: "high", label: "Slow on mobile" }],
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

const VALID: SalesSummaryOutput = {
  opener: "Hi, is this Boise Drain Pros?",
  earned_observation: "Your homepage scores 32 out of 100 for mobile speed.",
  pain_hypothesis: "That costs you calls from phone visitors.",
  offer: "I'll send a free before-and-after mockup, no charge.",
  soft_close: "Mind if I email it over?",
  full_talk_track:
    "Hi, is this Boise Drain Pros? Your homepage scores 32 out of 100 for mobile speed, which feels slow on a phone. That costs you calls. I'll send a free mockup. Mind if I email it over?",
  anticipated_objections: [
    { objection: "I have a site.", response: "Just showing a few fixes." },
    { objection: "Not interested.", response: "Want the free mockup anyway?" },
  ],
};

describe("sales summary guardrail helpers", () => {
  it("detects specific vs vague observations", () => {
    expect(isSpecificObservation("scores 32 out of 100 on mobile")).toBe(true);
    expect(isSpecificObservation("your site could be a lot better")).toBe(false);
  });

  it("flags banned words case-insensitively", () => {
    expect(bannedWordsIn("Let's circle back and LEVERAGE this")).toEqual([
      "leverage",
      "circle back",
    ]);
    expect(bannedWordsIn("a fast, modern homepage")).toEqual([]);
  });
});

describe("salesSummaryGuardrail", () => {
  it("accepts a specific, clean, 2-objection talk track", () => {
    expect(salesSummaryGuardrail(VALID).passed).toBe(true);
  });

  it("rejects a non-specific earned_observation", () => {
    const bad = {
      ...VALID,
      earned_observation: "Your website could be a lot better than today.",
    };
    expect(salesSummaryGuardrail(bad).passed).toBe(false);
  });

  it("rejects a talk track over 150 words", () => {
    const bad = { ...VALID, full_talk_track: Array(151).fill("word").join(" ") };
    expect(salesSummaryGuardrail(bad).passed).toBe(false);
  });

  it("rejects a banned word anywhere", () => {
    const bad = { ...VALID, offer: "Let's leverage a quick win here." };
    expect(salesSummaryGuardrail(bad).passed).toBe(false);
  });

  it("rejects fewer than 2 objections", () => {
    const bad = {
      ...VALID,
      anticipated_objections: VALID.anticipated_objections.slice(0, 1),
    };
    expect(salesSummaryGuardrail(bad).passed).toBe(false);
  });
});

describe("buildTemplateSalesSummary", () => {
  it("produces a guardrail-passing talk track under 150 words", () => {
    const facts = buildAuditFacts(makeBusiness(), makeAudit());
    const out = buildTemplateSalesSummary(facts);
    expect(salesSummaryGuardrail(out).passed).toBe(true);
    expect(countWords(out.full_talk_track)).toBeLessThanOrEqual(150);
    expect(isSpecificObservation(out.earned_observation)).toBe(true);
    expect(out.anticipated_objections.length).toBeGreaterThanOrEqual(2);
    expect(bannedWordsIn(out.full_talk_track)).toEqual([]);
  });
});

describe("buildSalesSummarySystem — brand, location, voice (RFL.FIX.3h)", () => {
  it("names who the rep is calling on behalf of, from workspace_config", () => {
    const vars = resolveConfigVars({
      workspace_id: "ws-1",
      your_offer: "a rebuild",
      target_industry: "plumbers",
      ideal_website_traits: "fast",
      sales_tone: "warm and blunt",
      user_location: "Boise, Idaho",
      user_brand: "Treasure Valley Web Co",
    } as never);
    const system = buildSalesSummarySystem(vars);
    expect(system).toContain("on behalf of Treasure Valley Web Co in Boise, Idaho");
    expect(system).toContain("Voice: warm and blunt.");
    expect(system).not.toMatch(/\{[a-z_]+\}/);
  });

  it("blank Settings fall back to the neutral defaults", () => {
    const system = buildSalesSummarySystem(resolveConfigVars(null));
    expect(system).toContain(`on behalf of ${CONFIG_DEFAULTS.user_brand} in ${CONFIG_DEFAULTS.user_location}`);
    expect(system).not.toMatch(/\{[a-z_]+\}/);
  });
});

describe("runSalesSummary (template mode, no API key)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("completes with the deterministic template", async () => {
    const result = await runSalesSummary({
      business: makeBusiness(),
      audit: makeAudit(),
      config: null,
    });
    expect(result.status).toBe("completed");
    expect(result.modelUsed).toBeNull();
    expect(result.output?.anticipated_objections.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(result.guardrailPassed).toBe(true);
  });
});
