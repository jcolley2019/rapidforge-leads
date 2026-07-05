/**
 * Fixture PageSpeed Insights data — realistic Lighthouse category scores +
 * Core Web Vitals for the 25 fixture businesses (Sprint 3), keyed by
 * hostname. Profiles span the whole quality range so the scoring pipeline
 * produces a meaningful spread with zero external APIs:
 *
 *   great     snakeriverplumbing.com · pipedreamidaho.webflow.io ·
 *             precisionplumbingidaho.com · www.rotorooter.com
 *   mediocre  boiseplumbingco.com · kunaelectric.squarespace.com ·
 *             starplumbingidaho.wordpress.com · gcgaragedoor.com
 *   terrible  boisedrainpros.wixsite.com · meridiancomfort.godaddysites.com ·
 *             meridianwaterheater.com · vistaheatcool.com
 *
 * CrUX field data (has_crux_data → Traffic agent, PRD 6.6) is present only
 * for the busy businesses — it is the free real-user-traffic proxy.
 */
import type { PsiMetrics } from "./psi";

export interface PsiFixtureProfile {
  desktop: PsiMetrics;
  mobile: PsiMetrics;
}

function metrics(
  performance: number,
  accessibility: number,
  seo: number,
  bestPractices: number,
  lcpMs: number,
  cls: number,
  tbtMs: number,
  hasCruxData: boolean,
): PsiMetrics {
  return {
    performance,
    accessibility,
    seo,
    bestPractices,
    lcpMs,
    cls,
    tbtMs,
    hasCruxData,
  };
}

export const PSI_FIXTURES: Readonly<Record<string, PsiFixtureProfile>> = {
  // fx-001 — great custom site, busy shop (CrUX present)
  "snakeriverplumbing.com": {
    desktop: metrics(92, 96, 98, 96, 1400, 0.02, 80, true),
    mobile: metrics(88, 95, 97, 96, 1800, 0.03, 150, true),
  },
  // fx-002 — terrible Wix build
  "boisedrainpros.wixsite.com": {
    desktop: metrics(38, 71, 74, 65, 5900, 0.28, 900, false),
    mobile: metrics(22, 68, 72, 62, 8200, 0.31, 2100, false),
  },
  // fx-006 — chain corporate site, well built, heavy traffic
  "www.rotorooter.com": {
    desktop: metrics(84, 94, 95, 92, 1900, 0.05, 180, true),
    mobile: metrics(76, 92, 94, 90, 2600, 0.08, 420, true),
  },
  // fx-009/010/011 — mediocre WordPress (same host, three locations)
  "boiseplumbingco.com": {
    desktop: metrics(63, 82, 85, 78, 3200, 0.12, 350, true),
    mobile: metrics(48, 80, 83, 75, 4100, 0.15, 800, true),
  },
  // fx-012 — terrible GoDaddy builder site
  "meridiancomfort.godaddysites.com": {
    desktop: metrics(41, 69, 70, 62, 5600, 0.22, 750, false),
    mobile: metrics(25, 66, 68, 60, 7400, 0.26, 1900, false),
  },
  // fx-013 — decent Squarespace
  "kunaelectric.squarespace.com": {
    desktop: metrics(68, 88, 90, 85, 2900, 0.08, 300, false),
    mobile: metrics(55, 86, 88, 83, 3600, 0.1, 650, false),
  },
  // fx-014 — aging WordPress.com blog-as-site
  "starplumbingidaho.wordpress.com": {
    desktop: metrics(55, 78, 80, 72, 3800, 0.15, 500, false),
    mobile: metrics(40, 76, 78, 70, 5200, 0.18, 1100, false),
  },
  // fx-017 — great Webflow site, tiny business (no CrUX)
  "pipedreamidaho.webflow.io": {
    desktop: metrics(95, 97, 99, 96, 1200, 0.01, 60, false),
    mobile: metrics(90, 96, 98, 95, 1500, 0.02, 120, false),
  },
  // fx-018 — ancient hand-rolled site, the worst of the set
  "meridianwaterheater.com": {
    desktop: metrics(33, 58, 62, 55, 7200, 0.42, 1400, false),
    mobile: metrics(18, 55, 60, 52, 9800, 0.45, 3200, false),
  },
  // fx-019 — gate-skipped (CLOSED_TEMPORARILY) but kept for completeness
  "abcplumbingboise.com": {
    desktop: metrics(60, 80, 82, 75, 3400, 0.1, 400, false),
    mobile: metrics(45, 78, 80, 73, 4400, 0.14, 900, false),
  },
  // fx-022 — poor site on a busy HVAC business (money + pain: CrUX present)
  "vistaheatcool.com": {
    desktop: metrics(45, 72, 75, 68, 5100, 0.19, 700, true),
    mobile: metrics(30, 70, 73, 65, 6800, 0.24, 1600, true),
  },
  // fx-023 — mediocre custom site
  "gcgaragedoor.com": {
    desktop: metrics(58, 79, 81, 74, 3600, 0.13, 450, false),
    mobile: metrics(47, 77, 79, 72, 4600, 0.16, 950, false),
  },
  // fx-025 — great custom site, the busiest shop in the set
  "precisionplumbingidaho.com": {
    desktop: metrics(90, 95, 97, 94, 1600, 0.03, 120, true),
    mobile: metrics(85, 94, 96, 93, 2000, 0.05, 260, true),
  },
};

/**
 * Deterministic fallback for hosts outside the fixture set (e.g. real
 * Places data paired with fixture PSI). Hash of the hostname → a stable
 * mediocre profile, so repeated audits agree with each other and nothing
 * is random (CLAUDE.md 4.2: deterministic before AI).
 */
export function fallbackPsiProfile(host: string): PsiFixtureProfile {
  let hash = 0;
  for (let i = 0; i < host.length; i += 1) {
    hash = (hash * 31 + host.charCodeAt(i)) % 997;
  }
  const desktopPerf = 40 + (hash % 41); // 40–80
  const mobilePerf = Math.max(15, desktopPerf - 12 - (hash % 10));
  const lcpDesktop = 2500 + (hash % 2500);
  return {
    desktop: metrics(
      desktopPerf,
      70 + (hash % 20),
      72 + (hash % 20),
      65 + (hash % 25),
      lcpDesktop,
      Number((0.05 + (hash % 20) / 100).toFixed(2)),
      200 + (hash % 600),
      hash % 3 === 0,
    ),
    mobile: metrics(
      mobilePerf,
      68 + (hash % 20),
      70 + (hash % 20),
      63 + (hash % 25),
      lcpDesktop + 1200 + (hash % 1800),
      Number((0.08 + (hash % 25) / 100).toFixed(2)),
      500 + (hash % 1500),
      hash % 3 === 0,
    ),
  };
}
