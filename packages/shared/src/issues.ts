/**
 * "What's wrong" issues list (PRD 4.5) — threshold-based plain-English
 * bullets written by the Scorer, stored in `audits.issues`.
 *
 * Deterministic like all scoring (CLAUDE.md 4.2). Thresholds live here as
 * exported constants for the same reason scoring weights do — Joey tunes
 * them after real audits. This file deliberately does NOT touch
 * scoring.ts (protected, CLAUDE.md Section 3).
 */
import { COPYRIGHT_RECENT_YEARS, isBuilderPlatform } from "./scoring";
import type { Issue } from "./schemas";

export const ISSUE_THRESHOLDS = {
  /** PSI mobile performance below this is a high-severity issue. */
  mobilePerfFailing: 50,
  /** PSI desktop performance below this is a medium-severity issue. */
  desktopPerfPoor: 50,
  /** Mobile LCP above this (ms) is high severity ("should be under 3s"). */
  lcpBadMs: 4000,
  /** Mobile LCP above this (ms) misses the CWV good threshold (medium). */
  lcpSlowMs: 2500,
  /** CLS above this is a visible-jank medium issue. */
  clsPoor: 0.25,
  /** Server response at/above this (ms) is a medium issue. */
  responseSlowMs: 2000,
  // -- Sprint 6 (Design / Reputation / SEO agents) --------------------------
  /** Design modernity below this reads as visibly dated (high severity). */
  designDatedBelow: 40,
  /** Design modernity below this is behind current standards (medium). */
  designBehindBelow: 60,
  /** Fewer Google reviews than this is a credibility issue (medium). */
  reviewsFewBelow: 10,
  /** Google rating below this (with enough reviews) is high severity. */
  ratingPoorBelow: 3.5,
  /** SEO local-fit score (1–5) at/below this is weak targeting (medium). */
  seoWeakFitAtOrBelow: 2,
  /** Last-Modified older than this many days = "not updated in N years" (low). */
  lastModifiedStaleDays: 730,
} as const;

/**
 * Titles a page builder or editor leaves behind (RFL.FIX.3k): a found
 * <title> that says nothing is a high issue, same as a missing one.
 */
export const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  "untitled document",
  "home",
  "welcome",
  "index",
  "new page",
  "home page",
]);

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return PLACEHOLDER_TITLES.has(title.trim().toLowerCase());
}

/** Detected platform keys → sales-readable names for issue bullets. */
export const PLATFORM_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  wix: "Wix",
  godaddy: "GoDaddy Website Builder",
  squarespace: "Squarespace",
  wordpress: "WordPress",
  webflow: "Webflow",
};

/** Everything the issue thresholds read. Null = unmeasured/unknown. */
export interface IssueInputs {
  psMobilePerformance: number | null;
  psDesktopPerformance: number | null;
  psLcpMs: number | null;
  psCls: number | null;
  sslValid: boolean | null;
  httpsEnforced: boolean | null;
  responseMs: number | null;
  platform: string | null;
  copyrightYear: number | null;
  currentYear: number;
  /**
   * RFL.FIX.3k: days since the Last-Modified header; null = header absent
   * / unparseable / Health didn't run (no bullet — unknown is not stale).
   */
  lastModifiedAgeDays?: number | null;
  hasVisiblePhone: boolean;
  hasClickToCall: boolean;
  hasForm: boolean;
  hasBooking: boolean;
  hasViewportMeta: boolean;
  hasSchemaMarkup: boolean;
  hasCruxData: boolean | null;
  napConsistent: boolean | null;
  /**
   * RFL.FIX.3c: true = Google's street line is on the homepage; false = a
   * different street address is; null = none shown, or Presence didn't run.
   */
  napAddressMatch: boolean | null;
  /** Google's street line as Presence compared it; null = none / not run. */
  napGoogleStreet: string | null;
  // -- Sprint 6 (Design / Reputation / SEO agents). Null = agent didn't run.
  designModernity: number | null;
  designFeelsLikeYear: number | null;
  googleRating: number | null;
  reviewCount: number | null;
  seoLocalFitScore: number | null;
  seoHasTitle: boolean | null;
  /** RFL.FIX.3k: the <title> text when found, for placeholder detection. */
  seoTitleValue?: string | null;
  seoHasMetaDescription: boolean | null;
  seoHasSitemap: boolean | null;
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Build the threshold-based issues list (PRD 4.5), most severe first.
 * Unknown inputs (null) produce NO bullet — a claim needs a measurement
 * behind it (CLAUDE.md 6.3), so "we couldn't measure X" is never phrased
 * as "X is broken".
 */
/** Null Places rating/review count (audit finding 8): unknown, not zero. */
export const UNVERIFIED_REPUTATION_LABEL =
  "Unverified reputation (no Google rating data)";

export function unverifiedReputationIssue(
  googleRating: number | null,
  reviewCount: number | null,
): Issue | null {
  if (googleRating !== null && reviewCount !== null) return null;
  const missing =
    googleRating === null && reviewCount === null
      ? "Places returned no rating and no review count"
      : googleRating === null
        ? "Places returned no rating"
        : "Places returned no review count";
  return {
    severity: "low",
    label: UNVERIFIED_REPUTATION_LABEL,
    detail: `${missing} — reputation terms scored neutral, verify by hand`,
  };
}

export function buildIssues(input: IssueInputs): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], label: string, detail?: string) => {
    issues.push(detail ? { severity, label, detail } : { severity, label });
  };

  // -- performance ----------------------------------------------------------
  if (
    input.psMobilePerformance !== null &&
    input.psMobilePerformance < ISSUE_THRESHOLDS.mobilePerfFailing
  ) {
    add(
      "high",
      "Mobile page speed is failing",
      `PSI mobile performance ${input.psMobilePerformance}/100`,
    );
  }
  if (input.psLcpMs !== null && input.psLcpMs > ISSUE_THRESHOLDS.lcpBadMs) {
    add(
      "high",
      `Mobile page load is ${(input.psLcpMs / 1000).toFixed(1)}s (should be under 3)`,
      `Largest Contentful Paint ${input.psLcpMs}ms`,
    );
  } else if (
    input.psLcpMs !== null &&
    input.psLcpMs > ISSUE_THRESHOLDS.lcpSlowMs
  ) {
    add(
      "medium",
      `Mobile page load is ${(input.psLcpMs / 1000).toFixed(1)}s — misses the 2.5s good threshold`,
      `Largest Contentful Paint ${input.psLcpMs}ms`,
    );
  }
  if (
    input.psDesktopPerformance !== null &&
    input.psDesktopPerformance < ISSUE_THRESHOLDS.desktopPerfPoor
  ) {
    add(
      "medium",
      "Desktop page speed is poor",
      `PSI desktop performance ${input.psDesktopPerformance}/100`,
    );
  }
  if (input.psCls !== null && input.psCls > ISSUE_THRESHOLDS.clsPoor) {
    add(
      "medium",
      "Page layout shifts while loading",
      `Cumulative Layout Shift ${input.psCls}`,
    );
  }

  // -- technical ------------------------------------------------------------
  if (input.sslValid === false) {
    add("high", "Site is not served over valid HTTPS/SSL");
  } else if (input.httpsEnforced === false) {
    add("medium", "Site does not enforce HTTPS");
  }
  if (
    input.responseMs !== null &&
    input.responseMs >= ISSUE_THRESHOLDS.responseSlowMs
  ) {
    add(
      "medium",
      `Server response took ${input.responseMs}ms (should be under 2s)`,
    );
  }
  if (!input.hasViewportMeta) {
    add("high", "Not mobile-friendly (missing viewport meta tag)");
  }

  // -- platform -------------------------------------------------------------
  if (input.platform === "legacy_static") {
    // RFL.FIX.3d: scores like a builder (30) but the pitch is different.
    // The missing viewport is the viewport issue's fact alone (RFL.FIX.3i).
    add(
      "high",
      "Legacy hand-coded page",
      "Pre-CSS markup and not updated in over two years — a full rebuild, not a tweak",
    );
  } else if (input.platform !== null && isBuilderPlatform(input.platform)) {
    const display =
      PLATFORM_DISPLAY_NAMES[input.platform] ?? input.platform;
    add(
      "medium",
      `Built on ${display}`,
      "Builder sites are the quickest kind to replace",
    );
  }

  // -- conversion -----------------------------------------------------------
  if (!input.hasVisiblePhone) {
    add("high", "No visible phone number on the homepage");
  } else if (!input.hasClickToCall) {
    add("medium", "Phone number is not clickable (no tel: link)");
  }
  if (!input.hasForm && !input.hasBooking) {
    add("high", "No contact form or online booking");
  } else if (!input.hasBooking) {
    add("low", "No online booking link");
  }
  if (!input.hasSchemaMarkup) {
    add("medium", "Missing schema.org LocalBusiness markup");
  }

  // -- freshness ------------------------------------------------------------
  if (
    typeof input.lastModifiedAgeDays === "number" &&
    input.lastModifiedAgeDays > ISSUE_THRESHOLDS.lastModifiedStaleDays
  ) {
    const years = Math.floor(input.lastModifiedAgeDays / 365);
    add(
      "low",
      `Site not updated in ${years} year${years === 1 ? "" : "s"} (Last-Modified)`,
      "The server's Last-Modified header is more than two years old",
    );
  }
  if (
    input.copyrightYear !== null &&
    input.currentYear - input.copyrightYear > COPYRIGHT_RECENT_YEARS
  ) {
    add(
      "medium",
      `Copyright year is ${input.copyrightYear}`,
      "Signals an unmaintained site",
    );
  }

  // -- presence / traffic ---------------------------------------------------
  if (input.napConsistent === false) {
    add(
      "medium",
      "Phone or address on the site doesn't match the Google listing",
    );
  }
  // Absence is not a mismatch (RFL.FIX.3c): Google has an address, the
  // homepage shows none.
  if (input.napAddressMatch === null && input.napGoogleStreet !== null) {
    add(
      "low",
      "Address not shown on the homepage",
      `Google lists ${input.napGoogleStreet}`,
    );
  }
  if (input.hasCruxData === false) {
    add(
      "low",
      "No real-user traffic data in the Chrome UX Report",
      "Likely very low site traffic",
    );
  }

  // -- design (Sprint 6, PRD 6.8) --------------------------------------------
  if (
    input.designModernity !== null &&
    input.designModernity < ISSUE_THRESHOLDS.designDatedBelow
  ) {
    add(
      "high",
      input.designFeelsLikeYear !== null
        ? `Site design looks dated — feels like ${input.designFeelsLikeYear}`
        : "Site design looks dated",
      `Design modernity ${input.designModernity}/100`,
    );
  } else if (
    input.designModernity !== null &&
    input.designModernity < ISSUE_THRESHOLDS.designBehindBelow
  ) {
    add(
      "medium",
      "Site design is behind current standards",
      `Design modernity ${input.designModernity}/100`,
    );
  }

  // -- reputation (Sprint 6, PRD 6.9) -----------------------------------------
  const unverified = unverifiedReputationIssue(input.googleRating, input.reviewCount);
  if (unverified) issues.push(unverified);
  if (
    input.googleRating !== null &&
    input.reviewCount !== null &&
    input.reviewCount >= ISSUE_THRESHOLDS.reviewsFewBelow &&
    input.googleRating < ISSUE_THRESHOLDS.ratingPoorBelow
  ) {
    add(
      "high",
      `Google rating is ${input.googleRating} — reputation is hurting conversions`,
      `${input.reviewCount} reviews`,
    );
  }
  if (input.reviewCount === 0) {
    // Zero is a measurement, not an unknown (RFL.FIX.3f): a business with
    // no reviews at all is silent proof, not a neutral.
    add(
      "medium",
      "No Google reviews yet",
      "Zero reviews on the Google listing — no social proof for prospects",
    );
  } else if (
    input.reviewCount !== null &&
    input.reviewCount < ISSUE_THRESHOLDS.reviewsFewBelow
  ) {
    add(
      "medium",
      `Only ${input.reviewCount} Google review${input.reviewCount === 1 ? "" : "s"}`,
      "Thin review volume undermines trust",
    );
  }

  // -- seo (Sprint 6, PRD 6.10) -----------------------------------------------
  if (input.seoHasTitle === false) {
    add("high", "Homepage is missing a <title> tag");
  } else if (input.seoHasTitle === true && isPlaceholderTitle(input.seoTitleValue)) {
    add(
      "high",
      "Placeholder page title",
      `The <title> is "${input.seoTitleValue!.trim()}" — Google shows that as the page name`,
    );
  }
  if (input.seoHasMetaDescription === false) {
    add("medium", "Homepage has no meta description");
  }
  if (
    input.seoLocalFitScore !== null &&
    input.seoLocalFitScore <= ISSUE_THRESHOLDS.seoWeakFitAtOrBelow
  ) {
    add(
      "medium",
      "Weak local SEO targeting",
      `Local keyword fit ${input.seoLocalFitScore}/5`,
    );
  }
  if (input.seoHasSitemap === false) {
    add("low", "No sitemap.xml");
  }

  return issues.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}
