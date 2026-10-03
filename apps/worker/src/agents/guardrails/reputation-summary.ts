/**
 * Reputation summary guardrails (PRD 6.9, pure functions):
 *   - reject a volume claim that contradicts the measured band — this
 *     subsumes the PRD's "reject volume 'high' under 50 reviews"
 *   - reject overlong theme quotes (must be <15 words)
 *   - reject any quote when no review text was provided (invention)
 *   - reject a quote that is not verbatim within the provided review text
 */
import type { GuardrailResult } from "../../lib/ai";
import type { ReputationSummary, VolumeBand } from "../prompts/reputation";

export const MAX_QUOTE_WORDS = 15;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * `reviewTexts`: the review texts handed to the model (RFL-06), or a
 * boolean for the legacy "any text available?" form.
 */
export function makeReputationSummaryGuardrail(
  measuredVolumeBand: VolumeBand,
  reviewTexts: readonly string[] | boolean,
): (summary: ReputationSummary) => GuardrailResult {
  const texts = Array.isArray(reviewTexts) ? reviewTexts : [];
  const reviewTextAvailable =
    typeof reviewTexts === "boolean" ? reviewTexts : texts.length > 0;
  const haystack = texts.map(squash);
  return (summary) => {
    if (summary.volume_band !== measuredVolumeBand) {
      return {
        passed: false,
        notes: `volume claim '${summary.volume_band}' contradicts the measured band '${measuredVolumeBand}'`,
      };
    }
    for (const item of summary.themes) {
      if (item.quote === null) continue;
      if (!reviewTextAvailable) {
        return {
          passed: false,
          notes: `quoted review text that was never provided: "${item.quote.slice(0, 80)}"`,
        };
      }
      if (wordCount(item.quote) >= MAX_QUOTE_WORDS) {
        return {
          passed: false,
          notes: `theme quote too long (>=${MAX_QUOTE_WORDS} words): "${item.quote.slice(0, 80)}"`,
        };
      }
      if (haystack.length > 0) {
        const needle = squash(item.quote);
        if (needle.length === 0 || !haystack.some((h) => h.includes(needle))) {
          return {
            passed: false,
            notes: `theme quote is not verbatim from the provided reviews: "${item.quote.slice(0, 80)}"`,
          };
        }
      }
    }
    return { passed: true, notes: null };
  };
}
