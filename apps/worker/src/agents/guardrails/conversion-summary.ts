/**
 * Conversion summary guardrails (PRD 6.4, pure functions): reject
 * "general impression" evidence (quotes must literally appear in the
 * page) and reject a CTA verdict without quoted element text.
 */
import type { GuardrailResult } from "../../lib/ai";
import type { ConversionSummary } from "../prompts/conversion";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function makeConversionSummaryGuardrail(
  html: string,
): (summary: ConversionSummary) => GuardrailResult {
  const haystack = normalize(html);
  return (summary) => {
    if (summary.cta_strength !== "none") {
      const quoted = summary.evidence.filter((e) => e.quote.trim().length > 0);
      if (quoted.length === 0) {
        return {
          passed: false,
          notes: `cta_strength '${summary.cta_strength}' with no quoted element text`,
        };
      }
    }
    for (const item of summary.evidence) {
      const quote = normalize(item.quote);
      if (quote.length > 0 && !haystack.includes(quote)) {
        return {
          passed: false,
          notes: `evidence quote not found on the page: "${item.quote.slice(0, 80)}"`,
        };
      }
    }
    return { passed: true, notes: null };
  };
}
