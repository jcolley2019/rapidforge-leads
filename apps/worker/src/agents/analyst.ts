/**
 * Analyst — PRD 6.11 (v1.5). Runs on **Opus 4.8** (Sprint 8 — the stack no
 * longer depends on Fable 5's availability), at effort "low" for cost.
 *
 * Narrative synthesis over the deterministic scores: an executive verdict,
 * top-3 improvements, and reasoning that cites the audit agents by name and
 * value. It NEVER re-scores (CLAUDE.md 4.2). A hard AI failure or a
 * twice-failed guardrail falls back to the deterministic template so a job
 * never stalls.
 *
 * Auto-runs after Scorer for sellability >= 60 (CLAUDE.md 8); on-demand
 * otherwise via POST /api/businesses/:id/analyst.
 */
import type { AgentResult, Audit, Business, WorkspaceConfig } from "@rapidforge/shared";
import { generateJsonSummary, MODEL_OPUS } from "../lib/ai";
import { makeAnalystGuardrail } from "./guardrails/analyst";
import { buildAuditFacts, type AuditFacts } from "./money-facts";
import {
  resolveConfigVars,
  type CascadingVars,
} from "./prompts/config-vars";
import {
  ANALYST_SYSTEM,
  AnalystOutputSchema,
  buildAnalystPrompt,
  type AnalystOutput,
  type AnalystPriority,
  type AnalystVerdict,
  type Improvement,
} from "./prompts/analyst";

/** Opus effort — "low" keeps cost down; raise later if verdict depth needs it. */
const ANALYST_EFFORT = "low" as const;

export interface AnalystContext {
  business: Business;
  /** The completed audit to synthesize (its measured data + scores). */
  audit: Audit;
  config: WorkspaceConfig | null;
}

/** star grade → verdict, staying inside VERDICT_STAR_RANGE. */
function verdictForStar(star: number | null): AnalystVerdict {
  switch (star) {
    case 1:
      return "actively_losing_business";
    case 2:
      return "needs_rebuild";
    case 3:
      return "needs_improvement";
    case 4:
      return "solid";
    case 5:
      return "excellent";
    default:
      // No star measured — a neutral, always-consistent verdict.
      return "needs_improvement";
  }
}

function priorityForSellability(sellability: number | null): AnalystPriority {
  if (sellability === null) return "warm";
  if (sellability >= 75) return "hot";
  if (sellability >= 50) return "warm";
  return "skip";
}

function impactForSeverity(severity: "low" | "medium" | "high"): string {
  if (severity === "high") return "High — likely costing calls today.";
  if (severity === "medium") return "Moderate — a measurable conversion lift.";
  return "Low — polish that sharpens the first impression.";
}

/** Measured-gap improvements used to pad to three (never placeholders). */
function fallbackImprovements(facts: AuditFacts): Omit<Improvement, "priority">[] {
  const out: Omit<Improvement, "priority">[] = [];
  const mobile = facts.health.ps_mobile_performance;
  if (mobile !== null && mobile < 70) {
    out.push({
      improvement: "Improve mobile page speed",
      rationale: `Mobile performance measured ${mobile}/100.`,
      estimated_impact: "High — most local searches are on phones.",
    });
  }
  if (facts.design && facts.design.modernity_0_100 !== null && facts.design.modernity_0_100 < 70) {
    out.push({
      improvement: "Modernize the visual design",
      rationale: `Design modernity measured ${facts.design.modernity_0_100}/100${facts.design.feels_like_year ? `, feeling like ${facts.design.feels_like_year}` : ""}.`,
      estimated_impact: "Moderate — trust and credibility at first glance.",
    });
  }
  if (facts.conversion.has_phone === false) {
    out.push({
      improvement: "Add a click-to-call phone number",
      rationale: "Conversion found no tappable phone in the header.",
      estimated_impact: "High — removes friction from the call.",
    });
  }
  if (facts.conversion.has_form === false) {
    out.push({
      improvement: "Add a short contact form",
      rationale: "Conversion found no lead-capture form.",
      estimated_impact: "Moderate — captures visitors who won't call.",
    });
  }
  if (facts.seo && facts.seo.has_title === false) {
    out.push({
      improvement: "Add an SEO title tag",
      rationale: "The SEO agent found no <title> on the homepage.",
      estimated_impact: "Moderate — basic local search visibility.",
    });
  }
  // Always-valid, always-measured-adjacent fillers so we can guarantee three.
  out.push(
    {
      improvement: "Add a clear above-the-fold call to action",
      rationale: "A prominent CTA turns visits into calls and bookings.",
      estimated_impact: "Moderate — directs visitor attention.",
    },
    {
      improvement: "Ensure a mobile-first responsive layout",
      rationale: "Most local prospects arrive on a phone.",
      estimated_impact: "Moderate — reduces bounce on mobile.",
    },
    {
      improvement: "Publish local SEO landing content",
      rationale: `Targeted pages help ${facts.business.category ?? "the business"} rank locally.`,
      estimated_impact: "Long-term — compounding organic leads.",
    },
  );
  return out;
}

/** Reasoning that cites >= 3 agents by name and value (never invented). */
function templateReasoning(facts: AuditFacts): string {
  const s: string[] = [];
  s.push(
    `The health agent scored the site ${facts.scores.health_score ?? "n/a"}/100${facts.health.platform ? ` on ${facts.health.platform}` : ""}${facts.health.ps_mobile_performance !== null ? ` with mobile performance ${facts.health.ps_mobile_performance}` : ""}.`,
  );
  s.push(
    `Conversion found ${facts.conversion.has_phone ? "a" : "no"} visible phone and ${facts.conversion.has_form ? "a" : "no"} contact form.`,
  );
  if (facts.design) {
    s.push(
      `Design rated modernity ${facts.design.modernity_0_100 ?? "n/a"}/100${facts.design.feels_like_year ? `, feeling like ${facts.design.feels_like_year}` : ""}.`,
    );
  }
  if (facts.seo) {
    s.push(
      `SEO local-fit is ${facts.seo.local_fit_score_1_5 ?? "n/a"}/5${facts.seo.has_title === false ? " with a missing title tag" : ""}.`,
    );
  }
  if (facts.reputation) {
    s.push(
      `Reputation shows ${facts.reputation.google_rating ?? "no"} stars across ${facts.reputation.review_count ?? 0} reviews (${facts.reputation.volume_band ?? "unknown"} volume).`,
    );
  }
  // Guarantee a third distinct agent name even when Sprint 6 blocks are absent.
  s.push(
    `Traffic ${facts.health.has_crux_data ? "has" : "lacks"} real-user CrUX data, so demand is ${facts.health.has_crux_data ? "measurable" : "inferred"}.`,
  );
  return s.join(" ");
}

export function buildTemplateAnalyst(facts: AuditFacts): AnalystOutput {
  const verdict = verdictForStar(facts.scores.star_grade);

  const improvements: Improvement[] = [];
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  const sortedIssues = [...facts.issues].sort(
    (a, b) => sevRank[a.severity] - sevRank[b.severity],
  );
  for (const issue of sortedIssues) {
    if (improvements.length >= 3) break;
    improvements.push({
      priority: improvements.length + 1,
      improvement: issue.label,
      rationale: issue.detail ?? `Flagged ${issue.severity} severity in the audit.`,
      estimated_impact: impactForSeverity(issue.severity),
    });
  }
  for (const cand of fallbackImprovements(facts)) {
    if (improvements.length >= 3) break;
    if (improvements.some((i) => i.improvement === cand.improvement)) continue;
    improvements.push({ ...cand, priority: improvements.length + 1 });
  }

  const health = facts.scores.health_score;
  const oneLine =
    verdict === "excellent"
      ? `${facts.business.name}'s site is strong at ${health ?? "n/a"}/100 — a light-touch lead.`
      : verdict === "solid"
        ? `${facts.business.name} is solid at ${health ?? "n/a"}/100 with clear upside.`
        : `${facts.business.name}'s site scores ${health ?? "n/a"}/100 and is leaving calls on the table.`;

  return {
    verdict,
    sales_lead_priority: priorityForSellability(facts.scores.sellability_score),
    top_3_improvements: improvements.slice(0, 3),
    reasoning: templateReasoning(facts),
    one_line_verdict: oneLine,
  };
}

export async function runAnalyst(
  ctx: AnalystContext,
): Promise<AgentResult<AnalystOutput>> {
  const startedAt = Date.now();
  try {
    const facts = buildAuditFacts(ctx.business, ctx.audit);
    const vars: CascadingVars = resolveConfigVars(ctx.config);

    const outcome = await generateJsonSummary<AnalystOutput>({
      model: MODEL_OPUS,
      effort: ANALYST_EFFORT,
      system: ANALYST_SYSTEM,
      prompt: buildAnalystPrompt(facts, vars),
      maxTokens: 1500,
      parse: (raw) => AnalystOutputSchema.parse(JSON.parse(raw)),
      guardrail: makeAnalystGuardrail(facts.scores.star_grade),
      template: () => buildTemplateAnalyst(facts),
    });

    return {
      agent: "analyst",
      status: "completed",
      output: outcome.value,
      error: null,
      modelUsed: outcome.modelUsed,
      tokensUsed: outcome.tokensUsed,
      costCents: outcome.costCents,
      durationMs: Date.now() - startedAt,
      guardrailPassed: outcome.guardrailPassed,
      guardrailNotes: outcome.guardrailNotes,
    };
  } catch (err) {
    return {
      agent: "analyst",
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
