/**
 * Reputation summary guardrails (PRD 6.9, pure functions):
 *   - reject a volume claim that contradicts the measured band — this
 *     subsumes the PRD's "reject volume 'high' under 50 reviews"
 *   - reject overlong theme quotes (must be 15 words or fewer)
 *   - reject any quote when no review text was provided (invention)
 *   - reject a quote that is not verbatim within the provided review text
 *   - reject a verdict more than one band away from what the rating
 *     supports (RFL.FIX.3f — "weak" for 4.9★ is a contradiction)
 */
import type { GuardrailResult } from "../../lib/ai";
import {
  ratingBandFor,
  type ReputationSummary,
  type ReputationVerdict,
  type VolumeBand,
} from "../prompts/reputation";

export const MAX_QUOTE_WORDS = 15;

/** Verdict ladder; "unknown" has no rung (distance = infinite). */
const VERDICT_RANK: Record<Exclude<ReputationVerdict, "unknown">, number> = {
  strong: 0,
  solid: 1,
  mixed: 2,
  weak: 3,
};

export function verdictDistance(
  a: ReputationVerdict,
  b: ReputationVerdict,
): number {
  if (a === "unknown" || b === "unknown") return a === b ? 0 : Infinity;
  return Math.abs(VERDICT_RANK[a] - VERDICT_RANK[b]);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * `reviewTexts`: the review texts handed to the model (RFL-06), or a
 * boolean for the legacy "any text available?" form.
 * `rating`: the measured Google rating; omitted/null = no verdict check.
 */
export function makeReputationSummaryGuardrail(
  measuredVolumeBand: VolumeBand,
  reviewTexts: readonly string[] | boolean,
  rating: number | null = null,
): (summary: ReputationSummary) => GuardrailResult {
  const texts = Array.isArray(reviewTexts) ? reviewTexts : [];
  const reviewTextAvailable =
    typeof reviewTexts === "boolean" ? reviewTexts : texts.length > 0;
  const haystack = texts.map(squash);
  const expectedVerdict = ratingBandFor(rating);
  return (summary) => {
    if (summary.volume_band !== measuredVolumeBand) {
      return {
        passed: false,
        notes: `volume claim '${summary.volume_band}' contradicts the measured band '${measuredVolumeBand}'`,
      };
    }
    if (
      expectedVerdict !== "unknown" &&
      measuredVolumeBand !== "none" &&
      verdictDistance(summary.verdict, expectedVerdict) > 1
    ) {
      return {
        passed: false,
        notes: `verdict '${summary.verdict}' contradicts the ${rating} rating (expected '${expectedVerdict}' or one band away)`,
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
      if (wordCount(item.quote) > MAX_QUOTE_WORDS) {
        return {
          passed: false,
          notes: `theme quote too long (>${MAX_QUOTE_WORDS} words): "${item.quote.slice(0, 80)}"`,
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
