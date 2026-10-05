/**
 * Workspace results poller (RFL.WEB.10 §2) with a mocked API: counts that
 * resolve before the list, out-of-order responses, and surfaced errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadView, SearchDetail } from "@/lib/api";
import {
  countedResults,
  createSearchDetailPoller,
  resultsPending,
  type SearchDetailState,
} from "./search-detail";

function lead(i: number): LeadView {
  return {
    result: { id: `r-${i}`, business_id: `b-${i}` },
    business: { id: `b-${i}`, name: `Biz ${i}` },
    audit: null,
  } as unknown as LeadView;
}

function detail(overrides: {
  status?: string;
  leads?: LeadView[];
  results_count?: number | null;
  done?: number;
  queued?: number;
  running?: number;
}): SearchDetail {
  return {
    search: {
      id: "8344b5b8",
      status: overrides.status ?? "completed",
      results_count: overrides.results_count === undefined ? 13 : overrides.results_count,
    },
    leads: overrides.leads ?? [],
    agent_states: [],
    job_counts: {
      queued: overrides.queued ?? 0,
      running: overrides.running ?? 0,
      done: overrides.done ?? 14,
      failed: 0,
    },
  } as unknown as SearchDetail;
}

const THIRTEEN = Array.from({ length: 13 }, (_, i) => lead(i));

describe("resultsPending / countedResults", () => {
  it("is pending when counts say rows exist but the list is empty", () => {
    expect(resultsPending(detail({ leads: [] }))).toBe(true);
    expect(countedResults(detail({ leads: [] }))).toBe(13);
  });
  it("falls back to audit-job counts when results_count is null", () => {
    expect(countedResults(detail({ results_count: null, done: 14 }))).toBe(13);
    expect(resultsPending(detail({ results_count: null, done: 14 }))).toBe(true);
  });
  it("is NOT pending for a genuinely empty search (scout job only) or once rows arrive", () => {
    expect(resultsPending(detail({ results_count: 0, done: 1 }))).toBe(false);
    expect(resultsPending(detail({ leads: THIRTEEN }))).toBe(false);
    expect(resultsPending(null)).toBe(false);
  });
});

describe("createSearchDetailPoller", () => {
  const states: SearchDetailState[] = [];
  const onChange = (s: SearchDetailState) => states.push(s);

  beforeEach(() => {
    vi.useFakeTimers();
    states.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders rows once the list resolves after the counts (never a terminal 'No results.')", async () => {
    const responses = [
      detail({ leads: [] }), // counts first: completed, 13 counted, list empty
      detail({ leads: [] }),
      detail({ leads: THIRTEEN }),
    ];
    const fetch = vi.fn(async () => responses.shift() ?? detail({ leads: THIRTEEN }));
    const poller = createSearchDetailPoller("8344b5b8", { fetch, onChange, pollMs: 100 });

    await vi.advanceTimersByTimeAsync(0);
    let last = states.at(-1)!;
    expect(last.detail?.leads).toHaveLength(0);
    expect(resultsPending(last.detail)).toBe(true); // table shows "loading", not "No results."
    expect(last.error).toBeNull();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    last = states.at(-1)!;
    expect(last.detail?.leads).toHaveLength(13);
    expect(resultsPending(last.detail)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);

    // Terminal and consistent: polling stops.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it("gives up on a lagging list after the retry cap and says so in the error", async () => {
    const fetch = vi.fn(async () => detail({ leads: [] }));
    const poller = createSearchDetailPoller("8344b5b8", {
      fetch,
      onChange,
      pollMs: 100,
      maxPendingPolls: 2,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    const last = states.at(-1)!;
    expect(fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(last.error).toMatch(/reports 13 results but the list came back empty/);
    expect(last.detail).not.toBeNull(); // counts stay on screen
    poller.dispose();
  });

  it("keeps polling while the search is live and stops once terminal with rows", async () => {
    const responses = [
      detail({ status: "auditing", leads: THIRTEEN.slice(0, 4), running: 5, done: 5 }),
      detail({ status: "auditing", leads: THIRTEEN.slice(0, 9), running: 2, done: 10 }),
      detail({ status: "completed", leads: THIRTEEN }),
    ];
    const fetch = vi.fn(async () => responses.shift() ?? detail({ leads: THIRTEEN }));
    const poller = createSearchDetailPoller("8344b5b8", { fetch, onChange, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)!.detail?.leads).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)!.detail?.leads).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)!.detail?.leads).toHaveLength(13);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it("drops a slow, older response that resolves after a newer one (no stale overwrite)", async () => {
    let resolveSlow: ((d: SearchDetail) => void) | null = null;
    const fetch = vi
      .fn<(id: string) => Promise<SearchDetail>>()
      .mockImplementationOnce(
        () =>
          new Promise<SearchDetail>((resolve) => {
            resolveSlow = resolve; // the initial poll hangs…
          }),
      )
      .mockResolvedValueOnce(detail({ leads: THIRTEEN })); // …a nudge answers first
    const poller = createSearchDetailPoller("8344b5b8", { fetch, onChange, pollMs: 100 });
    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)!.detail?.leads).toHaveLength(13);
    expect(states.at(-1)!.loading).toBe(true); // the slow one is still out

    resolveSlow!(detail({ leads: [] })); // the stale empty list lands late
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)!.detail?.leads).toHaveLength(13); // not overwritten
    poller.dispose();
  });

  it("surfaces a nudge's failure in error and recovers on the next success", async () => {
    const fetch = vi
      .fn<(id: string) => Promise<SearchDetail>>()
      .mockResolvedValueOnce(detail({ status: "auditing", leads: THIRTEEN.slice(0, 2), running: 3 }))
      .mockRejectedValueOnce(new Error("Request failed (502)"))
      .mockResolvedValue(detail({ leads: THIRTEEN }));
    const poller = createSearchDetailPoller("8344b5b8", { fetch, onChange, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    poller.refresh(); // e.g. the lead.scored nudge — used to swallow errors
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)!.error).toBe("Request failed (502)");
    expect(states.at(-1)!.detail?.leads).toHaveLength(2); // last good data kept
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)!.error).toBeNull();
    expect(states.at(-1)!.detail?.leads).toHaveLength(13);
    poller.dispose();
  });

  it("ignores everything after dispose", async () => {
    const fetch = vi.fn(async () => detail({ status: "auditing", leads: [], running: 1 }));
    const poller = createSearchDetailPoller("8344b5b8", { fetch, onChange, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    poller.dispose();
    const n = states.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(n);
  });
});
