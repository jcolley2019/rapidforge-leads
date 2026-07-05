/**
 * usage_events rollup shared by both stores (GET /api/usage — PRD 7.2 top-bar
 * usage meter). Pure so the math is unit-testable without a store.
 */
import type { UsageSummary } from "@rapidforge/shared";

export interface UsageRollupRow {
  event_type: string;
  cost_cents: number | null;
}

export function summarizeUsage(
  rows: UsageRollupRow[],
  monthStart: string,
): UsageSummary {
  const by_type: UsageSummary["by_type"] = {};
  let total_cents = 0;
  for (const row of rows) {
    const cost = row.cost_cents ?? 0;
    const bucket = (by_type[row.event_type] ??= { count: 0, cost_cents: 0 });
    bucket.count += 1;
    bucket.cost_cents += cost;
    total_cents += cost;
  }
  return { month_start: monthStart, total_cents, events: rows.length, by_type };
}

/** First instant of the current UTC month, ISO — the meter's window start. */
export function currentMonthStartIso(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}
