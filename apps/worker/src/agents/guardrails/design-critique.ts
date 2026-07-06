/**
 * Design critique guardrails (PRD 6.8, pure functions):
 *   - reject vague sub-scores: every dimension's notes must be >=15 words
 *   - reject an inconsistent year/score pair (feels_like_year > 2024 while
 *     modernity < 70 — a "modern-feeling" year on a dated score)
 *   - reject empty critical_issues when modernity < 70
 *   - reject critical issues whose evidence is not specific (>=4 words)
 */
import type { GuardrailResult } from "../../lib/ai";
import { DESIGN_DIMENSIONS, type DesignCritique } from "../prompts/design";

export const MIN_NOTE_WORDS = 15;
export const MIN_EVIDENCE_WORDS = 4;

/** Year/score consistency line (PRD 6.8): >2024 must mean modernity >=70. */
export const MODERN_YEAR_THRESHOLD = 2024;
export const MODERN_SCORE_THRESHOLD = 70;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function designCritiqueGuardrail(
  critique: DesignCritique,
): GuardrailResult {
  for (const dimension of DESIGN_DIMENSIONS) {
    const notes = critique.dimensions[dimension].notes;
    if (wordCount(notes) < MIN_NOTE_WORDS) {
      return {
        passed: false,
        notes: `dimension '${dimension}' notes too vague (<${MIN_NOTE_WORDS} words): "${notes.slice(0, 80)}"`,
      };
    }
  }

  if (
    critique.feels_like_year > MODERN_YEAR_THRESHOLD &&
    critique.modernity_0_100 < MODERN_SCORE_THRESHOLD
  ) {
    return {
      passed: false,
      notes: `inconsistent year/score: feels_like_year ${critique.feels_like_year} with modernity ${critique.modernity_0_100}`,
    };
  }

  if (
    critique.modernity_0_100 < MODERN_SCORE_THRESHOLD &&
    critique.critical_issues.length === 0
  ) {
    return {
      passed: false,
      notes: `modernity ${critique.modernity_0_100} (<${MODERN_SCORE_THRESHOLD}) with empty critical_issues`,
    };
  }

  for (const item of critique.critical_issues) {
    if (wordCount(item.evidence) < MIN_EVIDENCE_WORDS) {
      return {
        passed: false,
        notes: `critical issue evidence not specific enough: "${item.evidence.slice(0, 80)}"`,
      };
    }
  }

  return { passed: true, notes: null };
}
