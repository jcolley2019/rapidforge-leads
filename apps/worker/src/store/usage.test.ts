import { describe, expect, it } from "vitest";
import { currentMonthStartIso, summarizeUsage } from "./usage";

const MONTH = "2026-07-01T00:00:00.000Z";

describe("summarizeUsage", () => {
  it("returns an empty rollup for no events", () => {
    expect(summarizeUsage([], MONTH)).toEqual({
      month_start: MONTH,
      total_cents: 0,
      events: 0,
      by_type: {},
    });
  });

  it("groups by event_type and sums cost_cents", () => {
    const summary = summarizeUsage(
      [
        { event_type: "places_call", cost_cents: 3 },
        { event_type: "places_call", cost_cents: 3 },
        { event_type: "pagespeed_call", cost_cents: 0 },
        { event_type: "audit_run", cost_cents: 12 },
      ],
      MONTH,
    );
    expect(summary.total_cents).toBe(18);
    expect(summary.events).toBe(4);
    expect(summary.by_type.places_call).toEqual({ count: 2, cost_cents: 6 });
    expect(summary.by_type.pagespeed_call).toEqual({ count: 1, cost_cents: 0 });
    expect(summary.by_type.audit_run).toEqual({ count: 1, cost_cents: 12 });
  });

  it("treats null cost_cents as zero", () => {
    const summary = summarizeUsage(
      [{ event_type: "ai_call", cost_cents: null }],
      MONTH,
    );
    expect(summary.total_cents).toBe(0);
    expect(summary.by_type.ai_call).toEqual({ count: 1, cost_cents: 0 });
  });
});

describe("currentMonthStartIso", () => {
  it("returns the first instant of the UTC month", () => {
    expect(currentMonthStartIso(new Date("2026-07-05T16:30:00Z"))).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(currentMonthStartIso(new Date("2026-12-31T23:59:59Z"))).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });
});
