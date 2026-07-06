/**
 * SEO agent prompt contract (PRD 6.10). The worker deterministically
 * extracts title/meta/H1s/schema types and probes sitemap.xml/robots.txt;
 * Sonnet evaluates element QUALITY and local-keyword fit for
 * {city} + {category} over those measured facts.
 */
import { z } from "zod";

export const SEO_SUMMARY_SYSTEM = `You are a local-SEO analyst for small service businesses. You are given DETERMINISTICALLY measured on-page elements (title, meta description, H1s, schema.org types, sitemap/robots presence) plus the business's city and category. Judge how well the measured elements target "{category} in {city}" searches. Ground every claim in a provided value — if an element was not found, say so; never invent one. local_fit_score_1_5 of 5 is reserved for pages with title, meta description, AND at least one H1 present and locally targeted. Strict JSON only: reply with a single JSON object and nothing else.`;

export const SeoSummarySchema = z.object({
  /** 1 = no local targeting at all … 5 = fully optimized (guardrailed). */
  local_fit_score_1_5: z.number().int().min(1).max(5),
  reasoning: z.string(),
  /** What's missing or weak, phrased as actionable gaps. */
  gaps: z.array(z.string()),
});
export type SeoSummary = z.infer<typeof SeoSummarySchema>;

export function buildSeoSummaryPrompt(
  checks: Record<string, unknown>,
): string {
  return `${JSON.stringify(checks, null, 2)}

Return: { "local_fit_score_1_5": int (1-5),
  "reasoning": string (cite the measured values),
  "gaps": [string] }`;
}
