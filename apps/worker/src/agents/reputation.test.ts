import { describe, expect, it } from "vitest";
import type { Audit, Business } from "@rapidforge/shared";
import { makeReputationSummaryGuardrail } from "./guardrails/reputation-summary";
import type { ReputationSummary } from "./prompts/reputation";
import {
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

  it("rejects overlong quotes (>=15 words) even with review text", () => {
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

  it("bands verdicts deterministically", () => {
    expect(templateVerdictFor(null, 0)).toBe("unknown");
    expect(templateVerdictFor(4.8, 200)).toBe("strong");
    expect(templateVerdictFor(4.3, 30)).toBe("solid");
    expect(templateVerdictFor(3.9, 30)).toBe("mixed");
    expect(templateVerdictFor(2.8, 30)).toBe("weak");
  });
});
