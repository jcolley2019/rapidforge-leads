/**
 * Conversion agent prompt contract (PRD 6.4). Sonnet evaluates CTA
 * strength over the DETERMINISTICALLY parsed signals — evidence must be
 * exact quoted element text, never a general impression.
 */
import { z } from "zod";

export const CONVERSION_SUMMARY_SYSTEM = `You are a conversion-rate analyst for local service businesses. Evaluate how easy this homepage makes it to contact or book. Every claim must quote exact element text from the provided data as evidence — never a general impression. Strict JSON only: reply with a single JSON object and nothing else.`;

export const ConversionSummarySchema = z.object({
  reasoning: z.string(),
  cta_strength: z.enum(["strong", "weak", "none"]),
  evidence: z.array(
    z.object({
      element: z.string(),
      quote: z.string(),
    }),
  ),
  summary_one_liner: z.string(),
});
export type ConversionSummary = z.infer<typeof ConversionSummarySchema>;

export function buildConversionSummaryPrompt(
  signals: Record<string, unknown>,
): string {
  return `${JSON.stringify(signals, null, 2)}

Return: { "reasoning": string,
  "cta_strength": "strong"|"weak"|"none",
  "evidence": [{"element": string, "quote": string (exact text from the page)}],
  "summary_one_liner": string }`;
}
