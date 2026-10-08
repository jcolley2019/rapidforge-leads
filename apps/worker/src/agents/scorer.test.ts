/**
 * Scorer (PRD 6.7) — assembleScores is pure math over the agents' outputs.
 * RFL.FIX.3k: direct coverage (it used to be reached only through the
 * orchestrator fixtures): all agents null, PSI null, desktop off, stage
 * timeouts, and the two new issues (placeholder title, stale Last-Modified).
 */
import { describe, expect, it } from "vitest";
import type { Business } from "@rapidforge/shared";
import {
  DESIGN_STUB_SCORE,
  HEALTH_WEIGHTS,
  PLATFORM_SCORES,
  UNMEASURED_PSI_SCORE,
  deriveStarGrade,
} from "@rapidforge/shared";
import type { ConversionOutput } from "./conversion";
import type { DesignOutput } from "./design";
import type { HealthOutput } from "./health";
import { assembleScores, classifyPlatform, type ScoreInputs } from "./scorer";
import type { SeoOutput } from "./seo";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const business: Business = {
  id: "biz-1",
  workspace_id: "ws-1",
  google_place_id: "fx-acc",
  name: "Accurbore, Inc.",
  phone: "(208) 371-5731",
  website_url: "http://www.accurbore.com/",
  address: "11567 Lake Shore Dr, Nampa, ID 83686, USA",
  lat: null,
  lng: null,
  google_rating: 5,
  review_count: 7,
  category: "plumber",
  business_status: "OPERATIONAL",
  is_chain: false,
  website_kind: "real",
  first_seen_at: null,
  last_refreshed_at: null,
};

function health(over: Partial<HealthOutput> = {}): HealthOutput {
  return {
    ps_performance: 99,
    ps_mobile_performance: 99,
    desktop_measured: false,
    ps_accessibility: 80,
    ps_seo: 70,
    ps_best_practices: 60,
    ps_lcp_ms: 2132,
    ps_cls: 0.01,
    ps_tbt_ms: 10,
    has_crux_data: false,
    http_status: 200,
    response_ms: 262,
    ssl_valid: false,
    https_enforced: false,
    platform: "custom",
    copyright_year: null,
    has_recent_last_modified: false,
    last_modified_at: "2023-06-21T19:31:28.000Z",
    legacy_markup: false,
    summary: { reasoning: "r 1 2", critical_issues: [], summary_one_liner: "s" },
    ...over,
  };
}

function conversion(over: Partial<ConversionOutput> = {}): ConversionOutput {
  return {
    has_tel_link: false,
    tel_numbers: [],
    has_visible_phone: true,
    visible_phone: "208-371-5731",
    form_count: 0,
    max_form_fields: 0,
    has_form: false,
    has_booking: false,
    booking_url: null,
    has_chat: false,
    chat_evidence: null,
    has_viewport_meta: false,
    has_schema_markup: false,
    has_cta_above_fold: false,
    cta_candidates: [],
    cta_source: null,
    summary: { cta_strength: "weak", evidence: [], reasoning: "r", summary_one_liner: "s" },
    ...over,
  };
}

function seo(title: string | null): SeoOutput {
  return {
    title: { found: title !== null, value: title },
    meta_description: { found: true, value: "horizontal earth boring" },
    h1s: ["Horizontal Earth Boring"],
    h1_count: 1,
    schema_types: [],
    has_schema: false,
    has_sitemap: null,
    has_robots_txt: null,
    city: "Nampa",
    category: "plumber",
    category_label: "plumber",
    title_has_city: false,
    title_has_category: false,
    h1_has_city: false,
    h1_has_category: false,
    meta_has_city: false,
    meta_has_category: false,
    summary: { local_fit_score_1_5: 2, reasoning: "r", gaps: [] },
  };
}

function inputs(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    business,
    health: null,
    conversion: null,
    presence: null,
    traffic: null,
    design: null,
    reputation: null,
    seo: null,
    now: NOW,
    ...over,
  };
}

describe("assembleScores — missing agents", () => {
  it("all agents null: neutral PSI, stub design, every check failed, and no bullet that needs a measurement", () => {
    const scores = assembleScores(inputs());
    const h = scores.scoreBreakdown.health as Record<string, number>;
    expect(h.performance).toBe(UNMEASURED_PSI_SCORE);
    expect(h.mobile).toBe(UNMEASURED_PSI_SCORE);
    expect(h.design).toBe(DESIGN_STUB_SCORE);
    expect(h.platform).toBe(PLATFORM_SCORES.custom);
    expect(h.technical).toBe(0);
    expect(h.conversion).toBe(0);
    expect(h.freshness).toBeCloseTo(100 / 3, 5); // only "no broken images" passes
    expect(scores.healthScore).toBeGreaterThan(0);
    expect(scores.starGrade).toBeGreaterThanOrEqual(1);
    const labels = scores.issues.map((i) => i.label);
    // Measured-false conversion facts are reported (the Scorer treats a
    // missing agent as "not found"); unknown PSI/NAP/SEO/Last-Modified are not.
    expect(labels).not.toContain("Mobile page speed is failing");
    expect(labels).not.toContain("Performance could not be measured");
    expect(labels).not.toContain("Homepage is missing a <title> tag");
    expect(labels).not.toContain("Placeholder page title");
    expect(labels.some((l) => l.startsWith("Site not updated"))).toBe(false);
    expect(labels.some((l) => /Google listing|Address not shown/.test(l))).toBe(false);
    expect((scores.scoreBreakdown.agents as Record<string, boolean>).health).toBe(false);
    expect(scores.badge).toBeNull();
  });

  it("PSI null with psiUnmeasured: neutral 50 on both terms plus one low issue, flagged in the breakdown", () => {
    const scores = assembleScores(
      inputs({
        health: health({ ps_performance: null, ps_mobile_performance: null, ps_lcp_ms: null }),
        psiUnmeasured: true,
      }),
    );
    const h = scores.scoreBreakdown.health as Record<string, unknown>;
    expect(h.performance).toBe(UNMEASURED_PSI_SCORE);
    expect(h.mobile).toBe(UNMEASURED_PSI_SCORE);
    expect(h.psi_unmeasured).toBe(true);
    expect(scores.issues.filter((i) => i.label === "Performance could not be measured")).toHaveLength(1);
    expect(scores.issues.map((i) => i.label)).not.toContain("Mobile page speed is failing");
  });

  it("desktop off: the mobile copy fills the performance term but never earns a second bullet", () => {
    const scores = assembleScores(
      inputs({ health: health({ ps_performance: 32, ps_mobile_performance: 32, desktop_measured: false }) }),
    );
    const h = scores.scoreBreakdown.health as Record<string, number>;
    expect(h.performance).toBe(32);
    expect(h.mobile).toBe(32);
    const labels = scores.issues.map((i) => i.label);
    expect(labels).toContain("Mobile page speed is failing");
    expect(labels.filter((l) => /desktop/i.test(l))).toEqual([]);

    const measured = assembleScores(
      inputs({ health: health({ ps_performance: 32, ps_mobile_performance: 32, desktop_measured: true }) }),
    );
    expect(measured.issues.filter((i) => /desktop/i.test(i.label))).toHaveLength(1);
  });

  it("stage timeouts: one low issue per distinct stage, listed in the breakdown", () => {
    const scores = assembleScores(
      inputs({ stageTimeouts: ["psi", "screenshot", "psi", "seo"] }),
    );
    const timeouts = scores.issues.filter((i) => i.label.endsWith(" timed out"));
    // A screenshot overrun is internal (RFL.VERIFY.3 V2): breakdown only, no issue.
    expect(timeouts.map((i) => i.label).sort()).toEqual(["psi timed out", "seo timed out"]);
    for (const t of timeouts) expect(t.severity).toBe("low");
    expect(scores.scoreBreakdown.stage_timeouts).toEqual(["psi", "screenshot", "seo"]);
    expect(assembleScores(inputs()).scoreBreakdown.stage_timeouts).toBeUndefined();
  });
});

describe("classifyPlatform — legacy_static (RFL.FIX.3d)", () => {
  const legacyHealth = () => health({ platform: "custom", legacy_markup: true, last_modified_at: "2023-06-21T19:31:28.000Z" });

  it("Accurbore: custom + no viewport + legacy markup + 2023 Last-Modified → legacy_static, platform term 30, ~8 health points lower", () => {
    expect(classifyPlatform(legacyHealth(), conversion({ has_viewport_meta: false }), NOW)).toBe("legacy_static");
    const scores = assembleScores(
      inputs({ health: legacyHealth(), conversion: conversion({ has_viewport_meta: false }), seo: seo("Untitled Document") }),
    );
    expect(scores.platform).toBe("legacy_static");
    expect((scores.scoreBreakdown.health as Record<string, number>).platform).toBe(30);
    expect(scores.badge).toBeNull(); // not a "Builder site"
    expect(scores.issues).toContainEqual(expect.objectContaining({ severity: "high", label: "Legacy hand-coded page" }));
    // RFL.FIX.3i: the legacy detail no longer restates the viewport fact; the
    // Scorer's viewport issue is its only carrier (RFL.FIX.3h V7).
    const legacyIssue = scores.issues.find((i) => i.label === "Legacy hand-coded page")!;
    expect(legacyIssue.detail).toBe("Pre-CSS markup and not updated in over two years — a full rebuild, not a tweak");
    expect(
      scores.issues.filter((i) => /viewport|responsive|mobile-friendly/i.test(`${i.label} ${i.detail ?? ""}`)),
    ).toEqual([expect.objectContaining({ label: "Not mobile-friendly (missing viewport meta tag)" })]);
    expect(scores.issues.some((i) => i.label.startsWith("Built on"))).toBe(false);
    const asCustom = assembleScores(
      inputs({ health: health({ legacy_markup: false }), conversion: conversion({ has_viewport_meta: false }), seo: seo("Untitled Document") }),
    );
    expect(asCustom.platform).toBe("custom");
    // (85 − 30) × 0.15 ≈ 8 health points, the whole difference.
    expect(asCustom.healthScore - scores.healthScore).toBeGreaterThanOrEqual(8);
    expect(asCustom.healthScore - scores.healthScore).toBeLessThanOrEqual(9);
    expect(asCustom.starGrade).toBeGreaterThanOrEqual(scores.starGrade);
    expect(asCustom.sellabilityScore).toBeLessThan(scores.sellabilityScore);
  });

  it("requires ALL three conditions; an absent Last-Modified counts as stale", () => {
    expect(classifyPlatform(legacyHealth(), conversion({ has_viewport_meta: true }), NOW)).toBe("custom");
    expect(classifyPlatform(health({ legacy_markup: false }), conversion({ has_viewport_meta: false }), NOW)).toBe("custom");
    expect(
      classifyPlatform(health({ legacy_markup: true, last_modified_at: "2026-09-30T00:00:00.000Z" }), conversion({ has_viewport_meta: false }), NOW),
    ).toBe("custom");
    expect(classifyPlatform(health({ legacy_markup: true, last_modified_at: null }), conversion({ has_viewport_meta: false }), NOW)).toBe("legacy_static");
    // Exactly 730 days old is not yet stale; 731 is.
    const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
    expect(classifyPlatform(health({ legacy_markup: true, last_modified_at: days(730) }), conversion({ has_viewport_meta: false }), NOW)).toBe("custom");
    expect(classifyPlatform(health({ legacy_markup: true, last_modified_at: days(731) }), conversion({ has_viewport_meta: false }), NOW)).toBe("legacy_static");
  });

  it("never reclassifies a detected builder/CMS, a null Health, or a missing Conversion", () => {
    expect(classifyPlatform(health({ platform: "wordpress", legacy_markup: true }), conversion({ has_viewport_meta: false }), NOW)).toBe("wordpress");
    expect(classifyPlatform(null, conversion({ has_viewport_meta: false }), NOW)).toBeNull();
    expect(classifyPlatform(legacyHealth(), null, NOW)).toBe("custom");
    expect(assembleScores(inputs({ health: health({ platform: "wix" }) })).badge).toBe("Builder site");
  });
});

describe("assembleScores — RFL.FIX.3k issues", () => {
  it("Accurbore: 'Untitled Document' is a high placeholder-title issue; a 2023 Last-Modified is a low stale issue", () => {
    const scores = assembleScores(
      inputs({ health: health(), conversion: conversion(), seo: seo("Untitled Document") }),
    );
    expect(scores.issues).toContainEqual(
      expect.objectContaining({ severity: "high", label: "Placeholder page title" }),
    );
    expect(scores.issues).toContainEqual(
      expect.objectContaining({ severity: "low", label: "Site not updated in 3 years (Last-Modified)" }),
    );
    // Sorted most severe first.
    expect(scores.issues[0]!.severity).toBe("high");
  });

  it("a real title and a fresh Last-Modified produce neither bullet; an absent header stays silent", () => {
    const fresh = assembleScores(
      inputs({
        health: health({ last_modified_at: "2026-09-30T00:00:00.000Z", has_recent_last_modified: true }),
        conversion: conversion(),
        seo: seo("Accurbore — Horizontal Earth Boring in Nampa"),
      }),
    );
    const labels = fresh.issues.map((i) => i.label);
    expect(labels).not.toContain("Placeholder page title");
    expect(labels.some((l) => l.startsWith("Site not updated"))).toBe(false);
    const absent = assembleScores(inputs({ health: health({ last_modified_at: null }) }));
    expect(absent.issues.some((i) => i.label.startsWith("Site not updated"))).toBe(false);
  });

  it("the sellability cap still names healthy_site for a 4★ page", () => {
    const scores = assembleScores(inputs({ health: health(), conversion: conversion(), seo: seo("Untitled Document") }));
    if (scores.healthScore >= 70) {
      expect(scores.sellabilityScore).toBeLessThanOrEqual(55);
      expect(scores.scoreBreakdown.capped).toBe("healthy_site");
    }
  });
});

describe("assembleScores — mobile-first weights and healthy cap (RFL.FIX.3i V3)", () => {
  const landers: Business = {
    ...business,
    id: "biz-landers",
    name: "Landers Home Services",
    website_url: "https://landershomeservices.com/",
    google_rating: 4.8,
    review_count: 33,
    category: "general_contractor",
  };

  function design(modernity: number): DesignOutput {
    const dim = { score_0_100: modernity, notes: "n" };
    return {
      modernity_0_100: modernity,
      feels_like_year: 2019,
      dimensions: { typography: dim, color: dim, imagery: dim, layout: dim, mobile: dim },
      reasoning: "r",
      critical_issues: [],
      used_vision: true,
    };
  }

  /** Landers' VERIFY.3 measurements: tech 100, wordpress 65, conversion 3/5, freshness 2/3, design 68. */
  function landersInputs(psi: { desktop: number; mobile: number; platform?: HealthOutput["platform"] }): ScoreInputs {
    return inputs({
      business: landers,
      health: health({
        ps_performance: psi.desktop,
        ps_mobile_performance: psi.mobile,
        desktop_measured: true,
        ps_lcp_ms: 13_600,
        ssl_valid: true,
        https_enforced: true,
        response_ms: 300,
        platform: psi.platform ?? "wordpress",
        copyright_year: null,
        has_recent_last_modified: true,
        last_modified_at: "2026-10-07T00:00:00.000Z",
      }),
      conversion: conversion({
        has_viewport_meta: true,
        has_visible_phone: true,
        has_tel_link: true,
        has_cta_above_fold: true,
      }),
      design: design(68),
    });
  }

  type Terms = Record<keyof typeof HEALTH_WEIGHTS, number>;
  const blend = (terms: Terms, w: Terms) =>
    Math.round((Object.keys(w) as Array<keyof Terms>).reduce((sum, k) => sum + terms[k] * w[k], 0));
  const PRE_3I_WEIGHTS: Terms = { ...HEALTH_WEIGHTS, performance: 0.25, mobile: 0.2 };

  it("weights: mobile 0.25 outweighs desktop performance 0.20", () => {
    expect(HEALTH_WEIGHTS.mobile).toBe(0.25);
    expect(HEALTH_WEIGHTS.performance).toBe(0.2);
  });

  it("Landers (desktop 94, mobile 48): health equals the hand recompute (70) and the healthy cap does not apply", () => {
    const scores = assembleScores(landersInputs({ desktop: 94, mobile: 48 }));
    const h = scores.scoreBreakdown.health as Terms;
    const stored: Terms = {
      performance: 94,
      mobile: 48,
      technical: 100,
      platform: 65,
      conversion: 60,
      freshness: 200 / 3,
      design: 68,
    };
    for (const k of Object.keys(stored) as Array<keyof Terms>) expect(h[k]).toBeCloseTo(stored[k], 5);
    // 94×0.20 + 48×0.25 + 100×0.10 + 65×0.15 + 60×0.15 + 66.7×0.10 + 68×0.05 = 69.62 → 70
    expect(scores.healthScore).toBe(blend(stored, HEALTH_WEIGHTS));
    expect(scores.healthScore).toBe(70);
    // The pre-3i weights gave the VERIFY.3 72.
    expect(blend(stored, PRE_3I_WEIGHTS)).toBe(72);
    // Mobile 48 < 50: no healthy_site cap. 30×0.5 + 80×0.15 + 10 + 10 + 10 + 5 = 62.
    expect(scores.scoreBreakdown.capped).toBeUndefined();
    expect(scores.sellabilityScore).toBe(62);
    // The star grade still follows STAR_BANDS alone (70 → 4★).
    expect(scores.starGrade).toBe(4);
  });

  it("a site with mobile 85 / desktop 90 keeps its band and its healthy_site cap", () => {
    const scores = assembleScores(landersInputs({ desktop: 90, mobile: 85, platform: "custom" }));
    const h = scores.scoreBreakdown.health as Terms;
    expect(h.performance).toBe(90);
    expect(h.mobile).toBe(85);
    const before = blend(h, PRE_3I_WEIGHTS);
    expect(scores.starGrade).toBe(deriveStarGrade(before));
    expect(scores.starGrade).toBe(4);
    expect(scores.scoreBreakdown.capped).toBe("healthy_site");
    expect(scores.sellabilityScore).toBe(55);
  });

  it("desktop off: the mobile copy fills the performance term as before", () => {
    // With PSI_DESKTOP off the orchestrator passes the mobile run as desktop.
    const base = landersInputs({ desktop: 99, mobile: 99, platform: "custom" });
    const scores = assembleScores({ ...base, health: { ...base.health!, desktop_measured: false } });
    const h = scores.scoreBreakdown.health as Terms;
    expect(h.performance).toBe(99);
    expect(h.mobile).toBe(99);
    expect(scores.healthScore).toBe(blend(h, HEALTH_WEIGHTS));
    expect(scores.scoreBreakdown.capped).toBe("healthy_site");
  });
});
