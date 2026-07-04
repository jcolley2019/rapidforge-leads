import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Scout — PRD 6.1 (v1, deterministic, no LLM).
 *
 * Places Nearby Search (New), grid-tiles large areas, Place Details
 * enrichment, dedupe by place_id.
 *
 * TODO(Sprint 2): implement per PRD 6.1 — Places (New) integration with
 * grid tiling, dedupe, is_chain + website_kind classification, upsert into
 * `businesses` on (workspace_id, google_place_id), one usage_events row
 * per Places call.
 */
export async function runScout(): Promise<AgentResult> {
  return notImplemented("scout", "6.1");
}
