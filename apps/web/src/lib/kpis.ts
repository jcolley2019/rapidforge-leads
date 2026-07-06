/**
 * Dashboard KPI math (S5.5) — pure, over DEDUPED leads so counts match
 * what Pipeline/Leads display.
 */
import type { Search } from "@rapidforge/shared";
import type { DedupedLead } from "@/lib/dedupe";

/** Statuses that mean the phone was picked up ("called or beyond"). */
export const CALLED_OR_BEYOND = new Set(["called", "interested", "sold"]);

export interface DashboardKpis {
  totalLeads: number;
  hotLeads: number;
  searchesThisMonth: number;
  callsMade: number;
}

/** First instant of the current UTC month — matches the worker's meter window. */
export function currentMonthStartIso(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

export function computeKpis(
  leads: DedupedLead[],
  searches: Search[],
  monthStartIso: string,
): DashboardKpis {
  return {
    totalLeads: leads.length,
    hotLeads: leads.filter((l) => (l.audit?.sellability_score ?? 0) >= 90)
      .length,
    searchesThisMonth: searches.filter(
      (s) => (s.created_at ?? "") >= monthStartIso,
    ).length,
    callsMade: leads.filter((l) =>
      CALLED_OR_BEYOND.has(l.result.status ?? "new"),
    ).length,
  };
}
