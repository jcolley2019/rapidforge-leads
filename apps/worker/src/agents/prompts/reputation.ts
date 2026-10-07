/**
 * Reputation agent prompt contract (PRD 6.9, GOOGLE-FIRST per the Sprint 6
 * Yelp decision). Deterministic signals — rating, review count, volume
 * band, cross-audit review velocity — are measured by the worker; Sonnet
 * writes the verdict narrative and extracts themes ONLY from review text it
 * is given (none in v1 — Places review text is not fetched), so themes must
 * stay empty and no quote may be invented.
 */
import { z } from "zod";

export const REPUTATION_SUMMARY_SYSTEM = `You are a local-business reputation analyst. You are given DETERMINISTIC measured signals (Google rating, review count, volume band, review velocity when known) and, when available, raw review text. Write a verdict narrative grounded ONLY in those signals. Echo volume_band exactly as provided — it is a measurement, not your judgment. Extract themes only from provided review text; when none is provided, themes must be an empty array. Any quote must be 15 words or fewer and copied verbatim from provided review text. The verdict must agree with the rating: 4.6+ is strong, 4.2+ solid, 3.5+ mixed, below that weak — review volume qualifies your confidence, it does not demote the verdict. Strict JSON only: reply with a single JSON object and nothing else.`;

export const ReputationVerdictSchema = z.enum([
  "strong",
  "solid",
  "mixed",
  "weak",
  "unknown",
]);
export type ReputationVerdict = z.infer<typeof ReputationVerdictSchema>;

/**
 * The verdict band a Google rating alone supports (RFL.FIX.3f). Sentiment
 * is the rating; review volume qualifies confidence and never demotes.
 * Null rating = unknown. The template uses it directly; the guardrail
 * rejects a model verdict more than one band away from it.
 */
export function ratingBandFor(rating: number | null): ReputationVerdict {
  if (rating === null) return "unknown";
  if (rating >= 4.6) return "strong";
  if (rating >= 4.2) return "solid";
  if (rating >= 3.5) return "mixed";
  return "weak";
}

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
      /** Verbatim, 15 words or fewer, only from provided review text. */
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
  "themes": [{"theme": string, "quote": string|null (verbatim, 15 words or fewer)}] (empty when no review text is provided),
  "reasoning": string }`;
}
