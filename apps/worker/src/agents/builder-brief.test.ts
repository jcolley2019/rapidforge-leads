import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import { buildTemplateBrief, runBuilderBrief } from "./builder-brief";
import { countWords } from "./guardrails/analyst";
import {
  builderBriefGuardrail,
  missingSections,
  placeholdersIn,
} from "./guardrails/builder-brief";
import { buildAuditFacts } from "./money-facts";
import {
  BRIEF_SECTIONS,
  deriveKeywords,
  parseCity,
} from "./prompts/builder-brief";
import { resolveConfigVars } from "./prompts/config-vars";

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
    issues: [
      { severity: "high", label: "Slow on mobile", detail: "Mobile perf 32/100" },
      { severity: "medium", label: "Dated design" },
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

function templateBrief(): string {
  const facts = buildAuditFacts(makeBusiness(), makeAudit());
  const vars = resolveConfigVars(null);
  return buildTemplateBrief(facts, vars, [], deriveKeywords(facts), null);
}

describe("builder brief helpers", () => {
  it("parses a city from a Places address", () => {
    expect(parseCity("7800 W Fairview Ave, Boise, ID 83704")).toBe("Boise");
    expect(parseCity(null)).toBeNull();
  });

  it("derives {city}+{category} keywords", () => {
    const facts = buildAuditFacts(makeBusiness(), makeAudit());
    const kws = deriveKeywords(facts);
    expect(kws.some((k) => k.includes("Boise"))).toBe(true);
    expect(kws.some((k) => k.includes("plumber"))).toBe(true);
  });

  it("flags placeholder tokens but not ordinary markdown links", () => {
    expect(placeholdersIn("Call [INSERT NAME] today").length).toBe(1);
    expect(placeholdersIn("Set the {business_name} here").length).toBe(1);
    expect(placeholdersIn("See [our services](/services) now")).toEqual([]);
  });
});

describe("builderBriefGuardrail", () => {
  it("passes the deterministic template", () => {
    const md = templateBrief();
    expect(missingSections(md)).toEqual([]);
    expect(builderBriefGuardrail(md).passed).toBe(true);
  });

  it("rejects a brief missing a required section", () => {
    const md = templateBrief().replace("## Deploy instructions", "## Shipping");
    expect(builderBriefGuardrail(md).passed).toBe(false);
  });

  it("rejects a brief containing a placeholder", () => {
    const md = `${templateBrief()}\n\nContact [INSERT NAME] for details.`;
    expect(builderBriefGuardrail(md).passed).toBe(false);
  });

  it("rejects a brief over 2000 words", () => {
    const md = `${templateBrief()}\n\n${Array(2001).fill("word").join(" ")}`;
    expect(builderBriefGuardrail(md).passed).toBe(false);
  });
});

describe("buildTemplateBrief", () => {
  it("is complete, placeholder-free, and under 2000 words", () => {
    const md = templateBrief();
    expect(builderBriefGuardrail(md).passed).toBe(true);
    expect(countWords(md)).toBeLessThan(2000);
    expect(md).toContain("Boise Drain Pros");
    expect(md).toContain("## AEO requirements");
  });

  it("emits every one of the 12 PRD sections under its own H2 header", () => {
    const md = templateBrief();
    expect(BRIEF_SECTIONS).toHaveLength(12);
    for (const section of BRIEF_SECTIONS) {
      expect(md).toContain(`## ${section}`);
    }
    expect(missingSections(md)).toEqual([]);
  });
});

describe("runBuilderBrief (template mode, no API key)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("completes with a complete markdown brief", async () => {
    const result = await runBuilderBrief({
      business: makeBusiness(),
      audit: makeAudit(),
      config: null,
      competitors: [
        {
          name: "Snake River Plumbing",
          google_rating: 4.7,
          review_count: 127,
          website_url: "https://snakeriverplumbing.com",
        },
      ],
      siteHtmlExcerpt: "Boise Drain Pros — drain cleaning and repair.",
    });
    expect(result.status).toBe("completed");
    expect(result.modelUsed).toBeNull();
    expect(result.output?.sections).toHaveLength(12);
    expect(result.output?.markdown).toContain("Snake River Plumbing");
    expect(result.guardrailPassed).toBe(true);
  });
});

describe("RFL.BRIEF.7 — section anchoring and embedded Design Brief JSON", () => {
  it("a sentence containing a section name no longer satisfies the H2 check", () => {
    const md = buildTemplateBrief(
      buildAuditFacts(makeBusiness(), makeAudit()),
      resolveConfigVars(null),
      [],
      ["plumber Boise"],
      null,
    ).replace("## Assets", "We also cover the assets here.");
    expect(missingSections(md)).toEqual(["Assets"]);
    // Headings with trailing words / emphasis still count.
    expect(missingSections(md.replace("We also cover the assets here.", "## **Assets** and media"))).toEqual([]);
  });

  it("runBuilderBrief embeds a parseable Design Brief under '## Design Brief (JSON)'", async () => {
    const result = await runBuilderBrief({
      business: makeBusiness({
        places_details: {
          reviews: [
            { rating: 5, text: { text: "They cleared our main line in an hour and left the place spotless." } },
          ],
          regularOpeningHours: { weekdayDescriptions: ["Monday: 8:00 AM – 5:00 PM"] },
        },
      }),
      audit: makeAudit(),
      config: null,
      competitors: [],
      siteHtmlExcerpt: null,
    });
    expect(result.status).toBe("completed");
    const md = result.output!.markdown;
    const block = /## Design Brief \(JSON\)\n\n```json\n([\s\S]*?)\n```/.exec(md);
    expect(block).not.toBeNull();
    const brief = JSON.parse(block![1]!) as { business_name: string; review_quotes: unknown[]; hours: unknown[] | null };
    expect(brief.business_name).toBe(makeBusiness().name);
    expect(brief.review_quotes).toHaveLength(1);
    expect(brief.hours).toHaveLength(7);
    // The 12 PRD sections are still exactly the 12 (the JSON H2 is extra).
    expect(result.output!.sections).toHaveLength(12);
  });
});
