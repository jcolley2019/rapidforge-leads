/**
 * Realtime agent events (PRD 5.6) and the universal agent result envelope.
 *
 * The worker broadcasts AgentEvents on channel `workspace:{id}` with the
 * service-role key; the web app subscribes on login. Agent state is also
 * persisted in `agent_runs` so a page reload recovers current status.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// AgentEvent — PRD 5.6, verbatim shape (PRD's `result: any` typed as unknown
// for strict TS; consumers narrow it).
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent.started"; agent: string; target?: string }
  | { type: "agent.progress"; agent: string; target?: string; message: string }
  | { type: "agent.completed"; agent: string; target?: string; result: unknown }
  | { type: "agent.failed"; agent: string; target?: string; error: string }
  | {
      type: "lead.scored";
      businessId: string;
      healthScore: number;
      sellabilityScore: number;
    }
  /** One stderr line from a running `npm run demo` build (RFL.DEMO.1). */
  | { type: "demo.log"; businessId: string; line: string };

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.started"),
    agent: z.string(),
    target: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent.progress"),
    agent: z.string(),
    target: z.string().optional(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("agent.completed"),
    agent: z.string(),
    target: z.string().optional(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("agent.failed"),
    agent: z.string(),
    target: z.string().optional(),
    error: z.string(),
  }),
  z.object({
    type: z.literal("lead.scored"),
    businessId: z.string(),
    healthScore: z.number(),
    sellabilityScore: z.number(),
  }),
  z.object({
    type: z.literal("demo.log"),
    businessId: z.string(),
    line: z.string(),
  }),
]);

/** Realtime channel name for a workspace (PRD 5.6). */
export function workspaceChannel(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

// ---------------------------------------------------------------------------
// AgentResult — what every agent run resolves to. Mirrors the `agent_runs`
// row (CLAUDE.md 6.5): status, model, tokens, cost, duration, guardrails.
// ---------------------------------------------------------------------------

export interface AgentResult<TOutput = unknown> {
  /** Agent name, e.g. 'scout', 'health', 'analyst'. */
  agent: string;
  status: "completed" | "failed";
  /** Zod-validated output; null when the run failed. */
  output: TOutput | null;
  error: string | null;
  /** Model ID when an LLM was involved; null for deterministic agents. */
  modelUsed: string | null;
  tokensUsed: number;
  /** Derived (nearest cent) from costMicrocents; null when the model has no list price. */
  costCents: number | null;
  /**
   * Exact list-price spend in microcents (1¢ = 1_000_000) — RFL.AI.9.
   * Absent on deterministic agents (counts as 0); null when unknown.
   */
  costMicrocents?: number | null;
  durationMs: number;
  /**
   * Guardrail protocol (CLAUDE.md 6.2): fail → re-run once → on second
   * failure persist with guardrailPassed:false + notes. Never silently
   * accept bad output.
   */
  guardrailPassed: boolean;
  guardrailNotes: string | null;
}
