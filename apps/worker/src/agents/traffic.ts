import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Traffic — PRD 6.6 (v1, deterministic, no LLM, free).
 *
 * CrUX field-data presence from the PSI response = free traffic proxy.
 *
 * TODO(Sprint 3): implement per PRD 6.6 — read has_crux_data off the
 * Health agent's PSI payload; no extra API call.
 */
export async function runTraffic(): Promise<AgentResult> {
  return notImplemented("traffic", "6.6");
}
