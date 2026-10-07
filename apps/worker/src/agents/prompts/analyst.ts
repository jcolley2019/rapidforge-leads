/**
 * Analyst prompt + contract — PRD 6.11 (Opus 4.8, effort low; RFL.AI.9a).
 *
 * Synthesizes the measured audit into an executive verdict for a salesperson.
 * The model explains and prioritizes; it NEVER re-scores (CLAUDE.md 4.2). The
 * strict-JSON reply is Zod-validated and guardrailed before it persists.
 */
import { z } from "zod";
import type { AuditFacts } from "../money-facts";
import { factsToPromptJson } from "../money-facts";
import { CONFIG_DEFAULTS, type CascadingVars } from "./config-vars";

export const AnalystVerdictSchema = z.enum([
  "actively_losing_business",
  "needs_rebuild",
  "needs_improvement",
  "solid",
  "excellent",
]);
export type AnalystVerdict = z.infer<typeof AnalystVerdictSchema>;

export const AnalystPrioritySchema = z.enum(["hot", "warm", "skip"]);
export type AnalystPriority = z.infer<typeof AnalystPrioritySchema>;

export const ImprovementSchema = z.object({
  priority: z.number().int(),
  improvement: z.string().min(1),
  rationale: z.string().min(1),
  estimated_impact: z.string().min(1),
});
export type Improvement = z.infer<typeof ImprovementSchema>;

export const AnalystOutputSchema = z.object({
  verdict: AnalystVerdictSchema,
  sales_lead_priority: AnalystPrioritySchema,
  top_3_improvements: z.array(ImprovementSchema).min(1),
  reasoning: z.string().min(1),
  one_line_verdict: z.string().min(1),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

/**
 * Star grade a verdict may accompany (PRD 6.11 guardrail: reject a verdict
 * inconsistent with the deterministic star grade — e.g. "excellent" at 2★).
 * Inclusive [min, max]. Ranges overlap so honest mid-grades aren't boxed in.
 */
export const VERDICT_STAR_RANGE: Record<AnalystVerdict, [number, number]> = {
  actively_losing_business: [1, 2],
  needs_rebuild: [1, 3],
  needs_improvement: [2, 4],
  solid: [3, 5],
  excellent: [4, 5],
};

/**
 * System prompt with the workspace voice (RFL.FIX.3h). {user_brand},
 * {user_location} and {sales_tone} come ONLY from the shared template
 * variables (config-vars.ts, CLAUDE.md 6.4) — a blank Settings field
 * resolves to its neutral default there, never to a literal placeholder.
 */
export function buildAnalystSystem(vars: CascadingVars): string {
  return `You are a senior website consultant synthesizing a completed audit into an executive verdict for a salesperson at ${vars.user_brand}, based in ${vars.user_location}, who will cold-call this business.

Write the verdict, improvements and one-liner in that salesperson's voice: ${vars.sales_tone}. They will read the one_line_verdict aloud.

You are given MEASURED data and COMPUTED scores. Do NOT re-score and do NOT invent numbers — explain and prioritize what was measured, citing specific findings by the agent that produced them (health, conversion, presence, traffic, design, reputation, seo) and by value.

Return STRICT JSON only (no prose, no markdown fences), exactly this shape:
{
  "verdict": "actively_losing_business" | "needs_rebuild" | "needs_improvement" | "solid" | "excellent",
  "sales_lead_priority": "hot" | "warm" | "skip",
  "top_3_improvements": [
    { "priority": 1, "improvement": "...", "rationale": "...", "estimated_impact": "..." },
    { "priority": 2, "improvement": "...", "rationale": "...", "estimated_impact": "..." },
    { "priority": 3, "improvement": "...", "rationale": "...", "estimated_impact": "..." }
  ],
  "reasoning": "5-8 sentences citing at least 3 agents by name and their measured values",
  "one_line_verdict": "20 words or fewer"
}

Rules:
- top_3_improvements MUST contain exactly 3 items, priority 1 (highest) to 3.
- reasoning MUST cite at least THREE agents by name (e.g. health, design, seo), each in a sentence that states a number that agent measured (a score, ms, count, year or rating). A sentence that names an agent without a number does not count as a citation.
- one_line_verdict MUST be 20 words or fewer.
- The verdict MUST be consistent with the star grade you are given (a 5★ site is not "actively_losing_business"; a 1★ site is not "excellent").`;
}

/** The system prompt as rendered with the neutral defaults (no Settings filled in). */
export const ANALYST_SYSTEM = buildAnalystSystem(CONFIG_DEFAULTS);

export function buildAnalystPrompt(
  facts: AuditFacts,
  vars: CascadingVars,
): string {
  return [
    `Business: ${facts.business.name}`,
    `Your offer to them: ${vars.your_offer}`,
    `Star grade (deterministic, 1-5): ${facts.scores.star_grade ?? "unknown"}`,
    `Health score (0-100): ${facts.scores.health_score ?? "unknown"}`,
    `Sellability score (0-100): ${facts.scores.sellability_score ?? "unknown"}`,
    `Audit agents that produced data: ${facts.agents_run.join(", ") || "none"}`,
    "",
    "Measured audit data (JSON):",
    factsToPromptJson(facts),
  ].join("\n");
}
