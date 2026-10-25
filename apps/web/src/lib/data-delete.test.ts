/**
 * RFL.DATA.1: the Dashboard trash button's running-state disable and the
 * Settings danger-zone enable rule, plus the counts readout.
 */
import { describe, expect, it } from "vitest";
import {
  CLEAR_ALL_PHRASE,
  clearAllEnabled,
  confirmDeleteSearchMessage,
  deleteSearchDisabled,
  describeDeleteCounts,
} from "./data-delete";

describe("Dashboard delete button (RFL.DATA.1)", () => {
  it("is disabled while the search is still running and armed once it settles", () => {
    for (const status of ["pending", "scouting", "auditing", null, undefined]) {
      expect(deleteSearchDisabled(status)).toBe(true);
    }
    expect(deleteSearchDisabled("completed")).toBe(false);
    expect(deleteSearchDisabled("failed")).toBe(false);
  });

  it("the confirm text names the search, its area and its business count", () => {
    const msg = confirmDeleteSearchMessage(
      { category: "plumber", results_count: 23 },
      "83704 · 10 mi",
    );
    expect(msg).toContain("plumber · 83704 · 10 mi");
    expect(msg).toContain("23 businesses");
    expect(
      confirmDeleteSearchMessage({ category: "plumber", results_count: 1 }, "83704"),
    ).toContain("1 business\n");
  });
});

describe("Settings danger zone (RFL.DATA.1)", () => {
  it("enables only on the exact phrase — no trimming, no case folding", () => {
    expect(CLEAR_ALL_PHRASE).toBe("DELETE ALL");
    expect(clearAllEnabled("")).toBe(false);
    expect(clearAllEnabled("DELETE")).toBe(false);
    expect(clearAllEnabled("delete all")).toBe(false);
    expect(clearAllEnabled("DELETE ALL ")).toBe(false);
    expect(clearAllEnabled(" DELETE ALL")).toBe(false);
    expect(clearAllEnabled("DELETE  ALL")).toBe(false);
    expect(clearAllEnabled("DELETE ALL")).toBe(true);
  });

  it("reads the counts back without the empty tables", () => {
    expect(
      describeDeleteCounts({
        searches: 3,
        businesses: 41,
        audits: 52,
        results: 44,
        jobs: 0,
        agentRuns: 0,
      }),
    ).toBe("3 searches, 41 businesses, 52 audits, 44 lead rows removed");
    expect(
      describeDeleteCounts({
        searches: 1,
        businesses: 1,
        audits: 0,
        results: 1,
        jobs: 0,
        agentRuns: 1,
      }),
    ).toBe("1 search, 1 business, 1 lead row, 1 agent run removed");
    expect(
      describeDeleteCounts({ searches: 0, businesses: 0, audits: 0, results: 0, jobs: 0, agentRuns: 0 }),
    ).toBe("Nothing to remove");
  });
});
