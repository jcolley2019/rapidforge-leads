/**
 * Reputation agent prompt contract (PRD 6.9, GOOGLE-FIRST per the Sprint 6
 * Yelp decision). Deterministic signals — rating, review count, volume
 * band, cross-audit review velocity — are measured by the worker; Sonnet
 * writes the verdict narrative and extracts themes ONLY from review text it
 * is given (none in v1 — Places review text is not fetched), so themes must
 * stay empty and no quote may be invented.
 */
import { z } from "zod";

export const REPUTATION_SUMMARY_SYSTEM = `You are a local-business reputation analyst. You are given DETERMINISTIC measured signals (Google rating, review count, volume band, review velocity when known) and, when available, raw review text. Write a verdict narrative grounded ONLY in those signals. Echo volume_band exactly as provided — it is a measurement, not your judgment. Extract themes only from provided review text; when none is provided, themes must be an empty array. Any quote must be under 15 words and copied verbatim from provided review text. Strict JSON only: reply with a single JSON object and nothing else.`;

export const ReputationVerdictSchema = z.enum([
  "strong",
  "solid",
  "mixed",
  "weak",
  "unknown",
]);
export type ReputationVerdict = z.infer<typeof ReputationVerdictSchema>;

export const VolumeBandSchema = z.enum([
  "none",
  "low",
  "moderate",
  "high",
  "very_high",
]);
export type VolumeBand = z.infer<typeof VolumeBandSchema>;

export const ReputationSummarySchema = z.object({
  verdict: ReputationVerdictSchema,
  /** Must echo the measured band (guardrail-enforced). */
  volume_band: VolumeBandSchema,
  themes: z.array(
    z.object({
      theme: z.string(),
      /** Verbatim, <15 words, only from provided review text. */
      quote: z.string().nullable(),
    }),
  ),
  reasoning: z.string(),
});
export type ReputationSummary = z.infer<typeof ReputationSummarySchema>;

export function buildReputationSummaryPrompt(
  signals: Record<string, unknown>,
): string {
  return `${JSON.stringify(signals, null, 2)}

Return: { "verdict": "strong"|"solid"|"mixed"|"weak"|"unknown",
  "volume_band": exactly the provided volume_band,
  "themes": [{"theme": string, "quote": string|null (verbatim, <15 words)}] (empty when no review text is provided),
  "reasoning": string }`;
}
