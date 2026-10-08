import { describe, expect, it } from "vitest";
import {
  BLOCKED_SITE_NEUTRAL_SCORE,
  BUILDER_PLATFORM_SCORE_MAX,
  CHAIN_SELLABILITY_CAP,
  DEAD_SITE_HEALTH_SCORE,
  HEALTHY_SITE_MOBILE_MIN,
  HEALTHY_SITE_SELLABILITY_CAP,
  PROVISIONAL_SELLABILITY_CAP,
  UNKNOWN_REPUTATION_SCORE,
  HEALTH_WEIGHTS,
  NO_WEBSITE_SELLABILITY_SCORE,
  PLATFORM_SCORES,
  RATING_QUALITY_THRESHOLD,
  SELLABILITY_WEIGHTS,
  SPECIAL_CASE_BADGES,
  UNHEALTHY_SITE_STAR_CAP,
  computeHealthScore,
  computeSellabilityScore,
  deriveStarGrade,
  isBuilderPlatform,
  isHealthySite,
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

  it("weights each signal per PRD 4.1 (RFL.FIX.3i: mobile 0.25, desktop 0.20)", () => {
    // Kill mobile only: drop should be exactly 25% of 100.
    const full = computeHealthScore(healthyInput()).score;
    const noMobile = computeHealthScore(
      healthyInput({ psMobilePerformance: 0 }),
    ).score;
    expect(full - noMobile).toBe(25);
    // Kill desktop only: 20% of 100.
    const noDesktop = computeHealthScore(
      healthyInput({ psDesktopPerformance: 0 }),
    ).score;
    expect(full - noDesktop).toBe(20);
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

  it("RFL.FIX.3d: legacy_static scores 30 and drags health like a builder; a modern hand-coded site is still custom=85", () => {
    expect(PLATFORM_SCORES["legacy_static"]).toBe(30);
    expect(platformScore("legacy_static")).toBe(30);
    // Only the platform term moves — every other weight and term is untouched.
    const legacy = computeHealthScore(healthyInput({ platform: "legacy_static" }));
    const modern = computeHealthScore(healthyInput({ platform: "custom" }));
    expect(legacy.breakdown.platform).toBe(30);
    expect(modern.breakdown.platform).toBe(85);
    expect(modern.score - legacy.score).toBe(Math.round((85 - 30) * HEALTH_WEIGHTS.platform));
    for (const term of ["performance", "mobile", "technical", "conversion", "freshness", "design"] as const) {
      expect(legacy.breakdown[term]).toBe(modern.breakdown[term]);
    }
    // A fresh, responsive, hand-coded page never reads as legacy here: the
    // class is assigned upstream (worker Scorer) only when all three legacy
    // conditions hold; scoring.ts itself still maps anything else to custom.
    expect(platformScore("custom")).toBe(85);
    expect(platformScore("hand-coded")).toBe(85);
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

  it("RFL.FIX.3i.1: failing the healthy-site rule caps the grade at 3★; null mobile keeps the bands", () => {
    expect(UNHEALTHY_SITE_STAR_CAP).toBe(3);
    expect(deriveStarGrade(70, 50)).toBe(3);
    expect(deriveStarGrade(95, 59)).toBe(3);
    expect(deriveStarGrade(70, 60)).toBe(4);
    expect(deriveStarGrade(85, 60)).toBe(5);
    expect(deriveStarGrade(70, null)).toBe(4);
    expect(deriveStarGrade(85)).toBe(5);
    // Under 70 the bands already sit at ≤ 3★ — the rule never moves them.
    expect(deriveStarGrade(69, 10)).toBe(3);
    expect(deriveStarGrade(49, 10)).toBe(2);
    expect(deriveStarGrade(10, 99)).toBe(1);
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

  it("computes the weighted blend for a strong lead (RFL-05 weights)", () => {
    // health 40 → inverted 60*0.5=30; reviews 150→100*0.15=15;
    // rating 4.6→100*0.1=10; phone 100*0.1=10; not chain 100*0.1=10;
    // operational 100*0.05=5 → 80
    const result = computeSellabilityScore(sellableInput());
    expect(result.score).toBe(80);
    expect(result.breakdown.capped).toBeUndefined();
    expect(result.breakdown.reputationUnknown).toBeUndefined();
  });

  it("weights: invertedHealth 0.50, reviewCount 0.15, ratingQuality 0.10, phone 0.10, notChain 0.10, operational 0.05", () => {
    expect(SELLABILITY_WEIGHTS).toEqual({
      invertedHealth: 0.5,
      reviewCount: 0.15,
      ratingQuality: 0.1,
      phoneReachable: 0.1,
      notChain: 0.1,
      operational: 0.05,
    });
  });

  it("needs-rebuild cap: health ≥ 70 caps sellability at 55 with capped='healthy_site'", () => {
    // A perfect business with a merely-good site: blend would be
    // 30*0.5 + 15 + 10 + 10 + 10 + 5 = 65 → capped.
    const good = computeSellabilityScore(sellableInput({ healthScore: 70 }));
    expect(good.score).toBe(HEALTHY_SITE_SELLABILITY_CAP);
    expect(good.score).toBe(55);
    expect(good.breakdown.capped).toBe("healthy_site");
    // Just under the threshold: no cap.
    const under = computeSellabilityScore(sellableInput({ healthScore: 69 }));
    expect(under.score).toBe(66);
    expect(under.breakdown.capped).toBeUndefined();
    // A healthy site whose blend is already under 55 keeps its own score.
    const weak = computeSellabilityScore(
      sellableInput({ healthScore: 95, reviewCount: 2, googleRating: 3.0, hasPhone: false }),
    );
    expect(weak.score).toBeLessThan(55);
    expect(weak.breakdown.capped).toBe("healthy_site");
  });

  it("RFL.FIX.3i.1: the healthy_site cap also needs mobile ≥ 60; unmeasured mobile keeps the health-only rule", () => {
    expect(HEALTHY_SITE_MOBILE_MIN).toBe(60);
    // Same blend as the health-70 case above (65), mobile failing → uncapped.
    for (const mobilePerformance of [48, 50, 59]) {
      const failingMobile = computeSellabilityScore(
        sellableInput({ healthScore: 70, mobilePerformance }),
      );
      expect(failingMobile.score).toBe(65);
      expect(failingMobile.breakdown.capped).toBeUndefined();
    }
    const atMin = computeSellabilityScore(
      sellableInput({ healthScore: 70, mobilePerformance: 60 }),
    );
    expect(atMin.score).toBe(55);
    expect(atMin.breakdown.capped).toBe("healthy_site");
    for (const mobilePerformance of [null, undefined]) {
      const unmeasured = computeSellabilityScore(
        sellableInput({ healthScore: 70, mobilePerformance }),
      );
      expect(unmeasured.breakdown.capped).toBe("healthy_site");
    }
    // The chain cap still applies whatever mobile scored.
    const chain = computeSellabilityScore(
      sellableInput({ healthScore: 70, mobilePerformance: 20, isChain: true }),
    );
    expect(chain.breakdown.capped).toBe("chain");
    expect(isHealthySite(69, 99)).toBe(false);
    expect(isHealthySite(70, 50)).toBe(false);
    expect(isHealthySite(70, 59)).toBe(false);
    expect(isHealthySite(70, 60)).toBe(true);
    expect(isHealthySite(70, null)).toBe(true);
  });

  it("provisional (blocked) audits cap at 55 with capped='provisional'", () => {
    // Blocked → health neutral 50 → blend 25 + 15 + 10 + 10 + 10 + 5 = 75.
    const blocked = computeSellabilityScore(
      sellableInput({ healthScore: BLOCKED_SITE_NEUTRAL_SCORE, siteBlocked: true }),
    );
    expect(blocked.score).toBe(PROVISIONAL_SELLABILITY_CAP);
    expect(blocked.score).toBe(55);
    expect(blocked.breakdown.capped).toBe("provisional");
    // Unknown health can never rank above measured-bad health.
    const measuredBad = computeSellabilityScore(sellableInput({ healthScore: 40 }));
    expect(measuredBad.score).toBeGreaterThan(blocked.score);
  });

  it("lowest cap wins: chain + healthy site → 40, capped='chain', chain=true", () => {
    const both = computeSellabilityScore(
      sellableInput({ isChain: true, healthScore: 80 }),
    );
    expect(both.score).toBe(CHAIN_SELLABILITY_CAP);
    expect(both.breakdown.capped).toBe("chain");
    expect(both.breakdown.chain).toBe(true);
    const chainBlocked = computeSellabilityScore(
      sellableInput({ isChain: true, healthScore: 50, siteBlocked: true }),
    );
    expect(chainBlocked.score).toBe(40);
    expect(chainBlocked.breakdown.capped).toBe("chain");
    // Chain with a bad site: still the chain cap, still flagged.
    const chainBad = computeSellabilityScore(sellableInput({ isChain: true, healthScore: 30 }));
    expect(chainBad.breakdown.capped).toBe("chain");
    // No-website special case: no cap of any kind (CLAUDE.md 6.7).
    const noSite = computeSellabilityScore(
      sellableInput({ websiteKind: "none", healthScore: null, isChain: true }),
    );
    expect(noSite.score).toBe(95);
    expect(noSite.breakdown.capped).toBeUndefined();
  });

  it("null reputation is unknown, not zero: neutral 50 per term + reputationUnknown (finding 8)", () => {
    const unknownBoth = computeSellabilityScore(
      sellableInput({ reviewCount: null, googleRating: null }),
    );
    expect(unknownBoth.breakdown.reviewCount).toBe(UNKNOWN_REPUTATION_SCORE);
    expect(unknownBoth.breakdown.ratingQuality).toBe(UNKNOWN_REPUTATION_SCORE);
    expect(unknownBoth.breakdown.reputationUnknown).toBe(true);
    // 30 + 7.5 + 5 + 10 + 10 + 5 = 67.5 → 68
    expect(unknownBoth.score).toBe(68);
    // Zero reviews / low rating are MEASURED and still score low.
    const measuredZero = computeSellabilityScore(
      sellableInput({ reviewCount: 0, googleRating: 2.0 }),
    );
    expect(measuredZero.breakdown.reviewCount).toBe(20);
    expect(measuredZero.breakdown.ratingQuality).toBe(0);
    expect(measuredZero.breakdown.reputationUnknown).toBeUndefined();
    // Blum-style: unknown reputation + health 55 must beat a chain at 40.
    const blum = computeSellabilityScore(
      sellableInput({ reviewCount: null, googleRating: null, healthScore: 55 }),
    );
    expect(blum.score).toBeGreaterThan(CHAIN_SELLABILITY_CAP);
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
    expect(none.breakdown.ratingQuality).toBe(UNKNOWN_REPUTATION_SCORE); // unknown ≠ bad
  });

  it("penalizes chains and non-operational businesses", () => {
    const chain = computeSellabilityScore(sellableInput({ isChain: true }));
    const closed = computeSellabilityScore(
      sellableInput({ businessStatus: "CLOSED_TEMPORARILY" }),
    );
    const base = computeSellabilityScore(sellableInput());
    expect(chain.breakdown.notChain).toBe(0); // notChain weight 0.10 still applies
    expect(base.score - closed.score).toBe(5); // operational weight 0.05
  });

  it("caps a chain's final score at 40 and marks breakdown.chain (RFL-04)", () => {
    // Blend would be 84 − 10 (notChain) = 74 → capped.
    const chain = computeSellabilityScore(sellableInput({ isChain: true }));
    expect(chain.score).toBe(CHAIN_SELLABILITY_CAP);
    expect(chain.score).toBe(40);
    expect(chain.breakdown.chain).toBe(true);
    // A chain whose blend is already under the cap keeps its own score.
    const weakChain = computeSellabilityScore(
      sellableInput({
        isChain: true,
        healthScore: 95,
        reviewCount: 2,
        googleRating: 3.1,
        hasPhone: false,
      }),
    );
    expect(weakChain.score).toBeLessThan(40);
    expect(weakChain.breakdown.chain).toBe(true);
    // The no-website special case is routing law (CLAUDE.md 6.7): not capped.
    const noSiteChain = computeSellabilityScore(
      sellableInput({ isChain: true, websiteKind: "none", healthScore: null }),
    );
    expect(noSiteChain.score).toBe(NO_WEBSITE_SELLABILITY_SCORE);
    expect(noSiteChain.breakdown.chain).toBeUndefined();
    // Independents never carry the flag.
    expect(computeSellabilityScore(sellableInput()).breakdown.chain).toBeUndefined();
  });
});
