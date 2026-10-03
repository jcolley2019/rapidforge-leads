/**
 * RFL-06 enrichment consumers: Presence hours completeness from a raw
 * regularOpeningHours record, and Reputation's review-text path (texts
 * selected deterministically; the guardrail rejects non-verbatim quotes).
 */
import { describe, expect, it } from "vitest";
import { FIXTURE_DETAILS } from "../lib/places/fixtures";
import { makeReputationSummaryGuardrail } from "./guardrails/reputation-summary";
import { gbpPhotoCountFrom, hoursCompletenessFrom } from "./presence";
import {
  MAX_REVIEWS_FOR_THEMES,
  MAX_REVIEW_CHARS,
  reviewTextsFrom,
} from "./reputation";

describe("hoursCompletenessFrom (Presence, RFL-06)", () => {
  it("is unknown without a details record", () => {
    expect(hoursCompletenessFrom(null)).toBe("unknown");
    expect(hoursCompletenessFrom(undefined)).toBe("unknown");
  });

  it("is missing when details exist but carry no hours", () => {
    expect(hoursCompletenessFrom({ id: "x", fetchedAt: "y" })).toBe("missing");
    expect(hoursCompletenessFrom({ regularOpeningHours: {} })).toBe("missing");
  });

  it("is complete for seven weekday descriptions (a Closed day counts)", () => {
    expect(hoursCompletenessFrom(FIXTURE_DETAILS["fx-001"] as Record<string, unknown>)).toBe(
      "complete",
    );
  });

  it("is partial for fewer than seven days", () => {
    expect(hoursCompletenessFrom(FIXTURE_DETAILS["fx-002"] as Record<string, unknown>)).toBe(
      "partial",
    );
  });

  it("falls back to periods when weekdayDescriptions are absent", () => {
    const periods = (days: number[]) => ({
      regularOpeningHours: { periods: days.map((d) => ({ open: { day: d, hour: 9 } })) },
    });
    expect(hoursCompletenessFrom(periods([0, 1, 2, 3, 4, 5, 6]))).toBe("complete");
    expect(hoursCompletenessFrom(periods([1, 2, 3]))).toBe("partial");
    // Duplicate day entries (split shifts) count once.
    expect(hoursCompletenessFrom(periods([1, 1, 1]))).toBe("partial");
  });

  it("gbp_photo_count comes from details.photos", () => {
    expect(gbpPhotoCountFrom(null)).toBeNull();
    expect(gbpPhotoCountFrom({ id: "x" })).toBe(0);
    expect(gbpPhotoCountFrom(FIXTURE_DETAILS["fx-001"] as Record<string, unknown>)).toBe(2);
  });
});

describe("reviewTextsFrom (Reputation, RFL-06)", () => {
  it("is empty without details or reviews", () => {
    expect(reviewTextsFrom(null)).toEqual([]);
    expect(reviewTextsFrom({ reviews: [] })).toEqual([]);
    expect(reviewTextsFrom(FIXTURE_DETAILS["fx-002"] as Record<string, unknown>)).toEqual([]);
  });

  it("selects best-rated-then-longest, drops empty text, caps count and length", () => {
    const texts = reviewTextsFrom(FIXTURE_DETAILS["fx-001"] as Record<string, unknown>);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatchObject({ rating: 5, when: "2 months ago" });
    expect(texts[0]?.text).toMatch(/^Showed up on time/);
    expect(texts[2]?.rating).toBe(4);

    const many = {
      reviews: [
        ...Array.from({ length: 8 }, (_, i) => ({
          rating: 5,
          text: { text: `Review ${i} ${"x".repeat(600)}` },
        })),
        { rating: 5, text: { text: "   " } },
        { rating: 5 },
      ],
    };
    const capped = reviewTextsFrom(many);
    expect(capped).toHaveLength(MAX_REVIEWS_FOR_THEMES);
    for (const r of capped) expect(r.text.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS);
  });
});

describe("reputation guardrail with review text (RFL-06)", () => {
  const texts = reviewTextsFrom(FIXTURE_DETAILS["fx-001"] as Record<string, unknown>).map(
    (r) => r.text,
  );
  const guard = makeReputationSummaryGuardrail("high", texts);
  const base = { verdict: "strong" as const, volume_band: "high" as const, reasoning: "ok" };

  it("accepts a verbatim quote from the provided reviews", () => {
    expect(
      guard({ ...base, themes: [{ theme: "punctual", quote: "Showed up on time" }] }),
    ).toEqual({ passed: true, notes: null });
    // Case / punctuation differences are tolerated; wording is not.
    expect(
      guard({ ...base, themes: [{ theme: "honest", quote: "honest plumbers." }] }).passed,
    ).toBe(true);
  });

  it("rejects a quote that is not in the provided reviews", () => {
    const result = guard({
      ...base,
      themes: [{ theme: "cheap", quote: "Cheapest plumber in town" }],
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(/not verbatim/);
  });

  it("still rejects any quote when no review text was provided", () => {
    const none = makeReputationSummaryGuardrail("high", []);
    expect(none({ ...base, themes: [{ theme: "x", quote: "anything" }] }).passed).toBe(false);
    expect(none({ ...base, themes: [{ theme: "x", quote: null }] }).passed).toBe(true);
    // Legacy boolean form keeps working.
    expect(makeReputationSummaryGuardrail("high", false)({ ...base, themes: [] }).passed).toBe(true);
  });
});
