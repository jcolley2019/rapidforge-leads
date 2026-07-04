import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Health — PRD 6.3 (v1, deterministic + Sonnet 4.6 summary).
 *
 * PageSpeed Insights (desktop + mobile), SSL, response time, platform
 * detection. Measurements are facts; the model only summarizes them
 * (CLAUDE.md 4.2 — deterministic before AI).
 *
 * TODO(Sprint 3): implement per PRD 6.3 — PSI both strategies, SSL check,
 * platform detection, copyright year; usage_events row per PSI call;
 * Sonnet summary via lib/ai.ts.
 */
export async function runHealth(): Promise<AgentResult> {
  return notImplemented("health", "6.3");
}
