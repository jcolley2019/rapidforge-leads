import { describe, expect, it } from "vitest";
import { DESIGN_BRIEF_LIMITS, DesignBriefSchema, type DesignBrief } from "./design-brief";

function brief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  return {
    business_name: "Snake River Plumbing Co",
    vertical: "plumber",
    tone_descriptors: ["dependable", "straight-talking", "fast-response"],
    services: ["Water heater repair", "Drain cleaning"],
    review_quotes: [
      {
        text: "Showed up on time and fixed our water heater the same day. Fair price, no upsell.",
        rating: 5,
        author: "Dana R.",
      },
    ],
    photo_urls: ["/api/places/photo/places%2Ffx-001%2Fphotos%2Ffxphoto-a?maxWidthPx=1600"],
    hours: [
      { day: "Sunday", open: null, close: null },
      { day: "Monday", open: "07:00", close: "18:00" },
    ],
    phone: "(208) 555-0101",
    address: "1120 N Main St, Meridian, ID 83642",
    primary_cta: { label: "Call (208) 555-0101", kind: "phone", href: "tel:2085550101" },
    current_site_problem: "Mobile page speed is failing",
    generated_at: "2026-10-03T12:00:00.000Z",
    source: { audit_id: "aud-1", haiku_model: "claude-haiku-4-5", template_fallback: false },
    ...overrides,
  };
}

describe("DesignBriefSchema", () => {
  it("round-trips a complete brief through JSON", () => {
    const input = brief();
    const parsed = DesignBriefSchema.parse(JSON.parse(JSON.stringify(input)));
    expect(parsed).toEqual(input);
  });

  it("accepts null hours and an omitted haiku_model (template fallback)", () => {
    const parsed = DesignBriefSchema.parse(
      brief({ hours: null, source: { audit_id: "aud-1", template_fallback: true } }),
    );
    expect(parsed.hours).toBeNull();
    expect(parsed.source.haiku_model).toBeUndefined();
  });

  it.each([
    ["too few tone descriptors", brief({ tone_descriptors: ["a", "b"] })],
    ["too many tone descriptors", brief({ tone_descriptors: ["a", "b", "c", "d", "e", "f"] })],
    ["no services", brief({ services: [] })],
    ["13 services", brief({ services: Array.from({ length: 13 }, (_, i) => `s${i}`) })],
    ["6 quotes", brief({ review_quotes: Array(6).fill(brief().review_quotes[0]) })],
    ["short quote", brief({ review_quotes: [{ text: "Great plumbers", rating: 5 }] })],
    ["9 photos", brief({ photo_urls: Array(9).fill("/api/places/photo/x") })],
    ["bad hour format", brief({ hours: [{ day: "Monday", open: "7am", close: "6pm" }] })],
    ["bad weekday", brief({ hours: [{ day: "Funday" as never, open: null, close: null }] })],
    ["bad cta kind", brief({ primary_cta: { label: "x", kind: "chat" as never, href: "#" } })],
    ["empty problem", brief({ current_site_problem: "" })],
  ])("rejects %s", (_label, bad) => {
    expect(DesignBriefSchema.safeParse(bad).success).toBe(false);
  });

  it("limits are the ones the agent enforces", () => {
    expect(DESIGN_BRIEF_LIMITS).toMatchObject({
      toneMin: 3,
      toneMax: 5,
      servicesMax: 12,
      quotesMax: 5,
      quoteMinChars: 40,
      photosMax: 8,
    });
  });
});
