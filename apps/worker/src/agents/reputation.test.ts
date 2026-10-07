import { describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import { makeReputationSummaryGuardrail } from "./guardrails/reputation-summary";
import type { ReputationSummary } from "./prompts/reputation";
import {
  buildTemplateSummary,
  computeReviewVelocityPerMonth,
  readPreviousSnapshot,
  runReputation,
  templateVerdictFor,
  volumeBandFor,
} from "./reputation";

const NOW = new Date("2026-07-05T12:00:00Z");

function businessWith(
  rating: number | null,
  reviewCount: number | null,
): Business {
  return {
    id: "biz-1",
    workspace_id: "ws-1",
    google_place_id: "fx-test",
    name: "Test Business",
    phone: null,
    website_url: "https://example.com/",
    address: "1 Main St",
    lat: null,
    lng: null,
    google_rating: rating,
    review_count: reviewCount,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    last_refreshed_at: null,
    first_seen_at: NOW.toISOString(),
  } as Business;
}

function previousAuditWith(
  reviewCountAtAudit: number,
  completedAt: string,
): Audit {
  return {
    id: "audit-prev",
    completed_at: completedAt,
    score_breakdown: {
      v15_agents: { reputation: { review_count_at_audit: reviewCountAtAudit } },
    },
  } as unknown as Audit;
}

describe("volumeBandFor (PRD 6.9 — 'high' requires >=50)", () => {
  it("bands review counts deterministically", () => {
    expect(volumeBandFor(null)).toBe("none");
    expect(volumeBandFor(0)).toBe("none");
    expect(volumeBandFor(1)).toBe("low");
    expect(volumeBandFor(9)).toBe("low");
    expect(volumeBandFor(10)).toBe("moderate");
    expect(volumeBandFor(49)).toBe("moderate"); // 49 reviews is NOT high
    expect(volumeBandFor(50)).toBe("high");
    expect(volumeBandFor(200)).toBe("very_high");
  });
});

describe("reputation guardrails (PRD 6.9)", () => {
  const summaryWith = (patch: Partial<ReputationSummary>): ReputationSummary => ({
    verdict: "solid",
    volume_band: "moderate",
    themes: [],
    reasoning: "Grounded in the measured signals.",
    ...patch,
  });

  it("rejects volume 'high' under 50 reviews (band mismatch)", () => {
    const guardrail = makeReputationSummaryGuardrail(volumeBandFor(49), false);
    const verdict = guardrail(summaryWith({ volume_band: "high" }));
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("'high'");
  });

  it("rejects quotes when no review text was provided (anti-invention)", () => {
    const guardrail = makeReputationSummaryGuardrail("moderate", false);
    const verdict = guardrail(
      summaryWith({
        themes: [{ theme: "friendly staff", quote: "they were so friendly" }],
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("never provided");
  });

  it("accepts a 15-word quote and rejects a 16-word one (RFL.FIX.3f: 15 words or fewer)", () => {
    const fifteen =
      "was willing to work us in even though he was already booked up that week";
    const sixteen = `${fifteen} too`;
    const guardrail = makeReputationSummaryGuardrail("moderate", [fifteen, sixteen]);
    expect(fifteen.split(" ")).toHaveLength(15);
    expect(
      guardrail(summaryWith({ themes: [{ theme: "flexible", quote: fifteen }] })).passed,
    ).toBe(true);
    const verdict = guardrail(summaryWith({ themes: [{ theme: "flexible", quote: sixteen }] }));
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("too long");
  });

  it("rejects a verdict two bands from the rating, allows one band of judgment", () => {
    const guardrail = makeReputationSummaryGuardrail("high", false, 4.9);
    const weak = guardrail(summaryWith({ volume_band: "high", verdict: "weak" }));
    expect(weak.passed).toBe(false);
    expect(weak.notes).toContain("contradicts the 4.9 rating");
    expect(guardrail(summaryWith({ volume_band: "high", verdict: "mixed" })).passed).toBe(false);
    expect(guardrail(summaryWith({ volume_band: "high", verdict: "solid" })).passed).toBe(true);
    expect(guardrail(summaryWith({ volume_band: "high", verdict: "strong" })).passed).toBe(true);
    // 'unknown' for a measured 4.9 is a dodge, not a band.
    expect(guardrail(summaryWith({ volume_band: "high", verdict: "unknown" })).passed).toBe(false);
    // No rating → no verdict check (legacy two-argument form unchanged).
    expect(
      makeReputationSummaryGuardrail("high", false)(
        summaryWith({ volume_band: "high", verdict: "weak" }),
      ).passed,
    ).toBe(true);
  });

  it("rejects overlong quotes (>15 words) even with review text", () => {
    const guardrail = makeReputationSummaryGuardrail("moderate", true);
    const verdict = guardrail(
      summaryWith({
        themes: [
          {
            theme: "slow service",
            quote:
              "the technician arrived four hours late and then charged us for the full visit anyway which felt wrong",
          },
        ],
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.notes).toContain("too long");
  });

  it("passes an honest summary (empty themes, matching band)", () => {
    const guardrail = makeReputationSummaryGuardrail("moderate", false);
    expect(guardrail(summaryWith({})).passed).toBe(true);
  });
});

describe("review velocity across audits", () => {
  it("is unknown without a baseline (first audit)", () => {
    expect(computeReviewVelocityPerMonth(120, null, NOW)).toEqual({
      velocity: null,
      monthsSincePrevious: null,
    });
  });

  it("computes reviews/month against the previous snapshot", () => {
    // 2 months ago at 100 reviews, now 112 → ~6/month.
    const twoMonthsAgo = new Date(
      NOW.getTime() - 2 * 30.44 * 86_400_000,
    ).toISOString();
    const { velocity, monthsSincePrevious } = computeReviewVelocityPerMonth(
      112,
      { reviewCount: 100, completedAt: twoMonthsAgo },
      NOW,
    );
    expect(velocity).toBe(6);
    expect(monthsSincePrevious).toBe(2);
  });

  it("refuses to extrapolate from a tiny window (<~1 week)", () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    const { velocity } = computeReviewVelocityPerMonth(
      105,
      { reviewCount: 100, completedAt: twoDaysAgo },
      NOW,
    );
    expect(velocity).toBeNull();
  });

  it("reads the snapshot only from a completed previous audit", () => {
    expect(readPreviousSnapshot(null)).toBeNull();
    expect(
      readPreviousSnapshot({
        id: "x",
        completed_at: null,
        score_breakdown: null,
      } as unknown as Audit),
    ).toBeNull();
    expect(
      readPreviousSnapshot(previousAuditWith(80, "2026-05-01T00:00:00Z")),
    ).toEqual({ reviewCount: 80, completedAt: "2026-05-01T00:00:00Z" });
  });
});

describe("runReputation (template mode)", () => {
  it("produces a deterministic google-first output with the yelp stub", async () => {
    const result = await runReputation({
      business: businessWith(4.7, 120),
      previousAudit: previousAuditWith(
        100,
        new Date(NOW.getTime() - 2 * 30.44 * 86_400_000).toISOString(),
      ),
      now: NOW,
    });
    expect(result.status).toBe("completed");
    expect(result.modelUsed).toBeNull();
    expect(result.guardrailPassed).toBe(true);
    const output = result.output!;
    expect(output.volume_band).toBe("high"); // 120 reviews: high, not very_high
    expect(output.summary.verdict).toBe("strong");
    expect(output.review_velocity_per_month).toBe(10);
    expect(output.review_count_at_audit).toBe(120);
    expect(output.yelp_rating).toBeNull();
    expect(output.rating_divergence).toBeNull();
    expect(output.summary.themes).toEqual([]);
  });

  it("bands verdicts deterministically — rating decides, volume never demotes (RFL.FIX.3f)", () => {
    expect(templateVerdictFor(null, 0)).toBe("unknown");
    expect(templateVerdictFor(null, 30)).toBe("unknown");
    expect(templateVerdictFor(4.8, 200)).toBe("strong");
    expect(templateVerdictFor(4.3, 30)).toBe("solid");
    expect(templateVerdictFor(3.9, 30)).toBe("mixed");
    expect(templateVerdictFor(2.8, 30)).toBe("weak");
    // Boundaries.
    expect(templateVerdictFor(4.6, 1)).toBe("strong");
    expect(templateVerdictFor(4.2, 1)).toBe("solid");
    expect(templateVerdictFor(3.5, 1)).toBe("mixed");
    expect(templateVerdictFor(3.4, 1)).toBe("weak");
    // Zero reviews: nothing to judge even with a rating on the row.
    expect(templateVerdictFor(5, 0)).toBe("unknown");
  });

  it("template verdict for ≥4.8★ with <20 reviews is not 'mixed' (Accurbore 5.0★/7)", () => {
    expect(templateVerdictFor(5.0, 7)).toBe("strong");
    expect(templateVerdictFor(4.8, 19)).toBe("strong");
    const summary = buildTemplateSummary(5.0, 7, volumeBandFor(7), null, 5);
    expect(summary.verdict).toBe("strong");
    expect(summary.reasoning).toContain("strong rating");
    expect(summary.reasoning).toContain("low confidence");
    expect(summary.reasoning).toContain("5 review texts on file");
    expect(summary.reasoning).not.toContain("not collected");
    expect(summary.themes).toEqual([]);
  });

  it("keeps the 'not collected' sentence only when no review text was on file", () => {
    const summary = buildTemplateSummary(4.3, 30, "moderate", 2, 0);
    expect(summary.reasoning).toContain("not collected in v1");
    expect(summary.reasoning).toContain("moderate confidence");
  });

  it("runReputation template with 0 reviews: verdict unknown, band none, guardrail passes", async () => {
    const result = await runReputation({
      business: businessWith(null, 0),
      previousAudit: null,
      now: NOW,
    });
    expect(result.status).toBe("completed");
    expect(result.guardrailPassed).toBe(true);
    expect(result.output!.volume_band).toBe("none");
    expect(result.output!.summary.verdict).toBe("unknown");
  });
});
