/**
 * Lead drawer state (PRD 7.4) — one drawer instance lives at the App shell
 * level so Workspace, Pipeline, and Leads can all open it. leadsVersion
 * bumps on every persisted lead mutation (status/notes) so list views know
 * to refetch without prop-drilling callbacks.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LeadView } from "@/lib/api";

interface LeadDrawerValue {
  lead: LeadView | null;
  openLead: (lead: LeadView) => void;
  closeLead: () => void;
  /** Monotonic counter — bumped after any persisted lead change. */
  leadsVersion: number;
  notifyLeadsChanged: () => void;
}

const LeadDrawerContext = createContext<LeadDrawerValue | null>(null);

export function LeadDrawerProvider({ children }: { children: ReactNode }) {
  const [lead, setLead] = useState<LeadView | null>(null);
  const [leadsVersion, setLeadsVersion] = useState(0);

  const openLead = useCallback((next: LeadView) => setLead(next), []);
  const closeLead = useCallback(() => setLead(null), []);
  const notifyLeadsChanged = useCallback(
    () => setLeadsVersion((v) => v + 1),
    [],
  );

  const value = useMemo(
    () => ({ lead, openLead, closeLead, leadsVersion, notifyLeadsChanged }),
    [lead, openLead, closeLead, leadsVersion, notifyLeadsChanged],
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
