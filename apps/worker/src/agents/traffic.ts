/**
 * Traffic — PRD 6.6 (v1, deterministic, no LLM, free).
 *
 * Reads CrUX field-data presence off the PSI responses the orchestrator
 * already fetched for Health — real-user data present means real traffic
 * exists; absent means very low traffic (a sellability-relevant signal).
 * No extra API call, ever.
 */
import type { AgentResult } from "@rapidforge/shared";
import type { PsiMetrics } from "../lib/psi";

export interface TrafficContext {
  psiDesktop: PsiMetrics | null;
  psiMobile: PsiMetrics | null;
}

export interface TrafficOutput extends Record<string, unknown> {
  /** Null = PSI unavailable, so traffic is unknown — never invented. */
  has_crux_data: boolean | null;
  crux_mobile: boolean | null;
  crux_desktop: boolean | null;
}

export async function runTraffic(
  ctx: TrafficContext,
): Promise<AgentResult<TrafficOutput>> {
  const startedAt = Date.now();
  const { psiDesktop, psiMobile } = ctx;
  const output: TrafficOutput = {
    has_crux_data:
      psiDesktop === null && psiMobile === null
        ? null
        : Boolean(psiMobile?.hasCruxData || psiDesktop?.hasCruxData),
    crux_mobile: psiMobile?.hasCruxData ?? null,
    crux_desktop: psiDesktop?.hasCruxData ?? null,
  };
  return {
    agent: "traffic",
    status: "completed",
    output,
    error: null,
    modelUsed: null, // deterministic — no LLM (PRD 6.6)
    tokensUsed: 0,
    costCents: 0,
    durationMs: Date.now() - startedAt,
    guardrailPassed: true,
    guardrailNotes: null,
  };
}
