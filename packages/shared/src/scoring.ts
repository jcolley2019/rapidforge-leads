/**
 * RapidForge deterministic scoring — PRD Section 4.
 *
 * Scores are deterministic math. LLMs NEVER assign Health, star, or
 * Sellability scores (CLAUDE.md 4.2). All weights/thresholds live here as
 * exported constants — Joey tunes these by hand after real audits
 * (CLAUDE.md Section 3: protected once tuning starts).
 */

// ---------------------------------------------------------------------------
// Website Health Score (PRD 4.1) — 0–100, higher = better site
// ---------------------------------------------------------------------------

/** Signal weights. Must sum to 1. */
export const HEALTH_WEIGHTS = {
  /**
   * PSI desktop performance score. RFL.FIX.3i (V3, approved by Joey): 0.20,
   * down from 0.25. With PSI_DESKTOP=true a fast desktop run was carrying
   * pages whose mobile run fails (Landers: desktop 94, mobile 48 → 4★).
   * With desktop off this slot still holds the mobile result.
   */
  performance: 0.2,
  /**
   * PSI mobile performance score. RFL.FIX.3i (V3): 0.25, up from 0.20, so
   * mobile now outweighs desktop (70%+ of local searches are mobile).
   */
  mobile: 0.25,
  /** SSL valid, HTTPS enforced, response <2s, viewport meta present */
  technical: 0.1,
  /** Platform quality (builder platforms score low) */
  platform: 0.15,
  /** Visible tel: phone, contact form, booking link, CTA above fold, click-to-call */
  conversion: 0.15,
  /** Copyright year within 2 years, recent Last-Modified, no broken images */
  freshness: 0.1,
  /** Vision modernity score (stub 50 in v1; real Design agent in v1.5) */
  design: 0.05,
} as const;

/** Platform → subscore (PRD 4.1). Unrecognized/null platforms score as custom. */
export const PLATFORM_SCORES: Readonly<Record<string, number>> = {
  wix: 20,
  godaddy: 20,
  squarespace: 45,
  wordpress: 65,
  webflow: 85,
  custom: 85,
  /**
   * RFL.FIX.3d (approved by Joey): a hand-coded page with no viewport meta,
   * legacy pre-CSS markup AND a Last-Modified older than 730 days (or
   * absent). Classified by the worker's Scorer; everything else hand-coded
   * stays `custom`.
   */
  legacy_static: 30,
};

/** Platforms at or below this subscore get the "Builder site" tag (PRD 4.4). */
export const BUILDER_PLATFORM_SCORE_MAX = 45;

/** Fallback when platform is null/unrecognized — treated as custom. */
export const UNKNOWN_PLATFORM_SCORE = PLATFORM_SCORES["custom"] ?? 85;

/** Technical check: response time must be under this (PRD 4.1). */
export const RESPONSE_TIME_THRESHOLD_MS = 2000;

/** Freshness check: copyright year within this many years of now (PRD 4.1). */
export const COPYRIGHT_RECENT_YEARS = 2;

/** Design signal stub until the v1.5 Design agent ships (PRD 4.1). */
export const DESIGN_STUB_SCORE = 50;

/** PSI score when PSI returned nothing for a live site: neutral, not punitive. */
export const UNMEASURED_PSI_SCORE = 50;

/** Special case (PRD 4.4): site times out / errors → health is pinned here. */
export const DEAD_SITE_HEALTH_SCORE = 10;

/**
 * Blocked site (audit finding 4: WAF / bot challenge — not dead, not
 * measured): every health term is this neutral value and the audit is
 * provisional. Not a weight — the score is simply unmeasured.
 */
export const BLOCKED_SITE_NEUTRAL_SCORE = 50;

// ---------------------------------------------------------------------------
// Star grade (PRD 4.2) — derived from Health Score
// ---------------------------------------------------------------------------

/** `>=85 → 5★ · 70–84 → 4★ · 50–69 → 3★ · 30–49 → 2★ · <30 → 1★` */
export const STAR_BANDS = [
  { min: 85, stars: 5 },
  { min: 70, stars: 4 },
  { min: 50, stars: 3 },
  { min: 30, stars: 2 },
  { min: 0, stars: 1 },
] as const;

// ---------------------------------------------------------------------------
// Sellability Score (PRD 4.3) — 0–100, higher = better LEAD
// ---------------------------------------------------------------------------

/**
 * Signal weights. Must sum to 1. Retuned RFL-05 (audit finding 2, approved
 * by Joey): health is now half the score so the ranking measures "needs a
 * rebuild" more than "successful local business".
 */
export const SELLABILITY_WEIGHTS = {
  /** 100 − health score: money + pain */
  invertedHealth: 0.5,
  /** Review count bands — proxy for real revenue */
  reviewCount: 0.15,
  /** 3.8+ stars = cares about reputation → will care about website */
  ratingQuality: 0.1,
  /** Phone in Places data = reachable */
  phoneReachable: 0.1,
  /** Independents only — chains don't buy local rebuilds */
  notChain: 0.1,
  /** business_status = OPERATIONAL */
  operational: 0.05,
} as const;

/** Review count → subscore (PRD 4.3): 0–4=20, 5–19=50, 20–99=80, 100+=100. */
export const REVIEW_COUNT_BANDS = [
  { min: 100, score: 100 },
  { min: 20, score: 80 },
  { min: 5, score: 50 },
  { min: 0, score: 20 },
] as const;

/** Google rating at/above this scores 100 on rating quality, else 0 (PRD 4.3). */
export const RATING_QUALITY_THRESHOLD = 3.8;

/**
 * Null Places reputation is UNKNOWN, not zero (audit finding 8): a missing
 * rating or review count scores this neutral value on its term and the
 * audit carries an "Unverified reputation" issue (issues.ts).
 */
export const UNKNOWN_REPUTATION_SCORE = 50;

/**
 * Needs-rebuild cap (audit finding 2): a site whose health is at/above
 * HEALTHY_SITE_HEALTH_MIN and whose mobile performance is at/above
 * HEALTHY_SITE_MOBILE_MIN (isHealthySite) is not a rebuild prospect whatever
 * its reputation, so sellability is capped at HEALTHY_SITE_SELLABILITY_CAP.
 * A provisional audit (bot-blocked, health neutral) gets the same cap so
 * unknown health can never rank above measured-bad health. The chain cap
 * (40) is lower and wins when both apply. The no-website 95 special case is
 * never capped.
 */
export const HEALTHY_SITE_HEALTH_MIN = 70;
/**
 * RFL.FIX.3i (V3, approved by Joey): a failing mobile run keeps a site out
 * of the healthy cap however good its blended health, because a page that
 * fails on a phone is still a rebuild prospect. Unmeasured mobile (null)
 * leaves the rule on health alone, as before.
 */
export const HEALTHY_SITE_MOBILE_MIN = 50;
export const HEALTHY_SITE_SELLABILITY_CAP = 55;
export const PROVISIONAL_SELLABILITY_CAP = 55;

/** Special case (PRD 4.4): no website (or social-only, CLAUDE.md 6.7) → auto. */
export const NO_WEBSITE_SELLABILITY_SCORE = 95;

/**
 * Chains / franchises never buy a local rebuild (audit finding 3): a
 * business with is_chain has its FINAL blended sellability capped here.
 * The no-website / social-only special case (CLAUDE.md 6.7 routing law)
 * stays at NO_WEBSITE_SELLABILITY_SCORE. Not a weight — weights untouched.
 */
export const CHAIN_SELLABILITY_CAP = 40;

/** Badge copy for the special cases (PRD 4.4 + PRD 6.2 social-only). */
export const SPECIAL_CASE_BADGES = {
  noWebsite: "No website — easiest pitch",
  socialOnly: "Social-only presence",
  deadSite: "Site broken — urgent",
  builderSite: "Builder site",
} as const;

// ---------------------------------------------------------------------------
// Health Score computation
// ---------------------------------------------------------------------------

export interface HealthScoreInput {
  /** Site timed out / connection refused / hard error (PRD 4.4 dead site). */
  siteDead: boolean;
  /**
   * Bot protection answered instead of the site (probe "unknown"). Every
   * term is BLOCKED_SITE_NEUTRAL_SCORE and the breakdown carries
   * blocked=true. Takes precedence over siteDead.
   */
  siteBlocked?: boolean;
  /** PSI desktop performance 0–100; null = PSI returned nothing. */
  psDesktopPerformance: number | null;
  /** PSI mobile performance 0–100; null = PSI returned nothing. */
  psMobilePerformance: number | null;
  sslValid: boolean;
  httpsEnforced: boolean;
  /** Initial response time; null = unmeasured (fails the <2s check). */
  responseMs: number | null;
  hasViewportMeta: boolean;
  /** Detected platform key (see PLATFORM_SCORES); null/unknown → custom. */
  platform: string | null;
  hasVisiblePhone: boolean;
  hasContactForm: boolean;
  hasBookingLink: boolean;
  hasCtaAboveFold: boolean;
  hasClickToCall: boolean;
  /** Copyright year found in footer; null = not found (fails the check). */
  copyrightYear: number | null;
  /** Injected for purity — pass the current year at call time. */
  currentYear: number;
  hasRecentLastModified: boolean;
  hasBrokenImages: boolean;
  /** Vision modernity 0–100; null → DESIGN_STUB_SCORE until v1.5. */
  designScore: number | null;
}

export interface HealthScoreBreakdown {
  performance: number;
  mobile: number;
  technical: number;
  platform: number;
  conversion: number;
  freshness: number;
  design: number;
  specialCase: "dead_site" | "blocked" | null;
  /** Present (true) only for a blocked site — score is unmeasured. */
  blocked?: true;
}

export interface HealthScoreResult {
  /** 0–100 integer */
  score: number;
  breakdown: HealthScoreBreakdown;
}

function clamp100(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Fraction of passed checks → 0–100 subscore. */
function checksSubscore(checks: boolean[]): number {
  if (checks.length === 0) return 0;
  const passed = checks.filter(Boolean).length;
  return (passed / checks.length) * 100;
}

/** Platform key → subscore. Null or unrecognized platforms score as custom. */
export function platformScore(platform: string | null): number {
  if (!platform) return UNKNOWN_PLATFORM_SCORE;
  const key = platform.trim().toLowerCase();
  for (const [name, score] of Object.entries(PLATFORM_SCORES)) {
    if (key.includes(name)) return score;
  }
  return UNKNOWN_PLATFORM_SCORE;
}

/** True when the detected platform earns the "Builder site" tag (PRD 4.4). */
export function isBuilderPlatform(platform: string | null): boolean {
  if (!platform) return false;
  return platformScore(platform) <= BUILDER_PLATFORM_SCORE_MAX;
}

/**
 * Website Health Score (PRD 4.1) — pure, deterministic.
 *
 * Special case (PRD 4.4): `siteDead` pins the score to DEAD_SITE_HEALTH_SCORE
 * ("Site broken — urgent"). The no-website case never reaches this function —
 * those businesses skip the audit pipeline entirely and health stays null.
 */
export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  if (input.siteBlocked === true) {
    const n = BLOCKED_SITE_NEUTRAL_SCORE;
    return {
      score: n,
      breakdown: {
        performance: n,
        mobile: n,
        technical: n,
        platform: n,
        conversion: n,
        freshness: n,
        design: n,
        specialCase: "blocked",
        blocked: true,
      },
    };
  }
  if (input.siteDead) {
    return {
      score: DEAD_SITE_HEALTH_SCORE,
      breakdown: {
        performance: 0,
        mobile: 0,
        technical: 0,
        platform: 0,
        conversion: 0,
        freshness: 0,
        design: 0,
        specialCase: "dead_site",
      },
    };
  }

  const performance = clamp100(
    input.psDesktopPerformance ?? UNMEASURED_PSI_SCORE,
  );
  const mobile = clamp100(input.psMobilePerformance ?? UNMEASURED_PSI_SCORE);
  const technical = checksSubscore([
    input.sslValid,
    input.httpsEnforced,
    input.responseMs !== null && input.responseMs < RESPONSE_TIME_THRESHOLD_MS,
    input.hasViewportMeta,
  ]);
  const platform = platformScore(input.platform);
  const conversion = checksSubscore([
    input.hasVisiblePhone,
    input.hasContactForm,
    input.hasBookingLink,
    input.hasCtaAboveFold,
    input.hasClickToCall,
  ]);
  const freshness = checksSubscore([
    input.copyrightYear !== null &&
      input.currentYear - input.copyrightYear <= COPYRIGHT_RECENT_YEARS,
    input.hasRecentLastModified,
    !input.hasBrokenImages,
  ]);
  const design = clamp100(input.designScore ?? DESIGN_STUB_SCORE);

  const score = Math.round(
    performance * HEALTH_WEIGHTS.performance +
      mobile * HEALTH_WEIGHTS.mobile +
      technical * HEALTH_WEIGHTS.technical +
      platform * HEALTH_WEIGHTS.platform +
      conversion * HEALTH_WEIGHTS.conversion +
      freshness * HEALTH_WEIGHTS.freshness +
      design * HEALTH_WEIGHTS.design,
  );

  return {
    score: clamp100(score),
    breakdown: {
      performance,
      mobile,
      technical,
      platform,
      conversion,
      freshness,
      design,
      specialCase: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Star grade
// ---------------------------------------------------------------------------

/**
 * Star grade from Health Score (PRD 4.2). Whole stars only in v1
 * (half-stars at band edges are optional per PRD — deferred).
 */
export function deriveStarGrade(healthScore: number): 1 | 2 | 3 | 4 | 5 {
  const clamped = clamp100(healthScore);
  for (const band of STAR_BANDS) {
    if (clamped >= band.min) return band.stars;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Sellability Score computation
// ---------------------------------------------------------------------------

export type WebsiteKind = "real" | "social_only" | "none" | "unknown";

export interface SellabilityInput {
  websiteKind: WebsiteKind;
  /**
   * Health score from computeHealthScore; null only when unaudited.
   * (No-website leads never carry a health score — they short-circuit to 95.)
   */
  healthScore: number | null;
  reviewCount: number | null;
  googleRating: number | null;
  hasPhone: boolean;
  isChain: boolean;
  /** Google Places business_status, e.g. 'OPERATIONAL'. */
  businessStatus: string | null;
  /**
   * Blocked site (see HealthScoreInput.siteBlocked): never a dead-site badge,
   * and the audit is provisional → PROVISIONAL_SELLABILITY_CAP applies.
   */
  siteBlocked?: boolean;
  /**
   * PSI mobile performance 0–100 (RFL.FIX.3i): the healthy_site cap needs it
   * at/above HEALTHY_SITE_MOBILE_MIN. Null/absent = unmeasured → health alone.
   */
  mobilePerformance?: number | null;
}

/** Which cap bound the final score (the lowest applicable one). */
export type SellabilityCap = "chain" | "healthy_site" | "provisional";

export interface SellabilityBreakdown {
  invertedHealth: number;
  reviewCount: number;
  ratingQuality: number;
  phoneReachable: number;
  notChain: number;
  operational: number;
  specialCase: "no_website" | null;
  /** Present (true) whenever is_chain (the 40 cap is in force). */
  chain?: true;
  /** Present when a cap bound the score; names the lowest cap that applied. */
  capped?: SellabilityCap;
  /** Present (true) when rating or review count was null → neutral terms. */
  reputationUnknown?: true;
}

export interface SellabilityResult {
  /** 0–100 integer */
  score: number;
  breakdown: SellabilityBreakdown;
  /** Badge copy when a special case applies (PRD 4.4). */
  badge: string | null;
}

/** Review count → banded subscore (PRD 4.3). Null counts as zero reviews. */
export function reviewCountScore(reviewCount: number | null): number {
  const count = reviewCount ?? 0;
  for (const band of REVIEW_COUNT_BANDS) {
    if (count >= band.min) return band.score;
  }
  return REVIEW_COUNT_BANDS[REVIEW_COUNT_BANDS.length - 1]?.score ?? 20;
}

/**
 * The healthy-site rule (RFL.FIX.3i): health ≥ HEALTHY_SITE_HEALTH_MIN and
 * mobile performance ≥ HEALTHY_SITE_MOBILE_MIN (null mobile = unmeasured →
 * health alone). Drives the healthy_site cap and the Health narration's
 * "healthy" band, so the two never disagree.
 */
export function isHealthySite(
  healthScore: number,
  mobilePerformance: number | null,
): boolean {
  return (
    healthScore >= HEALTHY_SITE_HEALTH_MIN &&
    (mobilePerformance === null || mobilePerformance >= HEALTHY_SITE_MOBILE_MIN)
  );
}

/**
 * Sellability Score (PRD 4.3) — pure, deterministic.
 *
 * Special case (PRD 4.4 + CLAUDE.md 6.7, non-negotiable routing): no-website
 * AND social-only businesses are hot leads at NO_WEBSITE_SELLABILITY_SCORE.
 * They are never skipped and never audited.
 */
export function computeSellabilityScore(
  input: SellabilityInput,
): SellabilityResult {
  const result = computeUncappedSellability(input);
  // Special-case routing (no website → 95) is law and is never capped.
  if (result.breakdown.specialCase === "no_website") return result;

  // Caps — the LOWEST applicable one wins; `capped` names it.
  const caps: Array<[SellabilityCap, number]> = [];
  if (input.isChain) caps.push(["chain", CHAIN_SELLABILITY_CAP]);
  if (input.siteBlocked === true) {
    caps.push(["provisional", PROVISIONAL_SELLABILITY_CAP]);
  } else if (
    input.healthScore !== null &&
    isHealthySite(input.healthScore, input.mobilePerformance ?? null)
  ) {
    caps.push(["healthy_site", HEALTHY_SITE_SELLABILITY_CAP]);
  }
  const chainFlag = input.isChain ? { chain: true as const } : {};
  if (caps.length === 0) {
    return { ...result, breakdown: { ...result.breakdown, ...chainFlag } };
  }
  caps.sort((a, b) => a[1] - b[1]);
  const [cap, limit] = caps[0]!;
  return {
    ...result,
    score: Math.min(result.score, limit),
    breakdown: { ...result.breakdown, ...chainFlag, capped: cap },
  };
}

function computeUncappedSellability(input: SellabilityInput): SellabilityResult {
  if (input.websiteKind === "none" || input.websiteKind === "social_only") {
    return {
      score: NO_WEBSITE_SELLABILITY_SCORE,
      breakdown: {
        invertedHealth: 0,
        reviewCount: 0,
        ratingQuality: 0,
        phoneReachable: 0,
        notChain: 0,
        operational: 0,
        specialCase: "no_website",
      },
      badge: SPECIAL_CASE_BADGES.noWebsite,
    };
  }

  // Null health on an audited site shouldn't happen (dead sites score 10);
  // treat as neutral rather than inventing pain we didn't measure.
  const invertedHealth = clamp100(100 - (input.healthScore ?? 50));
  // Null reputation is unknown, never zero (finding 8): neutral per term.
  const reputationUnknown =
    input.reviewCount === null || input.googleRating === null;
  const reviewCount =
    input.reviewCount === null
      ? UNKNOWN_REPUTATION_SCORE
      : reviewCountScore(input.reviewCount);
  const ratingQuality =
    input.googleRating === null
      ? UNKNOWN_REPUTATION_SCORE
      : input.googleRating >= RATING_QUALITY_THRESHOLD
        ? 100
        : 0;
  const phoneReachable = input.hasPhone ? 100 : 0;
  const notChain = input.isChain ? 0 : 100;
  const operational = input.businessStatus === "OPERATIONAL" ? 100 : 0;

  const score = Math.round(
    invertedHealth * SELLABILITY_WEIGHTS.invertedHealth +
      reviewCount * SELLABILITY_WEIGHTS.reviewCount +
      ratingQuality * SELLABILITY_WEIGHTS.ratingQuality +
      phoneReachable * SELLABILITY_WEIGHTS.phoneReachable +
      notChain * SELLABILITY_WEIGHTS.notChain +
      operational * SELLABILITY_WEIGHTS.operational,
  );

  const badge =
    input.siteBlocked !== true && input.healthScore === DEAD_SITE_HEALTH_SCORE
      ? SPECIAL_CASE_BADGES.deadSite
      : null;

  return {
    score: clamp100(score),
    breakdown: {
      invertedHealth,
      reviewCount,
      ratingQuality,
      phoneReachable,
      notChain,
      operational,
      specialCase: null,
      ...(reputationUnknown ? { reputationUnknown: true as const } : {}),
    },
    badge,
  };
}
