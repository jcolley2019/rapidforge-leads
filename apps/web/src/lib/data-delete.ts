/**
 * Delete-a-search / clear-all logic (RFL.DATA.1), kept pure so the web
 * suite can test it without a DOM: when the Dashboard's trash button is
 * disabled, when the Settings danger-zone button arms, and how the
 * returned counts read back to the operator.
 */
import type { Search } from "@rapidforge/shared";
import type { DeleteCounts } from "@/lib/api";
import { isTerminalStatus } from "@/lib/search-detail";

/** Must be typed exactly — no trimming, no case folding (worker 400s otherwise). */
export const CLEAR_ALL_PHRASE = "DELETE ALL";

/** Tooltip on a disabled trash button. */
export const DELETE_CANCEL_FIRST = "Cancel first";

/** A search can only be deleted once it has settled (completed / failed). */
export function deleteSearchDisabled(status: string | null | undefined): boolean {
  return !isTerminalStatus(status);
}

/** The danger-zone button enables only on the exact phrase. */
export function clearAllEnabled(input: string): boolean {
  return input === CLEAR_ALL_PHRASE;
}

/** "3 searches, 41 businesses, 52 audits removed" — zero-count tables are left out. */
export function describeDeleteCounts(counts: DeleteCounts): string {
  const parts = (
    [
      [counts.searches, "search", "searches"],
      [counts.businesses, "business", "businesses"],
      [counts.audits, "audit", "audits"],
      [counts.results, "lead row", "lead rows"],
      [counts.jobs, "job", "jobs"],
      [counts.agentRuns, "agent run", "agent runs"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length === 0 ? "Nothing to remove" : `${parts.join(", ")} removed`;
}

/** The window.confirm text for one search (there is no dialog component yet). */
export function confirmDeleteSearchMessage(
  search: Pick<Search, "category" | "results_count">,
  location: string,
): string {
  const n = search.results_count ?? 0;
  return [
    "Delete this search?",
    "",
    `${search.category} · ${location}`,
    `${n} ${n === 1 ? "business" : "businesses"}`,
    "",
    "Businesses found only by this search are removed with their audits. Ones another search also found stay.",
  ].join("\n");
}
