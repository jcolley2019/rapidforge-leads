/**
 * Sales Summary — PRD 6.13 (v1.5, Sonnet 5.5 at effort low).
 *
 * A ~60-second cold-call talk track + objection handling, opening with a
 * SPECIFIC measured observation. On-demand from the lead drawer. Voice, brand
 * and location come from {sales_tone}/{user_brand}/{user_location} via the
 * shared cascading-variable resolver (RFL.FIX.3h). A hard AI
 * failure or twice-failed guardrail falls back to a deterministic template.
 */
import type { AgentResult, Audit, Business, WorkspaceConfig } from "@rapidforge/shared";
import { generateJsonSummary, MODEL_SONNET } from "../lib/ai";
import { salesSummaryGuardrail } from "./guardrails/sales-summary";
import { buildAuditFacts, type AuditFacts } from "./money-facts";
import { AnalystOutputSchema, type AnalystOutput } from "./prompts/analyst";
import { resolveConfigVars, type CascadingVars } from "./prompts/config-vars";
import {
  buildSalesSummaryPrompt,
  buildSalesSummarySystem,
  SalesSummaryOutputSchema,
  type SalesSummaryOutput,
} from "./prompts/sales-summary";

export interface SalesSummaryContext {
  business: Business;
  audit: Audit;
  config: WorkspaceConfig | null;
  /** Budget signal: the job stage (RFL.QUEUE.8) or the on-demand route (RFL.FIX.3i). */
  signal?: AbortSignal;
}

/** Sonnet 5.5 effort — voice + specificity hold at "low" (audit §e). */
export const SALES_SUMMARY_EFFORT = "low" as const;

/** The Analyst verdict persisted on the audit, if it ran (best-effort). */
function analystFrom(audit: Audit): AnalystOutput | null {
  if (audit.analyst_output === null) return null;
  const parsed = AnalystOutputSchema.safeParse(audit.analyst_output);
  return parsed.success ? parsed.data : null;
}

/** The single most concrete measured problem — always carries a number/term. */
function concreteObservation(facts: AuditFacts): string {
  const mobile = facts.health.ps_mobile_performance;
  if (mobile !== null && mobile < 70) {
    return `your homepage scores ${mobile} out of 100 for mobile speed, so it feels slow on a phone`;
  }
  if (
    facts.design &&
    facts.design.modernity_0_100 !== null &&
    facts.design.modernity_0_100 < 70
  ) {
    return `your site's design scores ${facts.design.modernity_0_100} out of 100 and reads a few years dated`;
  }
  if (facts.conversion.has_phone === false) {
    return "there's no tap-to-call button on your homepage, so phone visitors can't call in one tap";
  }
  const health = facts.scores.health_score;
  return `your website scores ${health ?? "low"} out of 100 on our audit`;
}

export function buildTemplateSalesSummary(
  facts: AuditFacts,
): SalesSummaryOutput {
  const name = facts.business.name;
  const category = facts.business.category ?? "businesses";
  const observation = concreteObservation(facts);

  const opener = `Hi, is this ${name}? I'll keep this quick — I build and fix websites for local ${category}.`;
  const earned = `I ran a fast audit of your site and noticed ${observation}.`;
  const pain =
    "That probably costs you calls from people who look you up on their phone and give up.";
  const offer =
    "I'd put together a free before-and-after mockup so you can see the difference — no charge, no obligation.";
  const softClose = "Mind if I text or email it over?";

  return {
    opener,
    earned_observation: earned,
    pain_hypothesis: pain,
    offer,
    soft_close: softClose,
    full_talk_track: `${opener} ${earned} ${pain} ${offer} ${softClose}`,
    anticipated_objections: [
      {
        objection: "I already have a website.",
        response:
          "For sure — I'm not saying replace it, just showing what a few targeted fixes would change.",
      },
      {
        objection: "I'm not interested right now.",
        response:
          "No problem at all — want me to send the free mockup anyway so it's there when you need it?",
      },
    ],
  };
}

export async function runSalesSummary(
  ctx: SalesSummaryContext,
): Promise<AgentResult<SalesSummaryOutput>> {
  const startedAt = Date.now();
  try {
    const facts = buildAuditFacts(ctx.business, ctx.audit);
    const vars: CascadingVars = resolveConfigVars(ctx.config);
    const analyst = analystFrom(ctx.audit);

    const outcome = await generateJsonSummary<SalesSummaryOutput>({
      model: MODEL_SONNET,
      effort: SALES_SUMMARY_EFFORT,
      system: buildSalesSummarySystem(vars),
      prompt: buildSalesSummaryPrompt(facts, vars, analyst),
      maxTokens: 1200,
      schema: SalesSummaryOutputSchema,
      guardrail: salesSummaryGuardrail,
      template: () => buildTemplateSalesSummary(facts),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      agent: "sales-summary",
      status: "completed",
      output: outcome.value,
      error: null,
      modelUsed: outcome.modelUsed,
      tokensUsed: outcome.tokensUsed,
      costCents: outcome.costCents,
      costMicrocents: outcome.costMicrocents,
      durationMs: Date.now() - startedAt,
      guardrailPassed: outcome.guardrailPassed,
      guardrailNotes: outcome.guardrailNotes,
    };
  } catch (err) {
    return {
      agent: "sales-summary",
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
