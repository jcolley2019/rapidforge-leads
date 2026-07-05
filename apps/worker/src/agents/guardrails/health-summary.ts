/**
 * Health summary guardrails (PRD 6.3, pure functions — CLAUDE.md 6.2):
 * reject reasoning with fewer than 2 numeric values; reject empty
 * critical_issues when performance is below 50.
 */
import type { GuardrailResult } from "../../lib/ai";
import type { HealthSummary } from "../prompts/health";

export function countNumericValues(text: string): number {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).length;
}

export function makeHealthSummaryGuardrail(
  worstPerformance: number | null,
): (summary: HealthSummary) => GuardrailResult {
  return (summary) => {
    const numbers = countNumericValues(summary.reasoning);
    if (numbers < 2) {
      return {
        passed: false,
        notes: `reasoning cites ${numbers} numeric value(s); at least 2 required`,
      };
    }
    if (
      worstPerformance !== null &&
      worstPerformance < 50 &&
      summary.critical_issues.length === 0
    ) {
      return {
        passed: false,
        notes: `performance ${worstPerformance} < 50 but critical_issues is empty`,
      };
    }
    return { passed: true, notes: null };
  };
}
