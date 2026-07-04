import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Scorer — PRD 6.7 (v1, DETERMINISTIC MATH — no LLM, ever).
 *
 * Health Score, star grade, Sellability Score, threshold-based issues
 * list. All math lives in @rapidforge/shared/scoring.ts
 * (computeHealthScore, deriveStarGrade, computeSellabilityScore) — this
 * agent only gathers inputs, calls those pure functions, and persists.
 * An LLM assigning a score is a bug (CLAUDE.md 4.2).
 *
 * TODO(Sprint 3): implement per PRD 6.7 — assemble inputs from the audit
 * agents' outputs, compute scores + issues (PRD 4.5 plain-English
 * bullets), write the `audits` row, emit `lead.scored`.
 */
export async function runScorer(): Promise<AgentResult> {
  return notImplemented("scorer", "6.7");
}
