/**
 * Design Brief guardrails (CLAUDE.md 6.2, pure functions):
 *   - every review quote must be a VERBATIM substring of a review text held
 *     in places_details (never paraphrased, never invented)
 *   - tone_descriptors and services must be non-empty
 *   - the whole object must parse with DesignBriefSchema — otherwise the
 *     agent fails and nothing is written (no partial brief)
 */
import { DesignBriefSchema, type DesignBrief } from "@rapidforge/shared";
import type { GuardrailResult } from "../../lib/ai";

/** Whitespace-insensitive, case-sensitive containment (quotes keep casing). */
function squashSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function quoteIsVerbatim(quote: string, reviewTexts: readonly string[]): boolean {
  const needle = squashSpace(quote);
  if (needle.length === 0) return false;
  return reviewTexts.some((t) => squashSpace(t).includes(needle));
}

export function designBriefGuardrail(
  brief: DesignBrief,
  reviewTexts: readonly string[],
): GuardrailResult {
  const parsed = DesignBriefSchema.safeParse(brief);
  if (!parsed.success) {
    return {
      passed: false,
      notes: `Brief does not match DesignBriefSchema: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .slice(0, 3)
        .join("; ")}`,
    };
  }
  if (brief.tone_descriptors.length === 0) {
    return { passed: false, notes: "tone_descriptors is empty" };
  }
  if (brief.services.length === 0) {
    return { passed: false, notes: "services is empty" };
  }
  for (const quote of brief.review_quotes) {
    if (!quoteIsVerbatim(quote.text, reviewTexts)) {
      return {
        passed: false,
        notes: `review quote is not verbatim from places_details.reviews: "${quote.text.slice(0, 80)}"`,
      };
    }
  }
  return { passed: true, notes: null };
}
