/**
 * Design Brief agent (RFL.BRIEF.7): deterministic assembly over a fixture
 * business with full places_details, the verbatim-quote guardrail, the CTA
 * priority chain, hours normalization, and the Haiku → template fallback
 * (throws / refusal / bad JSON) through lib/ai's transport seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesignBriefSchema,
  type Audit,
  type Business,
  type DesignBrief,
} from "@rapidforge/shared";
import { FIXTURE_DETAILS } from "../lib/places/fixtures";
import type { AiCallOptions, AiCallResult } from "../lib/ai";
import {
  buildDesignBrief,
  embedDesignBrief,
  normalizeHours,
  pickPrimaryCta,
  pickReviewQuotes,
  pickSiteProblem,
  photoUrlsOf,
  runDesignBrief,
  templateServices,
  templateTone,
} from "./design-brief";
import { designBriefGuardrail, quoteIsVerbatim } from "./guardrails/design-brief";

const DETAILS = {
  ...FIXTURE_DETAILS["fx-001"],
  fetchedAt: "2026-07-06T07:00:00.000Z",
} as Record<string, unknown>;

function business(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz-1",
    workspace_id: "ws-1",
    google_place_id: "fx-001",
    name: "Snake River Plumbing Co",
    phone: "(208) 555-0101",
    website_url: "https://snakeriverplumbing.com",
    address: "1120 N Main St, Meridian, ID 83642",
    lat: 43.61,
    lng: -116.39,
    google_rating: 4.7,
    review_count: 127,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    first_seen_at: null,
    last_refreshed_at: null,
    places_details: DETAILS,
    ...overrides,
  };
}

function audit(overrides: Partial<Audit> = {}): Audit {
  return {
    id: "aud-1",
    workspace_id: "ws-1",
    business_id: "biz-1",
    website_url: "https://snakeriverplumbing.com",
    ps_performance: 90,
    ps_mobile_performance: 85,
    ps_accessibility: 90,
    ps_seo: 90,
    ps_best_practices: 90,
    ps_lcp_ms: 1800,
    ps_cls: 0.02,
    http_status: 200,
    ssl_valid: true,
    response_ms: 300,
    platform: "custom",
    copyright_year: 2026,
    has_phone: true,
    has_form: true,
    has_booking: false,
    has_chat: false,
    has_viewport_meta: true,
    has_schema_markup: true,
    gbp_photo_count: 2,
    gbp_review_velocity: null,
    has_crux_data: true,
    screenshot_desktop_url: null,
    screenshot_mobile_url: null,
    website_health_score: 92,
    star_grade: 5,
    sellability_score: 54,
    score_breakdown: {
      v15_agents: {
        seo: { h1s: ["Meridian plumbing you can count on", "Water heater repair"] },
        conversion: {
          cta_candidates: ["Get a free estimate"],
          booking_url: null,
          visible_phone: "(208) 555-0101",
          has_tel_link: true,
        },
      },
    },
    issues: [{ severity: "medium", label: "No online booking", detail: "No booking link found" }],
    analyst_output: null,
    builder_brief_md: null,
    sales_summary: null,
    status: "completed",
    error_message: null,
    created_at: "2026-10-01T00:00:00.000Z",
    completed_at: "2026-10-01T00:05:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-10-03T12:00:00.000Z");

describe("deterministic pieces", () => {
  it("review quotes: rating desc, then length desc, skipping < 40 chars, max 5", () => {
    const b = business({
      places_details: {
        reviews: [
          { rating: 4, text: { text: "Good work on the repipe, a little slow to send the invoice." } },
          { rating: 5, text: { text: "Short but five stars." } }, // < 40 chars → skipped
          { rating: 5, text: { text: "Honest plumbers. They explained every option before doing the work." } },
          { rating: 5, text: { text: "Showed up on time and fixed our water heater the same day. Fair price, no upsell." }, authorAttribution: { displayName: "Dana R." } },
          { rating: 3, text: { text: "Fine. Did the job, nothing special, fair enough pricing overall." } },
          { rating: 5, text: { text: "Absolutely fantastic service from start to finish, highly recommend them." } },
          { rating: 5, originalText: { text: "Quick response, clean work, fair price — would hire again without hesitation." } },
        ],
      },
    });
    const quotes = pickReviewQuotes(b);
    expect(quotes).toHaveLength(5);
    expect(quotes.map((q) => q.rating)).toEqual([5, 5, 5, 5, 4]);
    expect(quotes[0]?.text).toMatch(/^Showed up on time/); // longest 5★
    expect(quotes[0]?.author).toBe("Dana R.");
    expect(quotes[1]).not.toHaveProperty("author");
    expect(quotes.some((q) => q.text === "Short but five stars.")).toBe(false);
    expect(quotes[4]?.text).toMatch(/^Good work on the repipe/);
  });

  it("verbatim guard rejects a paraphrased quote and accepts the original", () => {
    const texts = ["Showed up on time and fixed our water heater the same day. Fair price, no upsell."];
    expect(quoteIsVerbatim("fixed our water heater the same day. Fair price", texts)).toBe(true);
    expect(quoteIsVerbatim("Fixed our water heater quickly at a fair price", texts)).toBe(false);
    expect(quoteIsVerbatim("", texts)).toBe(false);
  });

  it("CTA priority: booking_url → tel: → cta_candidates[0] → form", () => {
    const b = business();
    const withBooking = audit({
      score_breakdown: { v15_agents: { conversion: { booking_url: "https://book.example.com/x", cta_candidates: ["Call"] } } },
    });
    expect(pickPrimaryCta(b, withBooking)).toEqual({
      label: "Book online",
      kind: "booking",
      href: "https://book.example.com/x",
    });
    expect(pickPrimaryCta(b, audit())).toEqual({
      label: "Call (208) 555-0101",
      kind: "phone",
      href: "tel:2085550101",
    });
    const noPhone = business({ phone: null });
    const ctaOnly = audit({
      score_breakdown: { v15_agents: { conversion: { cta_candidates: ["  Get a free estimate "], visible_phone: null } } },
    });
    expect(pickPrimaryCta(noPhone, ctaOnly)).toEqual({
      label: "Get a free estimate",
      kind: "other",
      href: "https://snakeriverplumbing.com",
    });
    const nothing = audit({ score_breakdown: { v15_agents: {} } });
    expect(pickPrimaryCta(noPhone, nothing)).toEqual({
      label: "Request a quote",
      kind: "form",
      href: "https://snakeriverplumbing.com/#contact",
    });
  });

  it("hours: weekdayDescriptions incl. a Closed day → HH:MM, Sunday first", () => {
    const hours = normalizeHours(DETAILS);
    expect(hours).toHaveLength(7);
    expect(hours?.[0]).toEqual({ day: "Sunday", open: null, close: null });
    expect(hours?.[1]).toEqual({ day: "Monday", open: "07:00", close: "18:00" });
    expect(hours?.[6]).toEqual({ day: "Saturday", open: "08:00", close: "14:00" });
  });

  it("hours: structured periods win; missing days are closed; no hours → null", () => {
    const periods = normalizeHours({
      regularOpeningHours: {
        periods: [
          { open: { day: 1, hour: 9, minute: 30 }, close: { day: 1, hour: 17, minute: 0 } },
          { open: { day: 1, hour: 18, minute: 0 }, close: { day: 1, hour: 20, minute: 0 } }, // split shift
          { open: { day: 5, hour: 8 }, close: { day: 5, hour: 12 } },
        ],
        weekdayDescriptions: ["Monday: nonsense that must be ignored"],
      },
    });
    expect(periods?.[1]).toEqual({ day: "Monday", open: "09:30", close: "17:00" });
    expect(periods?.[5]).toEqual({ day: "Friday", open: "08:00", close: "12:00" });
    expect(periods?.[2]).toEqual({ day: "Tuesday", open: null, close: null });
    expect(normalizeHours(null)).toBeNull();
    expect(normalizeHours({ id: "x" })).toBeNull();
    expect(normalizeHours({ regularOpeningHours: {} })).toBeNull();
  });

  it("photo URLs go through the worker route, capped at 8", () => {
    expect(photoUrlsOf(business())).toEqual([
      "/api/places/photo/places%2Ffx-001%2Fphotos%2Ffxphoto-a?maxWidthPx=1600",
      "/api/places/photo/places%2Ffx-001%2Fphotos%2Ffxphoto-b?maxWidthPx=1600",
    ]);
    const many = business({
      places_details: { photos: Array.from({ length: 12 }, (_, i) => ({ name: `places/x/photos/p${i}` })) },
    });
    expect(photoUrlsOf(many)).toHaveLength(8);
    expect(photoUrlsOf(business({ places_details: null }))).toEqual([]);
  });

  it("site problem: analyst verdict → first issue → generic", () => {
    expect(pickSiteProblem(audit({ analyst_output: { one_line_verdict: "Fast site, no booking path." } }))).toBe(
      "Fast site, no booking path.",
    );
    expect(pickSiteProblem(audit())).toBe("No online booking — No booking link found");
    expect(pickSiteProblem(audit({ issues: [] }))).toMatch(/no measurable/);
  });

  it("template tone/services: category map and SEO H1s", () => {
    expect(templateTone("plumber")).toEqual(["dependable", "straight-talking", "fast-response"]);
    expect(templateTone("hair_salon")).toEqual(["welcoming", "stylish", "personal"]);
    expect(templateTone("mystery")).toEqual(["professional", "local", "trustworthy"]);
    expect(templateServices(business(), audit())).toEqual([
      "Meridian plumbing you can count on",
      "Water heater repair",
    ]);
    expect(templateServices(business({ category: "hair_salon" }), audit({ score_breakdown: {} }))).toEqual([
      "Hair salon services",
    ]);
  });
});

describe("buildDesignBrief", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    vi.restoreAllMocks();
  });

  it("template mode (no key): a complete, schema-valid brief with template_fallback=true", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const built = await buildDesignBrief({ business: business(), audit: audit(), siteHtmlExcerpt: null, now: NOW });
    expect(DesignBriefSchema.safeParse(built.brief).success).toBe(true);
    expect(built.brief).toMatchObject({
      business_name: "Snake River Plumbing Co",
      vertical: "plumber",
      tone_descriptors: ["dependable", "straight-talking", "fast-response"],
      services: ["Meridian plumbing you can count on", "Water heater repair"],
      phone: "(208) 555-0101",
      primary_cta: { kind: "phone" },
      generated_at: NOW.toISOString(),
      source: { audit_id: "aud-1", template_fallback: true },
    });
    expect(built.brief.review_quotes).toHaveLength(3);
    expect(built.brief.hours).toHaveLength(7);
    expect(built.brief.source.haiku_model).toBeUndefined();
    expect(built.modelUsed).toBeNull();
    expect(built.costCents).toBe(0);
  });

  it("core mode: the Haiku judgment fills tone/services and is recorded in source", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const call = vi.fn(async (_options: AiCallOptions): Promise<AiCallResult> => ({
      text: '```json\n{"tone_descriptors":["warm","expert","local"],"services":["Water heater repair","Drain cleaning","Repiping"]}\n```',
      modelUsed: "claude-haiku-4-5",
      tokensUsed: 420,
      costCents: 1,
      stopReason: "end_turn",
    }));
    const built = await buildDesignBrief({
      business: business(),
      audit: audit(),
      siteHtmlExcerpt: "Snake River Plumbing — water heaters, drains, repipes.",
      now: NOW,
      call,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toMatchObject({ model: "claude-haiku-4-5" });
    expect(call.mock.calls[0]![0]).not.toHaveProperty("effort");
    expect(built.brief.tone_descriptors).toEqual(["warm", "expert", "local"]);
    expect(built.brief.services).toEqual(["Water heater repair", "Drain cleaning", "Repiping"]);
    expect(built.brief.source).toEqual({
      audit_id: "aud-1",
      haiku_model: "claude-haiku-4-5",
      template_fallback: false,
    });
    expect(built.costCents).toBe(1);
  });

  it.each([
    ["the call throws", async (): Promise<AiCallResult> => { throw new Error("AI Core unreachable"); }],
    ["the model refuses", async (): Promise<AiCallResult> => ({ text: "", modelUsed: "claude-haiku-4-5", tokensUsed: 10, costCents: 1, stopReason: "refusal" })],
    ["the reply is not JSON", async (): Promise<AiCallResult> => ({ text: "Sure! Here are some tones: warm, friendly", modelUsed: "claude-haiku-4-5", tokensUsed: 30, costCents: 1, stopReason: "end_turn" })],
    ["the JSON misses the schema", async (): Promise<AiCallResult> => ({ text: '{"tone_descriptors":["only-one"],"services":[]}', modelUsed: "claude-haiku-4-5", tokensUsed: 30, costCents: 1, stopReason: "end_turn" })],
  ])("falls back to the template when %s", async (_label, impl) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const built = await buildDesignBrief({
      business: business(),
      audit: audit(),
      siteHtmlExcerpt: null,
      now: NOW,
      call: vi.fn(impl),
    });
    expect(built.brief.tone_descriptors).toEqual(["dependable", "straight-talking", "fast-response"]);
    expect(built.brief.source.template_fallback).toBe(true);
    expect(built.brief.source.haiku_model).toBeUndefined();
    expect(built.guardrailPassed).toBe(false);
    expect(built.guardrailNotes).toMatch(/template/);
    expect(DesignBriefSchema.safeParse(built.brief).success).toBe(true);
  });

  it("fails (writes nothing) when a quote would not be verbatim", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const b = business();
    // Tamper after assembly by making the guardrail see different review text.
    const brief: DesignBrief = (await buildDesignBrief({ business: b, audit: audit(), siteHtmlExcerpt: null, now: NOW })).brief;
    const verdict = designBriefGuardrail(
      { ...brief, review_quotes: [{ ...brief.review_quotes[0]!, text: "Showed up on time and fixed our heater fast." }] },
      ["Showed up on time and fixed our water heater the same day. Fair price, no upsell."],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toMatch(/not verbatim/);
    // Schema failure also fails the guardrail.
    expect(designBriefGuardrail({ ...brief, tone_descriptors: [] }, []).passed).toBe(false);
  });

  it("runDesignBrief wraps success and failure as an AgentResult", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const ok = await runDesignBrief({ business: business(), audit: audit(), siteHtmlExcerpt: null, now: NOW });
    expect(ok.status).toBe("completed");
    expect(ok.agent).toBe("design-brief");
    expect(DesignBriefSchema.safeParse(ok.output).success).toBe(true);

    const bad = await runDesignBrief({
      business: business({ name: "" }), // business_name must be non-empty
      audit: audit(),
      siteHtmlExcerpt: null,
      now: NOW,
    });
    expect(bad.status).toBe("failed");
    expect(bad.output).toBeNull();
    expect(bad.error).toMatch(/guardrail failed/);
  });

  it("embedDesignBrief appends the fenced JSON under its own H2", () => {
    const md = embedDesignBrief("# Brief\n\n## Assets\nStuff.\n", {
      ...({} as DesignBrief),
      business_name: "X",
    } as DesignBrief);
    expect(md).toMatch(/\n## Design Brief \(JSON\)\n\n```json\n\{[\s\S]*"business_name": "X"[\s\S]*\n```\n$/);
  });
});
