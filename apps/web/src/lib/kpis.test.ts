import { describe, expect, it } from "vitest";
import type { Search } from "@rapidforge/shared";
import type { DedupedLead } from "@/lib/dedupe";
import { computeKpis, currentMonthStartIso } from "./kpis";

function lead(status: string | null, sell: number | null): DedupedLead {
  return {
    seenIn: 1,
    business: { id: `b${Math.random()}` } as DedupedLead["business"],
    result: { status } as DedupedLead["result"],
    audit:
      sell === null
        ? null
        : ({ sellability_score: sell } as DedupedLead["audit"]),
  };
}

function search(createdAt: string): Search {
  return { created_at: createdAt } as Search;
}

const MONTH = "2026-07-01T00:00:00.000Z";

describe("computeKpis", () => {
  it("counts totals, hot leads, monthly searches, and calls made", () => {
    const kpis = computeKpis(
      [
        lead("new", 95),
        lead("called", 92),
        lead("interested", 40),
        lead("sold", null),
        lead("dead", 88),
      ],
      [
        search("2026-07-02T10:00:00.000Z"),
        search("2026-07-01T00:00:00.000Z"),
        search("2026-06-30T23:59:59.000Z"), // last month
      ],
      MONTH,
    );
    expect(kpis.totalLeads).toBe(5);
    expect(kpis.hotLeads).toBe(2); // 95 + 92
    expect(kpis.searchesThisMonth).toBe(2);
    // called or beyond = called, interested, sold — dead is NOT a call
    expect(kpis.callsMade).toBe(3);
  });

  it("treats null status as new and null audits as not hot", () => {
    const kpis = computeKpis([lead(null, null)], [], MONTH);
    expect(kpis.totalLeads).toBe(1);
    expect(kpis.hotLeads).toBe(0);
    expect(kpis.callsMade).toBe(0);
  });
});

describe("currentMonthStartIso", () => {
  it("returns the first instant of the UTC month", () => {
    expect(currentMonthStartIso(new Date("2026-07-05T23:59:00Z"))).toBe(MONTH);
  });
});
