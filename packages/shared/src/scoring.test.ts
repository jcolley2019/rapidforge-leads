import { describe, expect, it } from "vitest";
import {
  BLOCKED_SITE_NEUTRAL_SCORE,
  BUILDER_PLATFORM_SCORE_MAX,
  DEAD_SITE_HEALTH_SCORE,
  HEALTH_WEIGHTS,
  NO_WEBSITE_SELLABILITY_SCORE,
  PLATFORM_SCORES,
  RATING_QUALITY_THRESHOLD,
  SELLABILITY_WEIGHTS,
  SPECIAL_CASE_BADGES,
  computeHealthScore,
  computeSellabilityScore,
  deriveStarGrade,
  isBuilderPlatform,
  platformScore,
  reviewCountScore,
  type HealthScoreInput,
  type SellabilityInput,
} from "./scoring";

/** A healthy, well-built site — baseline for health tests. */
function healthyInput(overrides: Partial<HealthScoreInput> = {}): HealthScoreInput {
  return {
    siteDead: false,
    psDesktopPerformance: 100,
    psMobilePerformance: 100,
    sslValid: true,
    httpsEnforced: true,
    responseMs: 500,
    hasViewportMeta: true,
    platform: "custom",
    hasVisiblePhone: true,
    hasContactForm: true,
    hasBookingLink: true,
    hasCtaAboveFold: true,
    hasClickToCall: true,
    copyrightYear: 2026,
    currentYear: 2026,
    hasRecentLastModified: true,
    hasBrokenImages: false,
    designScore: 100,
    ...overrides,
  };
}

/** A successful business with a real (audited) website — sellability baseline. */
function sellableInput(overrides: Partial<SellabilityInput> = {}): SellabilityInput {
  return {
    websiteKind: "real",
    healthScore: 40,
    reviewCount: 150,
    googleRating: 4.6,
    hasPhone: true,
    isChain: false,
    businessStatus: "OPERATIONAL",
    ...overrides,
  };
}

describe("weights integrity (PRD Section 4)", () => {
  it("health weights sum to 1", () => {
    const sum = Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("sellability weights sum to 1", () => {
    const sum = Object.values(SELLABILITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("computeHealthScore (PRD 4.1)", () => {
  it("scores a perfect site 100", () => {
    const { score, breakdown } = computeHealthScore(healthyInput());
    // platform 'custom' = 85 is the max platform subscore, so ceiling is
    // 100 - (100-85)*0.15 = 97.75 → 98
    expect(breakdown.platform).toBe(85);
    expect(score).toBe(98);
  });

  it("is deterministic — identical input, identical output", () => {
    const a = computeHealthScore(healthyInput());
    const b = computeHealthScore(healthyInput());
    expect(a).toEqual(b);
  });

  it("weights each signal per PRD 4.1", () => {
    // Kill mobile only: drop should be exactly 20% of 100.
    const full = computeHealthScore(healthyInput()).score;
    const noMobile = computeHealthScore(
      healthyInput({ psMobilePerformance: 0 }),
    ).score;
    expect(full - noMobile).toBe(20);
  });

  it("PRD 4.4 special case: dead site pins health to 10", () => {
    const { score, breakdown } = computeHealthScore(
      healthyInput({ siteDead: true }),
    );
    expect(score).toBe(DEAD_SITE_HEALTH_SCORE);
    expect(score).toBe(10);
    expect(breakdown.specialCase).toBe("dead_site");
  });

  it("dead site wins even when other signals look perfect", () => {
    const perfectButDead = computeHealthScore(
      healthyInput({ siteDead: true, psDesktopPerformance: 100 }),
    );
    expect(perfectButDead.score).toBe(10);
  });

  it("blocked site (bot protection): every term neutral 50, blocked=true", () => {
    // Even a site whose (challenge-page) signals look terrible, or that the
    // probe would call dead, scores neutral — nothing was measured.
    const { score, breakdown } = computeHealthScore(
      healthyInput({
        siteBlocked: true,
        siteDead: true,
        psDesktopPerformance: 5,
        hasVisiblePhone: false,
        hasContactForm: false,
        platform: "wix",
      }),
    );
    expect(score).toBe(BLOCKED_SITE_NEUTRAL_SCORE);
    expect(score).toBe(50);
    expect(breakdown).toEqual({
      performance: 50,
      mobile: 50,
      technical: 50,
      platform: 50,
      conversion: 50,
      freshness: 50,
      design: 50,
      specialCase: "blocked",
      blocked: true,
    });
    // Not blocked → no blocked flag at all.
    expect(computeHealthScore(healthyInput()).breakdown.blocked).toBeUndefined();
  });

  it("treats unmeasured PSI as neutral 50, not zero", () => {
    const { breakdown } = computeHealthScore(
      healthyInput({ psDesktopPerformance: null, psMobilePerformance: null }),
    );
    expect(breakdown.performance).toBe(50);
    expect(breakdown.mobile).toBe(50);
  });

  it("counts copyright year within 2 years as fresh (PRD 4.1)", () => {
    const fresh = computeHealthScore(
      healthyInput({ copyrightYear: 2024, currentYear: 2026 }),
    );
    const stale = computeHealthScore(
      healthyInput({ copyrightYear: 2023, currentYear: 2026 }),
    );
    expect(fresh.breakdown.freshness).toBeGreaterThan(stale.breakdown.freshness);
  });
});

describe("platform scoring (PRD 4.1 + 4.4)", () => {
  it("maps platforms per PRD: Wix/GoDaddy=20, Squarespace=45, WordPress=65, Webflow/custom=85", () => {
    expect(platformScore("wix")).toBe(20);
    expect(platformScore("godaddy")).toBe(20);
    expect(platformScore("squarespace")).toBe(45);
    expect(platformScore("wordpress")).toBe(65);
    expect(platformScore("webflow")).toBe(85);
    expect(platformScore("custom")).toBe(85);
  });

  it("treats null/unrecognized platforms as custom", () => {
    expect(platformScore(null)).toBe(PLATFORM_SCORES["custom"]);
    expect(platformScore("some-new-framework")).toBe(PLATFORM_SCORES["custom"]);
  });

  it("PRD 4.4 special case: builder platforms get the Builder site tag", () => {
    expect(isBuilderPlatform("wix")).toBe(true);
    expect(isBuilderPlatform("godaddy")).toBe(true);
    expect(isBuilderPlatform("squarespace")).toBe(true);
    expect(isBuilderPlatform("wordpress")).toBe(false);
    expect(isBuilderPlatform("webflow")).toBe(false);
    expect(isBuilderPlatform(null)).toBe(false);
    expect(PLATFORM_SCORES["squarespace"]).toBeLessThanOrEqual(
      BUILDER_PLATFORM_SCORE_MAX,
    );
  });
});

describe("deriveStarGrade (PRD 4.2)", () => {
  it("maps band edges exactly: >=85→5, 70–84→4, 50–69→3, 30–49→2, <30→1", () => {
    expect(deriveStarGrade(100)).toBe(5);
    expect(deriveStarGrade(85)).toBe(5);
    expect(deriveStarGrade(84)).toBe(4);
    expect(deriveStarGrade(70)).toBe(4);
    expect(deriveStarGrade(69)).toBe(3);
    expect(deriveStarGrade(50)).toBe(3);
    expect(deriveStarGrade(49)).toBe(2);
    expect(deriveStarGrade(30)).toBe(2);
    expect(deriveStarGrade(29)).toBe(1);
    expect(deriveStarGrade(0)).toBe(1);
  });

  it("clamps out-of-range input", () => {
    expect(deriveStarGrade(-5)).toBe(1);
    expect(deriveStarGrade(150)).toBe(5);
  });
});

describe("computeSellabilityScore (PRD 4.3)", () => {
  it("PRD 4.4 special case: no website → auto-95 hot lead, never audited", () => {
    const result = computeSellabilityScore(
      sellableInput({ websiteKind: "none", healthScore: null }),
    );
    expect(result.score).toBe(NO_WEBSITE_SELLABILITY_SCORE);
    expect(result.score).toBe(95);
    expect(result.breakdown.specialCase).toBe("no_website");
    expect(result.badge).toBe(SPECIAL_CASE_BADGES.noWebsite);
  });

  it("no-website auto-95 applies regardless of other signals", () => {
    const worstOtherwise = computeSellabilityScore({
      websiteKind: "none",
      healthScore: null,
      reviewCount: 0,
      googleRating: null,
      hasPhone: false,
      isChain: true,
      businessStatus: "CLOSED_PERMANENTLY",
    });
    expect(worstOtherwise.score).toBe(95);
  });

  it("social-only routes identically to no-website (CLAUDE.md 6.7)", () => {
    const result = computeSellabilityScore(
      sellableInput({ websiteKind: "social_only", healthScore: null }),
    );
    expect(result.score).toBe(95);
    expect(result.breakdown.specialCase).toBe("no_website");
  });

  it("PRD 4.4 special case: dead site (health 10) boosts sellability and gets the urgent badge", () => {
    const dead = computeSellabilityScore(
      sellableInput({ healthScore: DEAD_SITE_HEALTH_SCORE }),
    );
    const healthy = computeSellabilityScore(sellableInput({ healthScore: 90 }));
    expect(dead.score).toBeGreaterThan(healthy.score);
    expect(dead.badge).toBe(SPECIAL_CASE_BADGES.deadSite);
    expect(healthy.badge).toBeNull();
    // inverted health: 100 - 10 = 90 at 40% weight
    expect(dead.breakdown.invertedHealth).toBe(90);
  });

  it("blocked site never gets the dead-site badge", () => {
    const blocked = computeSellabilityScore(
      sellableInput({ healthScore: BLOCKED_SITE_NEUTRAL_SCORE, siteBlocked: true }),
    );
    expect(blocked.badge).toBeNull();
    expect(blocked.breakdown.invertedHealth).toBe(50);
    // The guard holds even if a caller passed the dead-site health value.
    const guarded = computeSellabilityScore(
      sellableInput({ healthScore: DEAD_SITE_HEALTH_SCORE, siteBlocked: true }),
    );
    expect(guarded.badge).toBeNull();
  });

  it("computes the weighted blend for a strong lead", () => {
    // health 40 → inverted 60*0.4=24; reviews 150→100*0.2=20;
    // rating 4.6→100*0.15=15; phone 100*0.1=10; not chain 100*0.1=10;
    // operational 100*0.05=5 → 84
    const result = computeSellabilityScore(sellableInput());
    expect(result.score).toBe(84);
  });

  it("bands review counts per PRD 4.3", () => {
    expect(reviewCountScore(0)).toBe(20);
    expect(reviewCountScore(4)).toBe(20);
    expect(reviewCountScore(5)).toBe(50);
    expect(reviewCountScore(19)).toBe(50);
    expect(reviewCountScore(20)).toBe(80);
    expect(reviewCountScore(99)).toBe(80);
    expect(reviewCountScore(100)).toBe(100);
    expect(reviewCountScore(null)).toBe(20);
  });

  it("applies the 3.8 rating-quality threshold", () => {
    const above = computeSellabilityScore(
      sellableInput({ googleRating: RATING_QUALITY_THRESHOLD }),
    );
    const below = computeSellabilityScore(sellableInput({ googleRating: 3.7 }));
    const none = computeSellabilityScore(sellableInput({ googleRating: null }));
    expect(above.breakdown.ratingQuality).toBe(100);
    expect(below.breakdown.ratingQuality).toBe(0);
    expect(none.breakdown.ratingQuality).toBe(0);
  });

  it("penalizes chains and non-operational businesses", () => {
    const chain = computeSellabilityScore(sellableInput({ isChain: true }));
    const closed = computeSellabilityScore(
      sellableInput({ businessStatus: "CLOSED_TEMPORARILY" }),
    );
    const base = computeSellabilityScore(sellableInput());
    expect(base.score - chain.score).toBe(10); // notChain weight 0.10
    expect(base.score - closed.score).toBe(5); // operational weight 0.05
  });
});
