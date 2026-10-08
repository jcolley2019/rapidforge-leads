import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Audit, Business, DesignBrief } from "@rapidforge/shared";
import {
  BRIEF_MAX_TOKENS,
  BRIEF_TIMEOUT_MS,
  briefBusinessInputsOf,
  buildTemplateBrief,
  runBuilderBrief,
  storedDesignBrief,
} from "./builder-brief";
import { reviewTextsOf } from "./design-brief";
import { FIXTURE_DETAILS } from "../lib/places/fixtures";
import { countWords } from "./guardrails/analyst";
import {
  builderBriefGuardrail,
  missingSections,
  placeholdersIn,
} from "./guardrails/builder-brief";
import { buildAuditFacts } from "./money-facts";
import { cityFromPlacesAddress } from "../lib/address";
import {
  BRIEF_REVIEW_QUOTES_MAX,
  BRIEF_SECTIONS,
  buildBuilderBriefPrompt,
  deriveKeywords,
} from "./prompts/builder-brief";
import { resolveConfigVars } from "./prompts/config-vars";
import { MODEL_HAIKU, MODEL_OPUS } from "../lib/ai";
import { coreModeEnv, fakeProvider, jsonReply, truncatedReply } from "../lib/ai.testkit";
import { STAGE_BUDGET_MS } from "../orchestrator";

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
    expect(cityFromPlacesAddress("7800 W Fairview Ave, Boise, ID 83704")).toBe("Boise");
    // Places (New) 4-part form — the old parser returned "ID 83686".
    expect(cityFromPlacesAddress("1519 W Florida Ave, Nampa, ID 83686, USA")).toBe("Nampa");
    expect(cityFromPlacesAddress(null)).toBeNull();
    const facts = buildAuditFacts(
      makeBusiness({ address: "1519 W Florida Ave, Nampa, ID 83686, USA" }),
      makeAudit(),
    );
    const kws = deriveKeywords(facts);
    expect(kws).toContain("best plumber in Nampa");
    expect(kws.some((k) => k.includes("83686"))).toBe(false);
  });

  it("derives {city}+{category} keywords", () => {
    const facts = buildAuditFacts(makeBusiness(), makeAudit());
    const kws = deriveKeywords(facts);
    expect(kws.some((k) => k.includes("Boise"))).toBe(true);
    expect(kws.some((k) => k.includes("plumber"))).toBe(true);
  });

  it("prints the humanised category in keywords (RFL.FIX.3c)", () => {
    const facts = buildAuditFacts(
      makeBusiness({
        category: "general_contractor",
        address: "11567 Lake Shore Dr, Nampa, ID 83686, USA",
      }),
      makeAudit(),
    );
    const kws = deriveKeywords(facts);
    expect(kws).toContain("general contractor Nampa");
    expect(kws).toContain("best general contractor in Nampa");
    expect(kws.some((k) => k.includes("general_contractor"))).toBe(false);
  });

  it("flags placeholder tokens but not ordinary markdown links", () => {
    expect(placeholdersIn("Call [INSERT NAME] today").length).toBe(1);
    expect(placeholdersIn("Set the {business_name} here").length).toBe(1);
    expect(placeholdersIn("See [our services](/services) now")).toEqual([]);
  });
});

describe("Builder Brief GBP inputs (RFL.FIX.3h) — from loaded rows only", () => {
  it("prints hours, photo count, up to 3 verbatim quotes and screenshot URLs when the rows hold them", () => {
    const business = makeBusiness({
      places_details: FIXTURE_DETAILS["fx-001"] as Business["places_details"],
    });
    const audit = makeAudit({
      screenshot_desktop_url: "https://cdn.example/desk.jpg",
      screenshot_mobile_url: "https://cdn.example/mob.jpg",
    });
    const inputs = briefBusinessInputsOf(business, audit);
    expect(inputs.hours).not.toBeNull();
    expect(inputs.hours!.map((h) => h.day)).toContain("Monday");
    expect(inputs.photo_count).toBe(2);
    expect(inputs.review_quotes.length).toBeGreaterThan(0);
    expect(inputs.review_quotes.length).toBeLessThanOrEqual(BRIEF_REVIEW_QUOTES_MAX);
    const haystack = reviewTextsOf(business).join("\n");
    for (const q of inputs.review_quotes) expect(haystack).toContain(q.text);

    const facts = buildAuditFacts(business, audit);
    const prompt = buildBuilderBriefPrompt(facts, resolveConfigVars(null), [], deriveKeywords(facts), null, inputs);
    expect(prompt).toContain("- Hours: Sun ");
    expect(prompt).toContain("- Photos on the listing: 2");
    expect(prompt).toContain(`- "${inputs.review_quotes[0]!.text}"`);
    expect(prompt).toContain("desktop https://cdn.example/desk.jpg; mobile https://cdn.example/mob.jpg");
  });

  it("says unknown / none held / not captured when the rows hold nothing — never invents", () => {
    const inputs = briefBusinessInputsOf(makeBusiness(), makeAudit());
    expect(inputs).toEqual({
      hours: null,
      photo_count: null,
      review_quotes: [],
      screenshot_desktop_url: null,
      screenshot_mobile_url: null,
    });
    const facts = buildAuditFacts(makeBusiness(), makeAudit());
    const prompt = buildBuilderBriefPrompt(facts, resolveConfigVars(null), [], deriveKeywords(facts), null, inputs);
    expect(prompt).toContain("- Hours: unknown (no Places details held)");
    expect(prompt).toContain("- Photos on the listing: unknown");
    expect(prompt).toContain("- none held");
    expect(prompt).toContain("- Current-site screenshots: not captured");
    // Omitting the block entirely (older callers) is also honest.
    expect(buildBuilderBriefPrompt(facts, resolveConfigVars(null), [], deriveKeywords(facts), null)).toContain(
      "Google Business Profile: unknown (no details held)",
    );
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

describe("runBuilderBrief on Opus (RFL.VERIFY.3 V1) — one call, 8,000 cap, request timeout = budget", () => {
  let restoreEnv: () => void;
  let restoreProvider: (() => void) | null = null;
  beforeEach(() => {
    restoreEnv = coreModeEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreProvider?.();
    restoreProvider = null;
    restoreEnv();
    vi.restoreAllMocks();
  });

  const judgment = jsonReply({
    tone_descriptors: ["dependable", "local", "straightforward"],
    services: ["Drain cleaning"],
  });
  const ctx = () => ({
    business: makeBusiness(),
    audit: makeAudit(),
    config: null,
    competitors: [],
    siteHtmlExcerpt: null,
  });

  it("the cap is 8,000 and the request timeout is the on-demand budget", () => {
    expect(BRIEF_MAX_TOKENS).toBe(8_000);
    expect(BRIEF_TIMEOUT_MS).toBe(STAGE_BUDGET_MS.analyst);
  });

  it("a truncation makes exactly one Opus call, fails the run 'truncated at 8000' and keeps the template as output", async () => {
    const p = fakeProvider((req) =>
      req.model === MODEL_OPUS ? truncatedReply("## Project overview\nOPUS-CUT-OFF-TEXT") : judgment,
    );
    restoreProvider = p.restore;
    const result = await runBuilderBrief(ctx());

    const opus = p.requests.filter((r) => r.model === MODEL_OPUS);
    expect(opus).toHaveLength(1);
    expect(opus[0]).toMatchObject({ maxTokens: 8_000, timeoutMs: 120_000 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("truncated at 8000");
    expect(result.modelUsed).toBeNull();
    expect(result.guardrailPassed).toBe(false);
    expect(result.guardrailNotes).toContain("Truncated at max_tokens 8000");
    // The template is the output the route stores; the cut-off text is not.
    expect(result.output!.markdown.startsWith(templateBrief().replace(/\s+$/, ""))).toBe(true);
    expect(result.output!.markdown).not.toContain("OPUS-CUT-OFF-TEXT");
    expect(result.output!.sections).toHaveLength(12);
    // The cut-off call was paid for, so it is counted.
    expect(result.costMicrocents).toBeGreaterThan(0);
  });

  it("a reply that finishes is one Opus call and a completed run", async () => {
    const p = fakeProvider((req) => (req.model === MODEL_OPUS ? { text: templateBrief() } : judgment));
    restoreProvider = p.restore;
    const result = await runBuilderBrief(ctx());

    expect(p.requests.filter((r) => r.model === MODEL_OPUS)).toHaveLength(1);
    expect(p.requests.filter((r) => r.model === MODEL_HAIKU)).toHaveLength(1);
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.modelUsed).toBe(MODEL_OPUS);
    expect(result.guardrailPassed).toBe(true);
  });
});

describe("Builder Brief reuses a stored Design Brief (RFL.VERIFY.3 V8)", () => {
  let restoreEnv: () => void;
  let restoreProvider: (() => void) | null = null;
  beforeEach(() => {
    restoreEnv = coreModeEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreProvider?.();
    restoreProvider = null;
    restoreEnv();
    vi.restoreAllMocks();
  });

  const STORED: DesignBrief = {
    business_name: "Boise Drain Pros",
    vertical: "plumber",
    tone_descriptors: ["stored-tone-a", "stored-tone-b", "stored-tone-c"],
    services: ["Stored service"],
    review_quotes: [],
    photo_urls: [],
    hours: null,
    phone: "(208) 555-0102",
    address: "7800 W Fairview Ave, Boise, ID 83704",
    primary_cta: { label: "Call (208) 555-0102", kind: "phone", href: "tel:2085550102" },
    current_site_problem: "Slow on mobile",
    generated_at: "2026-10-07T23:24:54.000Z",
    source: { audit_id: "aud-1", haiku_model: "claude-haiku-4-5", template_fallback: false },
  };
  const replies = () =>
    fakeProvider((req) =>
      req.model === MODEL_OPUS
        ? { text: templateBrief() }
        : jsonReply({ tone_descriptors: ["fresh-a", "fresh-b", "fresh-c"], services: ["Fresh service"] }),
    );
  const ctx = (audit: Audit, force?: boolean) => ({
    business: makeBusiness(),
    audit,
    config: null,
    competitors: [],
    siteHtmlExcerpt: null,
    ...(force === undefined ? {} : { force }),
  });

  it("a stored brief → zero Design Brief calls; the markdown embeds the stored JSON", async () => {
    const p = replies();
    restoreProvider = p.restore;
    const result = await runBuilderBrief(ctx(makeAudit({ design_brief: STORED })));

    expect(p.requests.filter((r) => r.model === MODEL_HAIKU)).toHaveLength(0);
    expect(p.requests.filter((r) => r.model === MODEL_OPUS)).toHaveLength(1);
    expect(result.status).toBe("completed");
    expect(result.output!.design_brief).toEqual(STORED);
    expect(result.output!.markdown).toContain(JSON.stringify(STORED, null, 2));
  });

  it("?force=true still regenerates it: one Design Brief call, fresh fields", async () => {
    const p = replies();
    restoreProvider = p.restore;
    const result = await runBuilderBrief(ctx(makeAudit({ design_brief: STORED }), true));

    expect(p.requests.filter((r) => r.model === MODEL_HAIKU)).toHaveLength(1);
    expect(result.output!.design_brief?.tone_descriptors).toEqual(["fresh-a", "fresh-b", "fresh-c"]);
  });

  it("nothing stored, or a stored value that no longer parses → one Design Brief call", async () => {
    expect(storedDesignBrief(makeAudit())).toBeNull();
    expect(storedDesignBrief(makeAudit({ design_brief: { business_name: "half a brief" } }))).toBeNull();
    expect(storedDesignBrief(makeAudit({ design_brief: STORED }))).toEqual(STORED);

    const p = replies();
    restoreProvider = p.restore;
    await runBuilderBrief(ctx(makeAudit({ design_brief: { business_name: "half a brief" } })));
    expect(p.requests.filter((r) => r.model === MODEL_HAIKU)).toHaveLength(1);
  });
});
