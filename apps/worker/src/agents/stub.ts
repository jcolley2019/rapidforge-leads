import type { AgentResult } from "@rapidforge/shared";

/**
 * Uniform Sprint-1 placeholder result. Every agent stub returns this so
 * callers can already program against AgentResult without special-casing.
 */
export function notImplemented(agent: string, prdSection: string): AgentResult {
  return {
    agent,
    status: "failed",
    output: null,
    error: `Agent '${agent}' not implemented yet — see PRD ${prdSection}.`,
    modelUsed: null,
    tokensUsed: 0,
    costCents: 0,
    durationMs: 0,
    guardrailPassed: true,
    guardrailNotes: null,
  };
}
