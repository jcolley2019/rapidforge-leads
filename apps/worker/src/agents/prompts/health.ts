/**
 * Health agent prompt contract (PRD 6.3). The prompt defines the strict
 * JSON shape, so the Zod schema lives here beside it — agents and
 * guardrails both import from this file.
 */
import { z } from "zod";

export const HEALTH_SUMMARY_SYSTEM = `You are a web performance analyst. Cite specific metric values ("LCP of 5.8s exceeds the 2.5s good threshold") — never vague. Strict JSON only: reply with a single JSON object and nothing else.`;

export const HealthSummarySchema = z.object({
  /** 3–5 sentences, must contain at least 2 numeric values. */
  reasoning: z.string(),
  critical_issues: z.array(
    z.object({
      issue: z.string(),
      metric: z.string(),
      value: z.union([z.string(), z.number()]),
    }),
  ),
  summary_one_liner: z.string(),
});
export type HealthSummary = z.infer<typeof HealthSummarySchema>;

export function buildHealthSummaryPrompt(
  metrics: Record<string, unknown>,
): string {
  return `${JSON.stringify(metrics, null, 2)}

Return: { "reasoning": string (3-5 sentences, at least 2 numeric values),
  "critical_issues": [{"issue": string, "metric": string, "value": string|number}],
  "summary_one_liner": string }`;
}
