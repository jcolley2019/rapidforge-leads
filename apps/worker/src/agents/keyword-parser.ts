import type { AgentResult } from "@rapidforge/shared";
import { notImplemented } from "./stub";

/**
 * Keyword Parser — PRD 6.14 (v1.5, deferred; Sonnet 5.5 when built — the
 * PRD's Sonnet model is retired).
 *
 * Natural-language search → structured query (shown to the user before
 * running — PRD 7.3 New Search keyword tab).
 *
 * TODO(Sprint 7): implement per PRD 6.14.
 */
export async function runKeywordParser(): Promise<AgentResult> {
  return notImplemented("keyword-parser", "6.14");
}
