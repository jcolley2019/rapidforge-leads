/**
 * Filter — PRD 6.2 (v1, deterministic; Haiku edge-pass deferred to
 * Sprint 3 — no ambiguity signals exist before the audit agents land).
 *
 * Deterministic checks first (filter before any spend, CLAUDE.md 8):
 * business_status OPERATIONAL · review count ≥ min_reviews · rating ≥
 * min_rating · is_chain exclusion (configurable, off by default).
 *
 * SPECIAL ROUTING IS LAW (CLAUDE.md 6.7):
 *   website_kind 'none'        → sellability-95 hot lead, never audited
 *   website_kind 'social_only' → same, badge "Social-only presence"
 *   website_kind 'real'        → probe URL; dead → health 10
 *                                "Site broken — urgent"
 *                                blocked (WAF / bot challenge, probe
 *                                "unknown") → never audited, neutral
 *                                provisional health, ONE low issue
 *
 * Live real sites get a provisional 'pending' audit row (neutral health)
 * so the results table sorts meaningfully until the Sprint 3 audit agents
 * replace it with measured scores.
 */
import {
  computeHealthScore,
  computeSellabilityScore,
  deriveStarGrade,
  SPECIAL_CASE_BADGES,
  type AgentResult,
  type Audit,
  type Business,
  type HealthScoreInput,
  type Issue,
  type Search,
  unverifiedReputationIssue,
} from "@rapidforge/shared";
import type { ProbeResult, WebProbe } from "../lib/probe";
import { parseSearchParams } from "../lib/search-params";
import type { DataStore } from "../store";

/**
 * The gate fields shared by every search mode's params (zip_radius and
 * map_draw both carry them) — the only params Filter reads.
 */
export interface FilterGateParams {
  min_reviews: number;
  min_rating: number;
  exclude_chains: boolean;
}

// ---------------------------------------------------------------------------
// Pure routing core — exported for unit tests
// ---------------------------------------------------------------------------

export interface FilterPlan {
  outcome:
    | "skip"
    | "hot_lead"
    | "dead_site"
    | "blocked"
    | "pending_audit"
    | "needs_probe";
  /** Skip reason (audits.error_message) — null otherwise. */
  reason: string | null;
  badge: string | null;
  sellability: number | null;
  health: number | null;
  star: number | null;
  breakdown: Record<string, unknown> | null;
  issues: Issue[];
  auditStatus: "completed" | "pending" | "skipped";
}

/** The one issue a bot-blocked audit carries (audit finding 4). */
export const BLOCKED_ISSUE_LABEL = "Site could not be audited (bot protection)";

/**
 * Bot protection answered instead of the site — blocked is neither dead nor
 * alive. Nothing about the page was measured, so: no page findings, no
 * dead-site badge, neutral provisional health (scoring.ts siteBlocked
 * branch), star unknown. Shared by Filter (probe "unknown") and the
 * orchestrator's homepage guard (probe passed, homepage fetch was blocked).
 */
export function planBlockedOutcome(
  business: Business,
  block: { note: string | null; blockedBy: string | null },
): FilterPlan {
  const unmeasured: HealthScoreInput = {
    siteDead: false,
    siteBlocked: true,
    psDesktopPerformance: null,
    psMobilePerformance: null,
    sslValid: false,
    httpsEnforced: false,
    responseMs: null,
    hasViewportMeta: false,
    platform: null,
    hasVisiblePhone: false,
    hasContactForm: false,
    hasBookingLink: false,
    hasCtaAboveFold: false,
    hasClickToCall: false,
    copyrightYear: null,
    currentYear: new Date().getFullYear(),
    hasRecentLastModified: false,
    hasBrokenImages: false,
    designScore: null,
  };
  const health = computeHealthScore(unmeasured);
  const sellability = computeSellabilityScore({
    websiteKind: "real",
    healthScore: health.score,
    reviewCount: business.review_count,
    googleRating: business.google_rating,
    hasPhone: business.phone !== null,
    isChain: business.is_chain === true,
    businessStatus: business.business_status,
    siteBlocked: true,
  });
  return {
    outcome: "blocked",
    reason: null,
    badge: null,
    sellability: sellability.score,
    health: health.score,
    star: null, // unmeasured — never derived from a placeholder
    breakdown: {
      health: health.breakdown,
      sellability: sellability.breakdown,
      blocked_by: block.blockedBy,
      ...(sellability.breakdown.chain ? { chain: true } : {}),
    },
    issues: withReputationIssue(business, [
      {
        severity: "low",
        label: BLOCKED_ISSUE_LABEL,
        detail: block.note ?? "Bot protection answered instead of the site",
      },
    ]),
    auditStatus: "completed",
  };
}

/** Appends the "Unverified reputation" issue when Places had no rating data. */
function withReputationIssue(business: Business, issues: Issue[]): Issue[] {
  const unverified = unverifiedReputationIssue(
    business.google_rating,
    business.review_count,
  );
  return unverified ? [...issues, unverified] : issues;
}

/** PRD 6.2 deterministic gates. Returns a skip reason or null (pass). */
export function evaluateGates(
  business: Business,
  params: FilterGateParams,
): string | null {
  // Missing business_status is unknown, never invented (CLAUDE.md 6.3) —
  // only an explicit non-OPERATIONAL status skips.
  if (
    business.business_status !== null &&
    business.business_status !== "OPERATIONAL"
  ) {
    return `Business status is ${business.business_status}`;
  }
  // Null reputation is UNKNOWN (finding 8): it passes the gates — the audit
  // carries an "Unverified reputation" issue instead of being skipped.
  if (business.review_count !== null && business.review_count < params.min_reviews) {
    return `Only ${business.review_count} reviews (minimum ${params.min_reviews})`;
  }
  if (
    params.min_rating > 0 &&
    business.google_rating !== null &&
    business.google_rating < params.min_rating
  ) {
    return `Rating ${business.google_rating} below minimum ${params.min_rating}`;
  }
  if (params.exclude_chains && business.is_chain === true) {
    return "Chain business excluded by search settings";
  }
  return null;
}

/**
 * Full deterministic routing. For real/unknown website kinds a probe
 * result is required — pass null to learn that ('needs_probe'), probe,
 * then call again. Pure both times.
 */
export function planFilterOutcome(
  business: Business,
  params: FilterGateParams,
  probe: ProbeResult | null,
): FilterPlan {
  const skipReason = evaluateGates(business, params);
  if (skipReason !== null) {
    return {
      outcome: "skip",
      reason: skipReason,
      badge: null,
      sellability: null,
      health: null,
      star: null,
      breakdown: null,
      issues: [],
      auditStatus: "skipped",
    };
  }

  const kind = business.website_kind ?? "unknown";

  if (kind === "none" || kind === "social_only") {
    const result = computeSellabilityScore({
      websiteKind: kind,
      healthScore: null,
      reviewCount: business.review_count,
      googleRating: business.google_rating,
      hasPhone: business.phone !== null,
      isChain: business.is_chain === true,
      businessStatus: business.business_status,
    });
    const badge =
      kind === "social_only"
        ? SPECIAL_CASE_BADGES.socialOnly
        : (result.badge ?? SPECIAL_CASE_BADGES.noWebsite);
    return {
      outcome: "hot_lead",
      reason: null,
      badge,
      sellability: result.score,
      health: null, // never audited — health stays null (PRD 4.4)
      star: null,
      breakdown: { ...result.breakdown, badge },
      issues: withReputationIssue(business, [
        {
          severity: "high",
          label: badge,
          detail:
            kind === "social_only"
              ? `Only web presence is ${business.website_url ?? "a social profile"}`
              : "No website in Google Places data",
        },
      ]),
      auditStatus: "completed",
    };
  }

  // 'real' or 'unknown' → liveness decides the route.
  if (probe === null) {
    return {
      outcome: "needs_probe",
      reason: null,
      badge: null,
      sellability: null,
      health: null,
      star: null,
      breakdown: null,
      issues: [],
      auditStatus: "pending",
    };
  }

  if (probe.alive === "unknown") {
    return planBlockedOutcome(business, probe);
  }

  if (probe.alive === "no") {
    const health = computeHealthScore({
      siteDead: true,
      psDesktopPerformance: null,
      psMobilePerformance: null,
      sslValid: false,
      httpsEnforced: false,
      responseMs: probe.responseMs,
      hasViewportMeta: false,
      platform: null,
      hasVisiblePhone: false,
      hasContactForm: false,
      hasBookingLink: false,
      hasCtaAboveFold: false,
      hasClickToCall: false,
      copyrightYear: null,
      currentYear: new Date().getFullYear(),
      hasRecentLastModified: false,
      hasBrokenImages: false,
      designScore: null,
    });
    const sellability = computeSellabilityScore({
      websiteKind: "real",
      healthScore: health.score,
      reviewCount: business.review_count,
      googleRating: business.google_rating,
      hasPhone: business.phone !== null,
      isChain: business.is_chain === true,
      businessStatus: business.business_status,
    });
    const badge = sellability.badge ?? SPECIAL_CASE_BADGES.deadSite;
    return {
      outcome: "dead_site",
      reason: null,
      badge,
      sellability: sellability.score,
      health: health.score,
      star: deriveStarGrade(health.score),
      breakdown: {
        health: health.breakdown,
        sellability: sellability.breakdown,
        badge,
        ...(sellability.breakdown.chain ? { chain: true } : {}),
      },
      issues: withReputationIssue(business, [
        {
          severity: "high",
          label: badge,
          detail: probe.note ?? "Site did not respond",
        },
      ]),
      auditStatus: "completed",
    };
  }

  // Live real site — full audit lands Sprint 3. Provisional sellability
  // (neutral health) keeps the results table sortable; marked as such.
  const provisional = computeSellabilityScore({
    websiteKind: "real",
    healthScore: null,
    reviewCount: business.review_count,
    googleRating: business.google_rating,
    hasPhone: business.phone !== null,
    isChain: business.is_chain === true,
    businessStatus: business.business_status,
  });
  return {
    outcome: "pending_audit",
    reason: null,
    badge: null,
    sellability: provisional.score,
    health: null,
    star: null,
    breakdown: { ...provisional.breakdown, provisional: true },
    issues: [],
    auditStatus: "pending",
  };
}

// ---------------------------------------------------------------------------
// Filter run — probes when needed, persists the audit row
// ---------------------------------------------------------------------------

export interface FilterContext {
  store: DataStore;
  probe: WebProbe;
  search: Search;
  business: Business;
  jobId: string | null;
  /**
   * Latest completed audit within the 30-day cache window (PRD 5.5), or
   * null. When present, real-site businesses reuse it — no probe, no
   * audit pipeline, no new audit row.
   */
  cachedAudit: Audit | null;
}

export interface FilterOutput extends Record<string, unknown> {
  outcome: FilterPlan["outcome"] | "cache_hit";
  audit_id: string;
  sellability: number | null;
  health: number | null;
  badge: string | null;
  reason: string | null;
}

export async function runFilter(
  ctx: FilterContext,
): Promise<AgentResult<FilterOutput>> {
  const { store, probe, search, business } = ctx;
  const startedAt = Date.now();

  try {
    const params = parseSearchParams(search);

    let plan = planFilterOutcome(business, params, null);
    let probeResult: ProbeResult | null = null;
    if (plan.outcome === "needs_probe") {
      // 30-day audit cache (PRD 5.5): a fresh completed audit short-
      // circuits the probe AND the audit pipeline — reuse it as-is.
      if (ctx.cachedAudit) {
        const cached = ctx.cachedAudit;
        await store.setLatestAudit(search.id, business.id, cached.id);
        return {
          agent: "filter",
          status: "completed",
          output: {
            outcome: "cache_hit",
            audit_id: cached.id,
            sellability: cached.sellability_score,
            health: cached.website_health_score,
            badge:
              ((cached.score_breakdown as { badge?: string } | null)?.badge ??
                null),
            reason: "Reused completed audit within the 30-day cache window",
          },
          error: null,
          modelUsed: null,
          tokensUsed: 0,
          costCents: 0,
          durationMs: Date.now() - startedAt,
          guardrailPassed: true,
          guardrailNotes: null,
        };
      }
      probeResult = await probe.probe(business.website_url ?? "");
      plan = planFilterOutcome(business, params, probeResult);
    }

    const completed = plan.auditStatus !== "pending";
    const audit = await store.insertAudit({
      workspace_id: search.workspace_id,
      business_id: business.id,
      website_url: business.website_url,
      http_status: probeResult?.httpStatus ?? null,
      response_ms: probeResult?.responseMs ?? null,
      ssl_valid: probeResult?.sslValid ?? null,
      website_health_score: plan.health,
      star_grade: plan.star,
      sellability_score: plan.sellability,
      score_breakdown: plan.breakdown,
      issues: plan.issues,
      status: plan.auditStatus,
      error_message: plan.reason,
      completed_at: completed ? new Date().toISOString() : null,
      ...(plan.outcome === "blocked" ? { provisional: true as const } : {}),
    });
    await store.setLatestAudit(search.id, business.id, audit.id);

    return {
      agent: "filter",
      status: "completed",
      output: {
        outcome: plan.outcome,
        audit_id: audit.id,
        sellability: plan.sellability,
        health: plan.health,
        badge: plan.badge,
        reason: plan.reason,
      },
      error: null,
      modelUsed: null, // deterministic path only in Sprint 2
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - startedAt,
      guardrailPassed: true,
      guardrailNotes: null,
    };
  } catch (err) {
    return {
      agent: "filter",
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
