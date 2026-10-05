/**
 * Workspace results poller (RFL.WEB.10 §2) — framework-free so the whole
 * lifecycle is unit-testable without a DOM.
 *
 * Why it exists: the Workspace view used to run three uncoordinated
 * fetchSearchDetail callers (the 2s poll, the drawer-edit nudge, the
 * lead.scored nudge). Two of them swallowed errors, none of them ordered
 * their responses, and the poll stopped on the first terminal response —
 * so a terminal response whose list lagged its counts (search 8344b5b8:
 * "10 of 10 complete", table "No results.", 13 rows on the next visit)
 * stuck until the next visit. Here:
 *
 *   - one sequence number per request; a response older than the newest
 *     applied one is dropped, never rendered over fresher data;
 *   - every failure lands in `error` for the red banner, and polling keeps
 *     going while the search is live or the list is still catching up;
 *   - a terminal response with counts > 0 but an empty list is
 *     "results pending", not "No results.": the poller keeps asking (up
 *     to RESULTS_PENDING_MAX_POLLS) and the table shows a loading state.
 */
import type { SearchDetail } from "@/lib/api";

export const SEARCH_POLL_MS = 2000;
/** Extra polls to wait for a list that lags its counts before giving up. */
export const RESULTS_PENDING_MAX_POLLS = 10;

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export function isTerminalStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(status ?? "");
}

/** How many leads the counts say exist: Scout's results_count, else audit jobs. */
export function countedResults(detail: SearchDetail): number {
  const fromScout = detail.search.results_count ?? 0;
  if (fromScout > 0) return fromScout;
  const jobs = detail.job_counts;
  // Every search has one scout job; anything beyond it is an audit job.
  return Math.max(0, jobs.queued + jobs.running + jobs.done + jobs.failed - 1);
}

/**
 * Counts say the search produced leads, the list says none: the list has
 * not caught up (or the fetch returned partial data). Never "No results."
 */
export function resultsPending(detail: SearchDetail | null): boolean {
  if (!detail || detail.leads.length > 0) return false;
  return countedResults(detail) > 0;
}

export interface SearchDetailState {
  detail: SearchDetail | null;
  /** Last fetch failure; cleared by the next success. */
  error: string | null;
  /** A request is in flight. */
  loading: boolean;
}

export const EMPTY_SEARCH_DETAIL_STATE: SearchDetailState = {
  detail: null,
  error: null,
  loading: false,
};

export interface SearchDetailPollerOptions {
  fetch: (searchId: string) => Promise<SearchDetail>;
  onChange: (state: SearchDetailState) => void;
  pollMs?: number;
  maxPendingPolls?: number;
}

export interface SearchDetailPoller {
  /** Fetch now (nudges: drawer edits, lead.scored broadcasts). */
  refresh(): void;
  dispose(): void;
}

export function createSearchDetailPoller(
  searchId: string,
  options: SearchDetailPollerOptions,
): SearchDetailPoller {
  const pollMs = options.pollMs ?? SEARCH_POLL_MS;
  const maxPendingPolls = options.maxPendingPolls ?? RESULTS_PENDING_MAX_POLLS;
  let state: SearchDetailState = { ...EMPTY_SEARCH_DETAIL_STATE };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic request ids: issued vs. the newest whose response was applied. */
  let issued = 0;
  let applied = 0;
  /** Requests out right now — `loading` while any of them is. */
  let outstanding = 0;
  let pendingPolls = 0;

  function emit(patch: Partial<SearchDetailState>): void {
    state = { ...state, ...patch };
    options.onChange(state);
  }

  function schedule(): void {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, pollMs);
  }

  /** Keep polling while the search is live or the list lags its counts. */
  function keepPolling(detail: SearchDetail): boolean {
    if (!isTerminalStatus(detail.search.status)) {
      pendingPolls = 0;
      return true;
    }
    if (!resultsPending(detail)) {
      pendingPolls = 0;
      return false;
    }
    pendingPolls += 1;
    return pendingPolls <= maxPendingPolls;
  }

  function refresh(): void {
    if (disposed) return;
    issued += 1;
    outstanding += 1;
    const mine = issued;
    emit({ loading: true });
    options.fetch(searchId).then(
      (detail) => {
        outstanding -= 1;
        if (disposed) return;
        const loading = outstanding > 0;
        // A newer response already landed — this one is stale, drop it.
        if (mine < applied) {
          emit({ loading });
          return;
        }
        applied = mine;
        if (keepPolling(detail)) {
          emit({ detail, error: null, loading });
          schedule();
        } else if (resultsPending(detail)) {
          emit({
            detail,
            loading,
            error: `Search reports ${countedResults(detail)} results but the list came back empty after ${maxPendingPolls} retries`,
          });
        } else {
          emit({ detail, error: null, loading });
        }
      },
      (err: unknown) => {
        outstanding -= 1;
        if (disposed) return;
        const loading = outstanding > 0;
        if (mine < applied) {
          emit({ loading });
          return;
        }
        emit({ error: err instanceof Error ? err.message : String(err), loading });
        schedule(); // errors retry on the poll cadence, never silently
      },
    );
  }

  refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
