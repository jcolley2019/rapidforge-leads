/**
 * Scorer — PRD 6.7 (v1, DETERMINISTIC MATH — no LLM, ever).
 *
 * Assembles the audit agents' measured outputs, calls the pure functions
 * in @rapidforge/shared (computeHealthScore, deriveStarGrade,
 * computeSellabilityScore, buildIssues), and finalizes the pending
 * `audits` row Filter created. An LLM assigning a score is a bug
 * (CLAUDE.md 4.2). The orchestrator emits `lead.scored` on completion.
 *
 * A failed upstream agent leaves its fields null — unmeasured checks
 * score as failed/neutral per scoring.ts semantics, and unknown inputs
 * produce no issue bullets (never invented).
 */
import {
  buildIssues,
  computeHealthScore,
  computeSellabilityScore,
  deriveStarGrade,
  isBuilderPlatform,
  ISSUE_THRESHOLDS,
  SPECIAL_CASE_BADGES,
  type AgentResult,
  type Business,
  type Issue,
} from "@rapidforge/shared";
import type { ScreenshotUrls } from "../lib/screenshots";
import type { DataStore, UpdateAuditPatch } from "../store";
import type { ConversionOutput } from "./conversion";
import type { DesignOutput } from "./design";
import type { HealthOutput } from "./health";
import type { PresenceOutput } from "./presence";
import type { ReputationOutput } from "./reputation";
import type { SeoOutput } from "./seo";
import type { TrafficOutput } from "./traffic";

export interface ScorerContext {
  store: DataStore;
  business: Business;
  /** The pending audit row Filter created — finalized in place. */
  auditId: string;
  health: HealthOutput | null;
  conversion: ConversionOutput | null;
  presence: PresenceOutput | null;
  traffic: TrafficOutput | null;
  /** Sprint 6 agents (PRD 6.8–6.10). Null = agent failed/unavailable. */
  design: DesignOutput | null;
  reputation: ReputationOutput | null;
  seo: SeoOutput | null;
  /** Sprint 6: stored screenshot URLs (null = capture/storage unavailable). */
  screenshotUrls: ScreenshotUrls | null;
  /** Injected for determinism. */
  now: Date;
  /** Stages that overran their budget (RFL.QUEUE.8) — one low issue each. */
  stageTimeouts?: string[];
  /** PSI returned nothing for a live site (finding 12): flagged, not hidden. */
  psiUnmeasured?: boolean;
  /**
   * RFL.QUEUE.8a: why an enabled screenshot capture produced nothing —
   * score_breakdown only, never an issue (RFL.VERIFY.3 V2).
   */
  screenshotUnavailable?: string | null;
}

export interface AssembledScores {
  healthScore: number;
  starGrade: 1 | 2 | 3 | 4 | 5;
  sellabilityScore: number;
  issues: Issue[];
  badge: string | null;
  /** Effective platform (RFL.FIX.3d): Health's detection, or legacy_static. */
  platform: string | null;
  scoreBreakdown: Record<string, unknown>;
}

export interface ScoreInputs {
  business: Business;
  health: HealthOutput | null;
  conversion: ConversionOutput | null;
  presence: PresenceOutput | null;
  traffic: TrafficOutput | null;
  design: DesignOutput | null;
  reputation: ReputationOutput | null;
  seo: SeoOutput | null;
  now: Date;
  stageTimeouts?: string[];
  psiUnmeasured?: boolean;
  screenshotUnavailable?: string | null;
}

/** Last-Modified older than this (or absent) counts as "not maintained" for legacy_static. */
export const LEGACY_STATIC_STALE_DAYS = ISSUE_THRESHOLDS.lastModifiedStaleDays;

/**
 * RFL.FIX.3d (approved edit to scoring.ts): a `custom` page becomes
 * `legacy_static` (PLATFORM_SCORES 30) only when ALL of: no viewport meta,
 * legacy pre-CSS markup, and a Last-Modified older than 730 days or absent.
 * A modern hand-coded site keeps `custom` = 85. Pure; exported for tests.
 */
export function classifyPlatform(
  health: Pick<HealthOutput, "platform" | "legacy_markup" | "last_modified_at"> | null,
  conversion: Pick<ConversionOutput, "has_viewport_meta"> | null,
  now: Date,
): string | null {
  const detected = health?.platform ?? null;
  if (detected !== "custom" || health === null) return detected;
  if (!health.legacy_markup) return detected;
  if (conversion === null || conversion.has_viewport_meta) return detected;
  const lastModifiedMs = health.last_modified_at ? Date.parse(health.last_modified_at) : NaN;
  const stale =
    Number.isNaN(lastModifiedMs) ||
    (now.getTime() - lastModifiedMs) / 86_400_000 > LEGACY_STATIC_STALE_DAYS;
  return stale ? "legacy_static" : detected;
}

/** Pure score assembly — exported for the pipeline unit tests. */
export function assembleScores(inputs: ScoreInputs): AssembledScores {
  const { business, health, conversion, presence, traffic, design, reputation, seo, now } =
    inputs;
  const stageTimeouts = [...new Set(inputs.stageTimeouts ?? [])];
  const psiUnmeasured = inputs.psiUnmeasured === true;
  const currentYear = now.getFullYear();
  const platform = classifyPlatform(health, conversion, now);

  const healthResult = computeHealthScore({
    siteDead: false, // dead sites are routed by Filter and never reach Scorer
    psDesktopPerformance: health?.ps_performance ?? null,
    psMobilePerformance: health?.ps_mobile_performance ?? null,
    sslValid: health?.ssl_valid ?? false,
    httpsEnforced: health?.https_enforced ?? false,
    responseMs: health?.response_ms ?? null,
    hasViewportMeta: conversion?.has_viewport_meta ?? false,
    platform,
    hasVisiblePhone: conversion?.has_visible_phone ?? false,
    hasContactForm: conversion?.has_form ?? false,
    hasBookingLink: conversion?.has_booking ?? false,
    hasCtaAboveFold: conversion?.has_cta_above_fold ?? false,
    hasClickToCall: conversion?.has_tel_link ?? false,
    copyrightYear: health?.copyright_year ?? null,
    currentYear,
    hasRecentLastModified: health?.has_recent_last_modified ?? false,
    hasBrokenImages: false, // unmeasured in v1 (needs per-image fetches)
    // Sprint 6: the Design agent's modernity replaces the stub 50 (PRD 4.1).
    designScore: design?.modernity_0_100 ?? null,
  });

  const sellabilityResult = computeSellabilityScore({
    websiteKind: "real",
    healthScore: healthResult.score,
    reviewCount: business.review_count,
    googleRating: business.google_rating,
    hasPhone: business.phone !== null,
    isChain: business.is_chain === true,
    businessStatus: business.business_status,
    // RFL.FIX.3i: the healthy_site cap also needs mobile ≥ 60 (3i.1).
    mobilePerformance: health?.ps_mobile_performance ?? null,
  });

  // RFL.FIX.3k: the Last-Modified date becomes an age so issues stay pure.
  const lastModifiedMs = health?.last_modified_at ? Date.parse(health.last_modified_at) : NaN;
  const lastModifiedAgeDays = Number.isNaN(lastModifiedMs)
    ? null
    : Math.floor((now.getTime() - lastModifiedMs) / 86_400_000);

  const issues = buildIssues({
    psMobilePerformance: health?.ps_mobile_performance ?? null,
    // With PSI_DESKTOP off ps_performance is the mobile copy — one number
    // must not earn two bullets (RFL.FIX.3k "desktop off" test).
    psDesktopPerformance:
      health && health.desktop_measured === false ? null : (health?.ps_performance ?? null),
    psLcpMs: health?.ps_lcp_ms ?? null,
    psCls: health?.ps_cls ?? null,
    sslValid: health?.ssl_valid ?? null,
    httpsEnforced: health?.https_enforced ?? null,
    responseMs: health?.response_ms ?? null,
    platform,
    copyrightYear: health?.copyright_year ?? null,
    currentYear,
    lastModifiedAgeDays,
    hasVisiblePhone:
      (conversion?.has_visible_phone || conversion?.has_tel_link) ?? false,
    hasClickToCall: conversion?.has_tel_link ?? false,
    hasForm: conversion?.has_form ?? false,
    hasBooking: conversion?.has_booking ?? false,
    hasViewportMeta: conversion?.has_viewport_meta ?? false,
    hasSchemaMarkup: conversion?.has_schema_markup ?? false,
    hasCruxData: traffic?.has_crux_data ?? null,
    napConsistent: presence?.nap.nap_consistent ?? null,
    napAddressMatch: presence?.nap.nap_address_match ?? null,
    napGoogleStreet: presence?.nap.google_street ?? null,
    // Sprint 6 agents (null = agent didn't run — no bullet invented).
    designModernity: design?.modernity_0_100 ?? null,
    designFeelsLikeYear: design?.feels_like_year ?? null,
    // Places data is the source of truth; the Reputation agent only echoes
    // it. Null here means Places had nothing → "Unverified reputation".
    googleRating: reputation?.google_rating ?? business.google_rating ?? null,
    reviewCount: reputation?.review_count ?? business.review_count ?? null,
    seoLocalFitScore: seo?.summary.local_fit_score_1_5 ?? null,
    seoHasTitle: seo?.title.found ?? null,
    seoTitleValue: seo?.title.value ?? null,
    seoHasMetaDescription: seo?.meta_description.found ?? null,
    seoHasSitemap: seo?.has_sitemap ?? null,
  });

  // legacy_static scores like a builder but is not one — no "Builder site" tag.
  const badge =
    platform && platform !== "legacy_static" && isBuilderPlatform(platform)
      ? SPECIAL_CASE_BADGES.builderSite
      : null;

  // Finding 12: an unmeasured PSI is a neutral 50 in health — say so.
  if (psiUnmeasured) {
    issues.push({
      severity: "low",
      label: "Performance could not be measured",
      detail: "PageSpeed Insights returned nothing — performance scored neutral",
    });
  }
  // RFL.VERIFY.3 V2: screenshots are internal enrichment. A capture that
  // failed or overran is not a sales issue — it would reach the Analyst and
  // the rep as "Screenshot unavailable (net::ERR_…)". Its reason stays in
  // score_breakdown (stage_timeouts / screenshot_unavailable) and the log.
  for (const stage of stageTimeouts) {
    if (stage === "screenshot") continue;
    issues.push({
      severity: "low",
      label: `${stage} timed out`,
      detail: "Stage exceeded its budget and was skipped for this audit",
    });
  }

  return {
    healthScore: healthResult.score,
    // RFL.FIX.3i.1: failing the healthy_site rule caps the grade at 3★.
    starGrade: deriveStarGrade(healthResult.score, health?.ps_mobile_performance ?? null),
    sellabilityScore: sellabilityResult.score,
    issues,
    badge,
    platform,
    scoreBreakdown: {
      health: {
        ...healthResult.breakdown,
        ...(psiUnmeasured ? { psi_unmeasured: true } : {}),
      },
      ...(stageTimeouts.length > 0 ? { stage_timeouts: stageTimeouts } : {}),
      ...(inputs.screenshotUnavailable
        ? { screenshot_unavailable: inputs.screenshotUnavailable }
        : {}),
      sellability: sellabilityResult.breakdown,
      ...(badge ? { badge } : {}),
      ...(sellabilityResult.breakdown.chain ? { chain: true } : {}),
      ...(sellabilityResult.breakdown.capped
        ? { capped: sellabilityResult.breakdown.capped }
        : {}),
      agents: {
        health: health !== null,
        conversion: conversion !== null,
        presence: presence !== null,
        traffic: traffic !== null,
        design: design !== null,
        reputation: reputation !== null,
        seo: seo !== null,
      },
      // Sprint 6 agent findings ride the audit row (jsonb, no migration) so
      // the drawer's Audit tab can render them; the next audit's Reputation
      // velocity also reads its snapshot from here.
      v15_agents: {
        ...(design ? { design } : {}),
        ...(reputation ? { reputation } : {}),
        ...(seo ? { seo } : {}),
        // RFL-06: what Conversion and Presence measured now rides the audit
        // row too, so the Design Brief (brick 7) reads fields, not prose.
        ...(conversion
          ? {
              conversion: {
                cta_candidates: conversion.cta_candidates,
                booking_url: conversion.booking_url,
                visible_phone: conversion.visible_phone,
                has_tel_link: conversion.has_tel_link,
                has_form: conversion.has_form,
                has_cta_above_fold: conversion.has_cta_above_fold,
                cta_source: conversion.cta_source,
              },
            }
          : {}),
        ...(presence
          ? {
              presence: {
                social_links: presence.social_links,
                hours_completeness: presence.hours_completeness,
                gbp_photo_count: presence.gbp_photo_count,
                nap_consistent: presence.nap.nap_consistent,
                // RFL.FIX.3c: which half matched — null address = none shown.
                nap_phone_match: presence.nap.nap_phone_match,
                nap_address_match: presence.nap.nap_address_match,
              },
            }
          : {}),
      },
    },
  };
}

export interface ScorerOutput extends Record<string, unknown> {
  audit_id: string;
  health_score: number;
  star_grade: number;
  sellability_score: number;
  issue_count: number;
  badge: string | null;
}

export async function runScorer(
  ctx: ScorerContext,
): Promise<AgentResult<ScorerOutput>> {
  const startedAt = Date.now();
  try {
    const scores = assembleScores({
      business: ctx.business,
      health: ctx.health,
      conversion: ctx.conversion,
      presence: ctx.presence,
      traffic: ctx.traffic,
      design: ctx.design,
      reputation: ctx.reputation,
      seo: ctx.seo,
      now: ctx.now,
      ...(ctx.stageTimeouts ? { stageTimeouts: ctx.stageTimeouts } : {}),
      ...(ctx.psiUnmeasured !== undefined ? { psiUnmeasured: ctx.psiUnmeasured } : {}),
      ...(ctx.screenshotUnavailable ? { screenshotUnavailable: ctx.screenshotUnavailable } : {}),
    });
    const { health, conversion, presence, traffic, now } = ctx;

    const patch: UpdateAuditPatch = {
      ps_performance: health?.ps_performance ?? null,
      ps_mobile_performance: health?.ps_mobile_performance ?? null,
      ps_accessibility: health?.ps_accessibility ?? null,
      ps_seo: health?.ps_seo ?? null,
      ps_best_practices: health?.ps_best_practices ?? null,
      ps_lcp_ms: health?.ps_lcp_ms ?? null,
      ps_cls: health?.ps_cls ?? null,
      http_status: health?.http_status ?? null,
      ssl_valid: health?.ssl_valid ?? null,
      response_ms: health?.response_ms ?? null,
      platform: scores.platform,
      copyright_year: health?.copyright_year ?? null,
      has_phone:
        conversion === null
          ? null
          : conversion.has_visible_phone || conversion.has_tel_link,
      has_form: conversion?.has_form ?? null,
      has_booking: conversion?.has_booking ?? null,
      has_chat: conversion?.has_chat ?? null,
      has_viewport_meta: conversion?.has_viewport_meta ?? null,
      has_schema_markup: conversion?.has_schema_markup ?? null,
      gbp_photo_count: presence?.gbp_photo_count ?? null,
      has_crux_data: traffic?.has_crux_data ?? null,
      screenshot_desktop_url: ctx.screenshotUrls?.desktop_url ?? null,
      screenshot_mobile_url: ctx.screenshotUrls?.mobile_url ?? null,
      website_health_score: scores.healthScore,
      star_grade: scores.starGrade,
      sellability_score: scores.sellabilityScore,
      score_breakdown: scores.scoreBreakdown,
      issues: scores.issues,
      status: "completed",
      error_message: null,
      // RFL.VERIFY.3 V5: when the row is finalized, not the pipeline start
      // (`now`). The orchestrator re-stamps it once the last agent stored.
      completed_at: new Date().toISOString(),
    };
    await ctx.store.updateAudit(ctx.auditId, patch);

    return {
      agent: "scorer",
      status: "completed",
      output: {
        audit_id: ctx.auditId,
        health_score: scores.healthScore,
        star_grade: scores.starGrade,
        sellability_score: scores.sellabilityScore,
        issue_count: scores.issues.length,
        badge: scores.badge,
      },
      error: null,
      modelUsed: null, // deterministic math — no LLM, ever (PRD 6.7)
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - startedAt,
      guardrailPassed: true,
      guardrailNotes: null,
    };
  } catch (err) {
    return {
      agent: "scorer",
      status: "failed",
      output: null,
      error: err instanceof Error ? err.message : String(err),
      modelUsed: null,
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - startedAt,
      guardrailPassed: true,
      guardrailNotes: null,
    };
  }
}
