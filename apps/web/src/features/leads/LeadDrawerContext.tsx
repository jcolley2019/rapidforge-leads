/**
 * Lead drawer state (PRD 7.4) — one drawer instance lives at the App shell
 * level so Workspace, Pipeline, and Leads can all open it. leadsVersion
 * bumps on every persisted lead mutation (status/notes) and on every
 * finished audit (lead.scored) so list views know to refetch without
 * prop-drilling callbacks.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLive } from "@/features/live/useWorkspaceLive";
import { scoredRefreshKey } from "@/lib/agent-state";
import type { LeadView } from "@/lib/api";

/** lead.scored bursts (a search scoring many leads) refetch once per lull. */
export const SCORED_REFRESH_DEBOUNCE_MS = 500;

interface LeadDrawerValue {
  lead: LeadView | null;
  openLead: (lead: LeadView) => void;
  closeLead: () => void;
  /** Monotonic counter — bumped after any persisted lead change. */
  leadsVersion: number;
  notifyLeadsChanged: () => void;
  /** Leads-view bulk selection, shared so cmd-K can act on it (PRD 7.5). */
  selectedLeadIds: ReadonlySet<string>;
  setSelectedLeadIds: (ids: Set<string>) => void;
}

const LeadDrawerContext = createContext<LeadDrawerValue | null>(null);

export function LeadDrawerProvider({ children }: { children: ReactNode }) {
  const [lead, setLead] = useState<LeadView | null>(null);
  const [leadsVersion, setLeadsVersion] = useState(0);
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(
    new Set(),
  );

  const openLead = useCallback((next: LeadView) => setLead(next), []);
  const closeLead = useCallback(() => setLead(null), []);
  const notifyLeadsChanged = useCallback(
    () => setLeadsVersion((v) => v + 1),
    [],
  );

  // RFL.VERIFY.3 V6: a finished audit refreshes the Leads list, the palette
  // and (through the views' fresh-row sync) the drawer. Before, only the
  // drawer's Re-audit button bumped leadsVersion, and only if it stayed
  // mounted on that lead until the job's events stopped.
  const { live } = useLive();
  const scoredKey = scoredRefreshKey(live);
  useEffect(() => {
    if (scoredKey === null) return;
    const timer = setTimeout(notifyLeadsChanged, SCORED_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [scoredKey, notifyLeadsChanged]);

  const value = useMemo(
    () => ({
      lead,
      openLead,
      closeLead,
      leadsVersion,
      notifyLeadsChanged,
      selectedLeadIds,
      setSelectedLeadIds,
    }),
    [
      lead,
      openLead,
      closeLead,
      leadsVersion,
      notifyLeadsChanged,
      selectedLeadIds,
    ],
  );
  return (
    <LeadDrawerContext.Provider value={value}>
      {children}
    </LeadDrawerContext.Provider>
  );
}

export function useLeadDrawer(): LeadDrawerValue {
  const value = useContext(LeadDrawerContext);
  if (!value) {
    throw new Error("useLeadDrawer requires a LeadDrawerProvider ancestor");
  }
  return value;
}
