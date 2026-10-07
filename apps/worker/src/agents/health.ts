/**
 * Health — PRD 6.3 (v1, deterministic + Haiku narration / template).
 *
 * The orchestrator hands this agent the already-fetched homepage and the
 * mobile+desktop PSI runs (fetched ONCE per business, shared with
 * Traffic). Everything measurable is measured in code — PSI categories,
 * Core Web Vitals, SSL/HTTPS, response time, platform fingerprint,
 * copyright year — and the model (or its deterministic template stand-in
 * when ANTHROPIC_API_KEY is absent) only interprets those facts
 * (CLAUDE.md 4.2: deterministic before AI).
 */
import type { AgentResult, Business } from "@rapidforge/shared";
import { generateJsonSummary, MODEL_HAIKU } from "../lib/ai";
import {
  detectPlatform,
  extractCopyrightYear,
  extractLastModified,
  hasLegacyMarkup,
  hasRecentLastModified,
  type PlatformKey,
} from "../lib/platform";
import type { PsiMetrics } from "../lib/psi";
import type { FetchedSite } from "../lib/site";
import { makeHealthSummaryGuardrail } from "./guardrails/health-summary";
import {
  buildHealthSummaryPrompt,
  HEALTH_SUMMARY_SYSTEM,
  HealthSummarySchema,
  type HealthSummary,
} from "./prompts/health";

export interface HealthContext {
  /** Stage budget signal (RFL.QUEUE.8) — cancels the AI request. */
  signal?: AbortSignal;
  business: Business;
  site: FetchedSite | null;
  psiDesktop: PsiMetrics | null;
  psiMobile: PsiMetrics | null;
  /**
   * True only when a real desktop PSI run happened (PSI_DESKTOP=true).
   * The orchestrator copies the mobile run into `psiDesktop` otherwise, so
   * without this flag the template would narrate a measurement that was
   * never taken (RFL.FIX.3e). Omitted = inferred from the two runs being
   * different objects.
   */
  desktopMeasured?: boolean;
  /** Injected for determinism — copyright/freshness math needs "now". */
  now: Date;
}

/** Deterministic measurements — every field is a fact or null (unknown). */
export interface HealthMeasurements extends Record<string, unknown> {
  ps_performance: number | null;
  ps_mobile_performance: number | null;
  /** False = `ps_performance` is a copy of the mobile run, not a desktop measurement. */
  desktop_measured: boolean;
  ps_accessibility: number | null;
  ps_seo: number | null;
  ps_best_practices: number | null;
  /** Mobile LCP — the worst case is the one that costs customers. */
  ps_lcp_ms: number | null;
  ps_cls: number | null;
  ps_tbt_ms: number | null;
  has_crux_data: boolean | null;
  http_status: number | null;
  response_ms: number | null;
  ssl_valid: boolean | null;
  https_enforced: boolean | null;
  platform: PlatformKey | null;
  copyright_year: number | null;
  has_recent_last_modified: boolean;
  /** Last-Modified header as ISO; null = absent/unparseable (RFL.FIX.3k). */
  last_modified_at: string | null;
  /** Pre-CSS markup fingerprints present (RFL.FIX.3d legacy_static input). */
  legacy_markup: boolean;
}

export interface HealthOutput extends HealthMeasurements {
  summary: HealthSummary;
}

/** Pure measurement pass — exported for unit tests. */
export function measureHealth(ctx: HealthContext): HealthMeasurements {
  const { business, site, psiDesktop, psiMobile, now } = ctx;
  const psiAny = psiMobile ?? psiDesktop;
  const desktopMeasured =
    ctx.desktopMeasured ?? (psiDesktop !== null && psiDesktop !== psiMobile);
  return {
    ps_performance: psiDesktop?.performance ?? null,
    ps_mobile_performance: psiMobile?.performance ?? null,
    desktop_measured: desktopMeasured,
    ps_accessibility: psiMobile?.accessibility ?? psiDesktop?.accessibility ?? null,
    ps_seo: psiMobile?.seo ?? psiDesktop?.seo ?? null,
    ps_best_practices:
      psiMobile?.bestPractices ?? psiDesktop?.bestPractices ?? null,
    ps_lcp_ms: psiMobile?.lcpMs ?? psiDesktop?.lcpMs ?? null,
    ps_cls: psiMobile?.cls ?? psiDesktop?.cls ?? null,
    ps_tbt_ms: psiMobile?.tbtMs ?? psiDesktop?.tbtMs ?? null,
    has_crux_data:
      psiAny === null
        ? null
        : Boolean(psiMobile?.hasCruxData || psiDesktop?.hasCruxData),
    http_status: site?.httpStatus ?? null,
    response_ms: site?.responseMs ?? null,
    ssl_valid: site?.sslValid ?? null,
    https_enforced: site === null ? null : site.finalUrl.startsWith("https://"),
    platform: site
      ? detectPlatform({
          url: site.finalUrl || business.website_url || "",
          html: site.html,
          headers: site.headers,
        })
      : null,
    copyright_year: site
      ? extractCopyrightYear(site.html, now.getFullYear())
      : null,
    has_recent_last_modified: site
      ? hasRecentLastModified(site.headers, now)
      : false,
    last_modified_at: site ? extractLastModified(site.headers) : null,
    legacy_markup: site ? hasLegacyMarkup(site.html) : false,
  };
}

/**
 * Deterministic template summary — used when ANTHROPIC_API_KEY is absent
 * and as the terminal fallback. Always cites at least two numeric values
 * so it satisfies the same guardrail the model must pass.
 */
export function buildTemplateHealthSummary(
  m: HealthMeasurements,
): HealthSummary {
  const sentences: string[] = [];
  if (m.ps_mobile_performance !== null && !m.desktop_measured) {
    sentences.push(
      `PSI mobile performance is ${m.ps_mobile_performance}/100 (desktop not measured).`,
    );
  } else if (m.ps_mobile_performance !== null && m.ps_performance !== null) {
    sentences.push(
      `PSI mobile performance is ${m.ps_mobile_performance}/100 and desktop is ${m.ps_performance}/100.`,
    );
  } else {
    sentences.push(
      `PSI returned data for ${[m.ps_mobile_performance, m.ps_performance].filter((v) => v !== null).length} of 2 strategies.`,
    );
  }
  if (m.ps_lcp_ms !== null) {
    const lcpS = (m.ps_lcp_ms / 1000).toFixed(1);
    sentences.push(
      `Mobile LCP of ${lcpS}s ${m.ps_lcp_ms <= 2500 ? "meets" : "exceeds"} the 2.5s good threshold.`,
    );
  }
  if (m.response_ms !== null) {
    sentences.push(`The server responded in ${m.response_ms}ms.`);
  }
  if (m.platform !== null) {
    sentences.push(`Detected platform: ${m.platform}.`);
  }
  if (m.copyright_year !== null) {
    sentences.push(`Footer copyright year is ${m.copyright_year}.`);
  }

  const critical: HealthSummary["critical_issues"] = [];
  if (m.ps_mobile_performance !== null && m.ps_mobile_performance < 50) {
    critical.push({
      issue: "Poor mobile performance",
      metric: "ps_mobile_performance",
      value: m.ps_mobile_performance,
    });
  }
  if (m.ps_lcp_ms !== null && m.ps_lcp_ms > 4000) {
    critical.push({
      issue: "Very slow largest contentful paint",
      metric: "ps_lcp_ms",
      value: m.ps_lcp_ms,
    });
  }
  if (m.ssl_valid === false) {
    critical.push({
      issue: "No valid SSL",
      metric: "ssl_valid",
      value: "false",
    });
  }
  if (m.response_ms !== null && m.response_ms >= 2000) {
    critical.push({
      issue: "Slow server response",
      metric: "response_ms",
      value: m.response_ms,
    });
  }

  const worst = m.ps_mobile_performance ?? m.ps_performance;
  const tier =
    worst === null
      ? "unmeasured"
      : worst >= 80
        ? "healthy"
        : worst >= 50
          ? "middling"
          : "poor";
  return {
    reasoning: sentences.join(" "),
    critical_issues: critical,
    summary_one_liner:
      worst === null
        ? `Site performance is unmeasured; ${critical.length} critical issue(s) found by direct checks.`
        : `Site is ${tier}: mobile performance ${m.ps_mobile_performance ?? "n/a"}/100 with ${critical.length} critical issue(s).`,
  };
}

export async function runHealth(
  ctx: HealthContext,
): Promise<AgentResult<HealthOutput>> {
  const startedAt = Date.now();
  try {
    const measurements = measureHealth(ctx);
    const worst = [measurements.ps_mobile_performance, measurements.ps_performance]
      .filter((v): v is number => v !== null)
      .reduce<number | null>((min, v) => (min === null || v < min ? v : min), null);

    const summary = await generateJsonSummary({
      model: MODEL_HAIKU,
      kind: "narration",
      agent: "health",
      system: HEALTH_SUMMARY_SYSTEM,
      prompt: buildHealthSummaryPrompt(measurements),
      schema: HealthSummarySchema,
      guardrail: makeHealthSummaryGuardrail(worst),
      template: () => buildTemplateHealthSummary(measurements),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      agent: "health",
      status: "completed",
      output: { ...measurements, summary: summary.value },
      error: null,
      modelUsed: summary.modelUsed,
      tokensUsed: summary.tokensUsed,
      costCents: summary.costCents,
      costMicrocents: summary.costMicrocents,
      durationMs: Date.now() - startedAt,
      guardrailPassed: summary.guardrailPassed,
      guardrailNotes: summary.guardrailNotes,
    };
  } catch (err) {
    return {
      agent: "health",
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
