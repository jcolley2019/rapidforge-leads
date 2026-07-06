/**
 * SEO guardrails (PRD 6.10, pure functions):
 *   - deterministic-side invariant: an element reported found=true must
 *     carry a value ("reject found=true with null value")
 *   - model-side: reject a local_fit score of 5 when title, meta
 *     description, or H1 is missing
 */
import type { GuardrailResult } from "../../lib/ai";
import type { SeoSummary } from "../prompts/seo";

export interface SeoElement {
  found: boolean;
  value: string | null;
}

export interface SeoElementChecks {
  title: SeoElement;
  meta_description: SeoElement;
  h1_count: number;
}

/** Self-check on the deterministic extraction (never persist a lie). */
export function seoChecksInvariant(checks: SeoElementChecks): GuardrailResult {
  for (const [name, element] of [
    ["title", checks.title],
    ["meta_description", checks.meta_description],
  ] as const) {
    if (element.found && (element.value === null || element.value.trim() === "")) {
      return {
        passed: false,
        notes: `${name} reported found=true with a null/empty value`,
      };
    }
  }
  return { passed: true, notes: null };
}

export function makeSeoSummaryGuardrail(
  checks: SeoElementChecks,
): (summary: SeoSummary) => GuardrailResult {
  return (summary) => {
    const complete =
      checks.title.found && checks.meta_description.found && checks.h1_count > 0;
    if (summary.local_fit_score_1_5 === 5 && !complete) {
      const missing = [
        !checks.title.found ? "title" : null,
        !checks.meta_description.found ? "meta description" : null,
        checks.h1_count === 0 ? "H1" : null,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        passed: false,
        notes: `score 5 with missing ${missing}`,
      };
    }
    return { passed: true, notes: null };
  };
}
