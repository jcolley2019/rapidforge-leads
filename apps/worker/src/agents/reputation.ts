import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Reputation — PRD 6.9 (v1.5, deterministic + Sonnet 4.6).
 *
 * Google vs. Yelp/BBB/Facebook divergence.
 *
 * TODO(Sprint 6): implement per PRD 6.9 — Yelp Fusion cross-reference,
 * divergence flags.
 */
export async function runReputation(): Promise<AgentResult> {
  return notImplemented("reputation", "6.9");
}
