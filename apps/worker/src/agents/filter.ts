import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Filter — PRD 6.2 (v1, deterministic + Haiku 4.5 edge-pass only).
 *
 * Pre-audit qualification; routes no-website businesses straight to
 * hot-lead. SPECIAL ROUTING IS LAW (CLAUDE.md 6.7): no-website →
 * sellability-95 hot lead, never skipped, never audited; social-only →
 * same; dead site → health 10 "Site broken — urgent."
 *
 * TODO(Sprint 3): implement per PRD 6.2 — deterministic rules first,
 * MODEL_HAIKU (lib/ai.ts) only for genuine edge cases. Filter before any
 * spend (CLAUDE.md Section 8).
 */
export async function runFilter(): Promise<AgentResult> {
  return notImplemented("filter", "6.2");
}
