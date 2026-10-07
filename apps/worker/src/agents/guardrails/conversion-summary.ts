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

const JSON_LITERAL_RE = /^(true|false|null|\[\s*\]|\{\s*\})$/i;

/**
 * Element text worth quoting (RFL.FIX.3d): not a JSON literal — "false" and
 * "[]" occur in any page's scripts, so they passed the on-page check (Landers
 * `1a803f5a…`) — and at least 2 words unless it carries a digit.
 */
export function isQuotableEvidence(quote: string): boolean {
  const text = quote.trim();
  if (JSON_LITERAL_RE.test(text)) return false;
  return text.split(/\s+/).length >= 2 || /\d/.test(text);
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
      if (item.quote.trim().length > 0 && !isQuotableEvidence(item.quote)) {
        return {
          passed: false,
          notes: `evidence quote is not element text: "${item.quote.slice(0, 80)}"`,
        };
      }
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
