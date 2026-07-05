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
} as const;

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
  hasVisiblePhone: boolean;
  hasClickToCall: boolean;
  hasForm: boolean;
  hasBooking: boolean;
  hasViewportMeta: boolean;
  hasSchemaMarkup: boolean;
  hasCruxData: boolean | null;
  napConsistent: boolean | null;
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
  if (input.platform !== null && isBuilderPlatform(input.platform)) {
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
  if (input.hasCruxData === false) {
    add(
      "low",
      "No real-user traffic data in the Chrome UX Report",
      "Likely very low site traffic",
    );
  }

  return issues.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}
