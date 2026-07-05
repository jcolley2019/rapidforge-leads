/**
 * Orchestrator — owns the pipeline described in PRD 3.3.
 *
 * Sprint 2 flow:
 *   1. POST /api/searches → `searches` row + 'scout' job in `jobs`.
 *   2. Scout job → runScout → N businesses upserted → fan out one
 *      'audit_business' job per business.
 *   3. 'audit_business' → Filter gate + special routing (CLAUDE.md 6.7):
 *      no-website/social-only → sellability-95 hot lead (never skipped,
 *      never audited); dead site → health 10; live site → provisional
 *      'pending' audit row awaiting the Sprint 3 audit agents.
 *   4. Sprint 3 adds Health/Conversion/Presence/Traffic + Scorer to the
 *      audit_business fan-out. Sprint 4 makes events real Realtime.
 *
 * Every agent run writes an `agent_runs` row and emits AgentEvents
 * (CLAUDE.md 6.5) — done here so agents stay pure.
 */
import type { AgentResult, Job, Search } from "@rapidforge/shared";
import { runFilter } from "./agents/filter";
import { runScout } from "./agents/scout";
import { broadcastAgentEvent } from "./events";
import type { PlacesClient } from "./lib/places";
import type { WebProbe } from "./lib/probe";
import type { DataStore } from "./store";

/** Hard cap on concurrent business audits (CLAUDE.md Section 8). */
export const AUDIT_CONCURRENCY_CAP = 5;

/** Analyst auto-run threshold (CLAUDE.md Section 8) — used from Sprint 7. */
export const ANALYST_SELLABILITY_THRESHOLD = 60;

export interface OrchestratorDeps {
  store: DataStore;
  places: PlacesClient;
  probe: WebProbe;
}

/** jobs.payload shape for 'scout' and 'audit_business' jobs. */
export interface JobPayload {
  search_id?: string;
  business_id?: string;
}

export function payloadOf(job: Job): JobPayload {
  return job.payload as JobPayload;
}

/** Dispatch a claimed job. Throws on failure — the queue owns retries. */
export async function handleJob(job: Job, deps: OrchestratorDeps): Promise<void> {
  switch (job.job_type) {
    case "scout":
      return handleScoutJob(job, deps);
    case "audit_business":
      return handleAuditBusinessJob(job, deps);
    default:
      throw new Error(
        `[orchestrator] job_type '${job.job_type}' not implemented until Sprint 3+`,
      );
  }
}

async function handleScoutJob(job: Job, deps: OrchestratorDeps): Promise<void> {
  const { store } = deps;
  const searchId = payloadOf(job).search_id;
  if (!searchId) throw new Error("scout job payload missing search_id");
  const search = await store.getSearch(searchId);
  if (!search) throw new Error(`search ${searchId} not found`);

  await store.updateSearch(search.id, { status: "scouting" });

  const result = await withAgentRun(
    deps,
    { job, search, agent: "scout", targetId: null },
    () => runScout({ store, places: deps.places, search, jobId: job.id }),
  );
  if (result.status === "failed" || !result.output) {
    throw new Error(result.error ?? "scout failed");
  }

  // Fan out one audit job per business (PRD 3.3 step 2).
  for (const businessId of result.output.business_ids) {
    await store.enqueueJob({
      workspace_id: search.workspace_id,
      job_type: "audit_business",
      payload: { search_id: search.id, business_id: businessId },
    });
  }

  if (result.output.business_ids.length === 0) {
    await store.updateSearch(search.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
    });
  } else {
    await store.updateSearch(search.id, { status: "auditing" });
  }
}

async function handleAuditBusinessJob(
  job: Job,
  deps: OrchestratorDeps,
): Promise<void> {
  const { store } = deps;
  const { search_id: searchId, business_id: businessId } = payloadOf(job);
  if (!searchId || !businessId) {
    throw new Error("audit_business job payload missing search_id/business_id");
  }
  const [search, business] = await Promise.all([
    store.getSearch(searchId),
    store.getBusiness(businessId),
  ]);
  if (!search) throw new Error(`search ${searchId} not found`);
  if (!business) throw new Error(`business ${businessId} not found`);

  const result = await withAgentRun(
    deps,
    { job, search, agent: "filter", targetId: business.id },
    () =>
      runFilter({ store, probe: deps.probe, search, business, jobId: job.id }),
  );
  if (result.status === "failed") {
    throw new Error(result.error ?? "filter failed");
  }
}

/**
 * agent_runs persistence + AgentEvent emission around one agent call
 * (CLAUDE.md 6.5). The run row starts 'running' so the live view can show
 * in-flight agents, then is finalized from the AgentResult.
 */
async function withAgentRun<T extends Record<string, unknown>>(
  deps: OrchestratorDeps,
  ctx: { job: Job; search: Search; agent: string; targetId: string | null },
  run: () => Promise<AgentResult<T>>,
): Promise<AgentResult<T>> {
  const { store } = deps;
  const { job, search, agent, targetId } = ctx;

  const runRow = await store.insertAgentRun({
    workspace_id: search.workspace_id,
    agent_name: agent,
    job_id: job.id,
    target_id: targetId,
    input: { search_id: search.id },
  });
  await broadcastAgentEvent(search.workspace_id, {
    type: "agent.started",
    agent,
    ...(targetId === null ? {} : { target: targetId }),
  });

  const result = await run();

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
  await broadcastAgentEvent(
    search.workspace_id,
    result.status === "completed"
      ? {
          type: "agent.completed",
          agent,
          result: result.output,
          ...(targetId === null ? {} : { target: targetId }),
        }
      : {
          type: "agent.failed",
          agent,
          error: result.error ?? "unknown",
          ...(targetId === null ? {} : { target: targetId }),
        },
  );

  return result;
}

/**
 * Called by the queue after every job settles: when a search has no
 * queued/running jobs left, stamp it completed.
 */
export async function settleSearchIfDone(
  job: Job,
  deps: OrchestratorDeps,
): Promise<void> {
  const searchId = payloadOf(job).search_id;
  if (!searchId) return;
  const active = await deps.store.countActiveJobsForSearch(searchId);
  if (active > 0) return;
  const search = await deps.store.getSearch(searchId);
  if (!search || search.status === "completed" || search.status === "failed") {
    return;
  }
  await deps.store.updateSearch(searchId, {
    status: "completed",
    completed_at: new Date().toISOString(),
  });
  console.log(`[orchestrator] search ${searchId} completed`);
}
