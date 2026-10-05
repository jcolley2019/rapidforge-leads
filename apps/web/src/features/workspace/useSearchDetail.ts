/**
 * useSearchDetail — the Workspace view's data hook (RFL.WEB.10 §2). One
 * poller per search id (lib/search-detail.ts): ordered responses, errors
 * surfaced, "results pending" retries. `refresh()` is the nudge the drawer
 * edits and lead.scored broadcasts call; it never spawns a second fetcher.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSearchDetail } from "@/lib/api";
import {
  createSearchDetailPoller,
  EMPTY_SEARCH_DETAIL_STATE,
  type SearchDetailPoller,
  type SearchDetailState,
} from "@/lib/search-detail";

export interface UseSearchDetail extends SearchDetailState {
  refresh: () => void;
}

export function useSearchDetail(searchId: string | null): UseSearchDetail {
  const [state, setState] = useState<SearchDetailState>(EMPTY_SEARCH_DETAIL_STATE);
  const pollerRef = useRef<SearchDetailPoller | null>(null);

  useEffect(() => {
    if (!searchId) {
      setState(EMPTY_SEARCH_DETAIL_STATE);
      return;
    }
    setState({ ...EMPTY_SEARCH_DETAIL_STATE, loading: true });
    const poller = createSearchDetailPoller(searchId, {
      fetch: fetchSearchDetail,
      onChange: setState,
    });
    pollerRef.current = poller;
    return () => {
      poller.dispose();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [searchId]);

  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  return { ...state, refresh };
}
