/**
 * Sales Summary prompt + contract — PRD 6.13 (Sonnet 4.6).
 *
 * A ~60-second cold-call talk track that opens with a SPECIFIC measured
 * observation and offers something tangible. Voice comes from the workspace's
 * {sales_tone} cascading variable (CLAUDE.md 6.4). Strict JSON, guardrailed.
 */
import { z } from "zod";
import type { AnalystOutput } from "./analyst";
import type { CascadingVars } from "./config-vars";
import type { AuditFacts } from "../money-facts";
import { factsToPromptJson } from "../money-facts";

/** Banned buzzwords (PRD 6.13) — checked whole-phrase, case-insensitive. */
export const BANNED_WORDS = [
  "synergy",
  "leverage",
  "unlock",
  "empower",
  "circle back",
  "touch base",
  "deep dive",
] as const;

export const ObjectionSchema = z.object({
  objection: z.string().min(1),
  response: z.string().min(1),
});
export type Objection = z.infer<typeof ObjectionSchema>;

export const SalesSummaryOutputSchema = z.object({
  opener: z.string().min(1),
  earned_observation: z.string().min(1),
  pain_hypothesis: z.string().min(1),
  offer: z.string().min(1),
  soft_close: z.string().min(1),
  full_talk_track: z.string().min(1),
  anticipated_objections: z.array(ObjectionSchema).min(1),
});
export type SalesSummaryOutput = z.infer<typeof SalesSummaryOutputSchema>;

export function buildSalesSummarySystem(vars: CascadingVars): string {
  return `You write cold-call talk tracks for a website-improvement consultant. The rep has about 60 seconds to earn permission to keep talking.

Voice: ${vars.sales_tone}.

Open with a SPECIFIC observation from the audit (a measured number, platform, or concrete gap) — never a generic compliment. Name one concrete problem and its business impact. Offer something tangible (a free mockup or a 5-minute walkthrough). Soft-close by asking permission to continue, not for a meeting. The spoken talk track must be 150 words or fewer.

Banned words (never use): synergy, leverage, unlock, empower, circle back, touch base, deep dive. No fake compliments.

Return STRICT JSON only (no prose, no markdown fences), exactly this shape:
{
  "opener": "<= 30 words",
  "earned_observation": "<= 40 words, cites a specific measured detail",
  "pain_hypothesis": "<= 30 words",
  "offer": "<= 30 words",
  "soft_close": "<= 20 words, asks permission",
  "full_talk_track": "<= 150 words spoken, natural to read aloud",
  "anticipated_objections": [
    { "objection": "...", "response": "..." },
    { "objection": "...", "response": "..." }
  ]
}
Provide 2 or 3 objections.`;
}

export function buildSalesSummaryPrompt(
  facts: AuditFacts,
  vars: CascadingVars,
  analyst: AnalystOutput | null,
): string {
  return [
    `Business: ${facts.business.name}`,
    `What we sell them: ${vars.your_offer}`,
    analyst
      ? `Analyst verdict: ${analyst.verdict} — ${analyst.one_line_verdict}`
      : "Analyst verdict: (not run)",
    "",
    "Measured audit data (JSON):",
    factsToPromptJson(facts),
  ].join("\n");
}
