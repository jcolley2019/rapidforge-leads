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
  PLATFORM_SCORES,
  UNMEASURED_PSI_SCORE,
} from "@rapidforge/shared";
import type { ConversionOutput } from "./conversion";
import type { HealthOutput } from "./health";
import { assembleScores, type ScoreInputs } from "./scorer";
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
    expect(timeouts.map((i) => i.label).sort()).toEqual(["psi timed out", "screenshot timed out", "seo timed out"]);
    for (const t of timeouts) expect(t.severity).toBe("low");
    expect(scores.scoreBreakdown.stage_timeouts).toEqual(["psi", "screenshot", "seo"]);
    expect(assembleScores(inputs()).scoreBreakdown.stage_timeouts).toBeUndefined();
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
