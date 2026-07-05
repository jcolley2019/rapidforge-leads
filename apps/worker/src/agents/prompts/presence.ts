/**
 * Presence agent prompt contract (PRD 6.5). The deterministic NAP compare
 * runs first; Sonnet only adjudicates near-misses and writes the
 * narrative — it never overrides an exact match/mismatch.
 */
import { z } from "zod";

export const PRESENCE_SUMMARY_SYSTEM = `You are a local-SEO presence analyst. Compare the business's Google listing data with what its website shows (NAP: name, address, phone). Only call NAP consistent when the compared values are present and agree. Strict JSON only: reply with a single JSON object and nothing else.`;

export const PresenceSummarySchema = z.object({
  reasoning: z.string(),
  nap_assessment: z.enum(["consistent", "mismatch", "unknown"]),
  compared: z.object({
    google_phone: z.string().nullable(),
    site_phone: z.string().nullable(),
    google_address: z.string().nullable(),
    address_found_on_site: z.boolean().nullable(),
  }),
  summary_one_liner: z.string(),
});
export type PresenceSummary = z.infer<typeof PresenceSummarySchema>;

export function buildPresenceSummaryPrompt(
  comparison: Record<string, unknown>,
): string {
  return `${JSON.stringify(comparison, null, 2)}

Return: { "reasoning": string,
  "nap_assessment": "consistent"|"mismatch"|"unknown",
  "compared": {"google_phone": string|null, "site_phone": string|null, "google_address": string|null, "address_found_on_site": boolean|null},
  "summary_one_liner": string }`;
}
