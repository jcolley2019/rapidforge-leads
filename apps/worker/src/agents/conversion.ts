import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Conversion — PRD 6.4 (v1, deterministic + Sonnet 4.6 summary).
 *
 * HTML parse: phone/tel:, forms, booking, chat, CTAs, viewport meta.
 *
 * TODO(Sprint 3): implement per PRD 6.4 — fetch + parse the homepage,
 * extract conversion signals deterministically, Sonnet summary on top.
 */
export async function runConversion(): Promise<AgentResult> {
  return notImplemented("conversion", "6.4");
}
