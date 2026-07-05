/**
 * Presence summary guardrails (PRD 6.5, pure functions): reject a
 * 'consistent' NAP verdict without the compared values present, and
 * reject verdicts that contradict the deterministic comparison.
 */
import type { GuardrailResult } from "../../lib/ai";
import type { PresenceSummary } from "../prompts/presence";

export function makePresenceSummaryGuardrail(deterministic: {
  napConsistent: boolean | null;
}): (summary: PresenceSummary) => GuardrailResult {
  return (summary) => {
    if (summary.nap_assessment === "consistent") {
      const { google_phone, site_phone, google_address, address_found_on_site } =
        summary.compared;
      const phoneCompared = google_phone !== null && site_phone !== null;
      const addressCompared =
        google_address !== null && address_found_on_site !== null;
      if (!phoneCompared && !addressCompared) {
        return {
          passed: false,
          notes: "nap_assessment 'consistent' without compared values",
        };
      }
    }
    // The model adjudicates near-misses only — it never overrides an
    // exact deterministic verdict (deterministic before AI).
    if (
      deterministic.napConsistent === false &&
      summary.nap_assessment === "consistent"
    ) {
      return {
        passed: false,
        notes: "verdict contradicts deterministic NAP mismatch",
      };
    }
    if (
      deterministic.napConsistent === true &&
      summary.nap_assessment === "mismatch"
    ) {
      return {
        passed: false,
        notes: "verdict contradicts deterministic NAP match",
      };
    }
    return { passed: true, notes: null };
  };
}
