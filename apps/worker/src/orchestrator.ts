/**
 * Orchestrator — owns the pipeline described in PRD 3.3.
 *
 * Sprint 1: skeleton with the flow documented. Wired up in Sprints 2–3.
 *
 * The flow (PRD 3.3):
 *   1. Search created → `searches` row + Scout job enqueued in `jobs`.
 *   2. Scout returns N businesses → fan out one audit job per business.
 *   3. Filter runs first per business. No-website → skip audit, write
 *      sellability-95 hot lead (NEVER skipped, NEVER audited — CLAUDE.md 6.7).
 *      Fail → mark skipped with reason.
 *   4. Health / Conversion / Presence / Traffic run in parallel.
 *      v1.5 adds Design / Reputation / SEO to the same fan-out.
 *   5. Scorer runs deterministically on their outputs → writes `audits`
 *      row, scores, issues → emits `lead.scored`.
 *   6. v1.5: Analyst auto-runs at sellability ≥ 60; Builder Brief + Sales
 *      Summary are on-demand from the lead drawer (saves Fable tokens).
 *   7. Every agent run writes an `agent_runs` row and emits AgentEvents.
 */
import type { Job } from "@rapidforge/shared";

/** Hard cap on concurrent business audits (CLAUDE.md Section 8). */
export const AUDIT_CONCURRENCY_CAP = 5;

/** Analyst auto-run threshold (CLAUDE.md Section 8). */
export const ANALYST_SELLABILITY_THRESHOLD = 60;

/**
 * Dispatch a claimed job to its agent pipeline.
 *
 * TODO(Sprint 2): 'scout' → runScout, fan out audit jobs.
 * TODO(Sprint 3): 'audit_business' → Filter gate, parallel audit agents,
 *                 Scorer, agent_runs persistence, AgentEvent emission.
 * TODO(v1.5):    'analyst' / 'builder_brief' / 'sales_summary'.
 */
export async function handleJob(job: Job): Promise<void> {
  switch (job.job_type) {
    case "scout":
    case "audit_business":
    case "analyst":
    default:
      throw new Error(
        `[orchestrator] job_type '${job.job_type}' not implemented until Sprint 2+`,
      );
  }
}
