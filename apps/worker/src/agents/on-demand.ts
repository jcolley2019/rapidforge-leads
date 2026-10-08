/**
 * On-demand money-agent runner (PRD 6.11–6.13). Gives an agent invoked from
 * an HTTP route the same lifecycle the orchestrator gives pipeline agents
 * (CLAUDE.md 6.5): an agent_runs row, Realtime start/finish events, a
 * usage_events(ai_call) entry, and persistence onto the audit row. Realtime
 * is best-effort — a broadcast failure never fails the run.
 *
 * RFL.FIX.3i: run() is raced against the Analyst stage budget (120 s) and
 * receives its signal, so a hung model call fails the run (and the route)
 * instead of holding the HTTP request until ai-core gives up.
 *
 * RFL.VERIFY.3 V1: a run that failed but still carries output (the Builder
 * Brief truncated and fell back to its template) is persisted and its spend
 * logged; the agent_runs row keeps status failed with the reason.
 */
import type { AgentResult } from "@rapidforge/shared";
import { broadcastAgentEvent } from "../events";
import { withBudget } from "../lib/budget";
import { STAGE_BUDGET_MS } from "../orchestrator";
import type { DataStore } from "../store";

export interface OnDemandRunInput<T extends Record<string, unknown>> {
  store: DataStore;
  workspaceId: string;
  agentName: string;
  businessId: string;
  auditId: string;
  /** Receives the budget's signal to hand to the AI call (RFL.FIX.3i). */
  run: (signal: AbortSignal) => Promise<AgentResult<T>>;
  /** Persist the successful output onto the audit row (dedicated column). */
  persist: (auditId: string, output: T) => Promise<void>;
}

export async function runOnDemandAgent<T extends Record<string, unknown>>(
  input: OnDemandRunInput<T>,
): Promise<AgentResult<T>> {
  const { store, workspaceId, agentName, businessId, auditId } = input;

  const runRow = await store.insertAgentRun({
    workspace_id: workspaceId,
    agent_name: agentName,
    job_id: null,
    target_id: businessId,
    input: { on_demand: true, audit_id: auditId },
  });
  await broadcastAgentEvent(workspaceId, {
    type: "agent.started",
    agent: agentName,
    target: businessId,
  });

  const startedAt = Date.now();
  let result: AgentResult<T>;
  try {
    result = await withBudget(agentName, STAGE_BUDGET_MS.analyst, input.run);
  } catch (err) {
    result = {
      agent: agentName,
      status: "failed",
      output: null,
      error: err instanceof Error ? err.message : String(err),
      modelUsed: null,
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - startedAt,
      guardrailPassed: false,
      guardrailNotes: null,
    } as AgentResult<T>;
  }

  await store.updateAgentRun(runRow.id, {
    status: result.status,
    output: (result.output as Record<string, unknown> | null) ?? null,
    error: result.error,
    model_used: result.modelUsed,
    tokens_used: result.tokensUsed,
    cost_cents: result.costCents,
    guardrail_passed: result.guardrailPassed,
    guardrail_notes: result.guardrailNotes,
    duration_ms: result.durationMs,
  });

  if (result.output) {
    await input.persist(auditId, result.output);
    await store.logUsageEvent({
      workspace_id: workspaceId,
      event_type: "ai_call",
      cost_cents: result.costCents,
      metadata: {
        agent: agentName,
        business_id: businessId,
        audit_id: auditId,
        model: result.modelUsed,
      },
    });
  }

  await broadcastAgentEvent(
    workspaceId,
    result.status === "completed"
      ? {
          type: "agent.completed",
          agent: agentName,
          result: result.output,
          target: businessId,
        }
      : {
          type: "agent.failed",
          agent: agentName,
          error: result.error ?? "unknown",
          target: businessId,
        },
  );

  return result;
}
