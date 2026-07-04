import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Analyst — PRD 6.11 (v1.5, **Fable 5** → Opus 4.8 fallback).
 *
 * Narrative verdict, top-3 improvements, enriched issues — synthesized
 * FROM deterministic data (never inventing measurements). Auto-runs only
 * at sellability ≥ 60 (CLAUDE.md Section 8).
 *
 * TODO(Sprint 7): implement per PRD 6.11 — MODEL_FABLE via lib/ai.ts with
 * the refusal-retry to MODEL_FABLE_FALLBACK; strict JSON output,
 * Zod-validated; guardrails per CLAUDE.md 6.2; citations per 6.3.
 */
export async function runAnalyst(): Promise<AgentResult> {
  return notImplemented("analyst", "6.11");
}
