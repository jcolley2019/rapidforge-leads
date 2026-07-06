/**
 * Reputation summary guardrails (PRD 6.9, pure functions):
 *   - reject a volume claim that contradicts the measured band — this
 *     subsumes the PRD's "reject volume 'high' under 50 reviews"
 *   - reject overlong theme quotes (must be <15 words)
 *   - reject any quote when no review text was provided (invention)
 */
import type { GuardrailResult } from "../../lib/ai";
import type { ReputationSummary, VolumeBand } from "../prompts/reputation";

export const MAX_QUOTE_WORDS = 15;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function makeReputationSummaryGuardrail(
  measuredVolumeBand: VolumeBand,
  reviewTextAvailable: boolean,
): (summary: ReputationSummary) => GuardrailResult {
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
    }
    return { passed: true, notes: null };
  };
}
