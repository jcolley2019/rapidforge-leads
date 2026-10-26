/**
 * Dashboard — the default post-login landing (S5.5). KPI cards over real
 * store queries (deduped, so counts match Pipeline/Leads), recent searches,
 * and the New Search CTA. Three parallel fetches, no polling — the
 * leadsVersion bump refreshes after any lead mutation.
 */
import {
  Flame,
  Loader2,
  MapPin,
  Phone,
  Search,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Search as SearchRow, UsageSummary } from "@rapidforge/shared";
import { CoachingTip } from "@/components/CoachingTip";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import {
  deleteSearch,
  fetchRecentSearches,
  fetchUsage,
  fetchWorkspaceLeads,
  type LeadView,
} from "@/lib/api";
import {
  confirmDeleteSearchMessage,
  DELETE_CANCEL_FIRST,
  deleteSearchDisabled,
  describeDeleteCounts,
} from "@/lib/data-delete";
import { dedupeLeads } from "@/lib/dedupe";
import { formatCents, relativeTime } from "@/lib/format";
import { computeKpis, currentMonthStartIso } from "@/lib/kpis";
import { searchLocation } from "@/lib/search-label";
import { cn } from "@/lib/utils";

/** How long the "… removed" line stays under the Recent searches title. */
const NOTICE_MS = 6000;

export interface DashboardViewProps {
  onNewSearch: () => void;
  onOpenSearch: (searchId: string) => void;
  /** A one-line result to show on arrival (Settings' clear-all lands here). */
  notice?: string | null;
}

export function DashboardView({
  onNewSearch,
  onOpenSearch,
  notice: incomingNotice = null,
}: DashboardViewProps) {
  const { leadsVersion, notifyLeadsChanged } = useLeadDrawer();
  const [leads, setLeads] = useState<LeadView[] | null>(null);
  const [searches, setSearches] = useState<SearchRow[] | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(incomingNotice);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    setNotice(incomingNotice);
  }, [incomingNotice]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const load = useCallback(async () => {
    try {
      const [leadRows, searchRows, usageSummary] = await Promise.all([
        fetchWorkspaceLeads(),
        fetchRecentSearches(50),
        fetchUsage(),
      ]);
      setLeads(leadRows);
      setSearches(searchRows);
      setUsage(usageSummary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, leadsVersion]);

  const kpis = useMemo(() => {
    if (!leads || !searches) return null;
    return computeKpis(dedupeLeads(leads), searches, currentMonthStartIso());
  }, [leads, searches]);

  // RFL.DATA.1: one search goes, with the businesses only it found. The
  // confirm is window.confirm — there is no dialog component in ui/ yet.
  async function removeSearch(search: SearchRow) {
    if (deletingId || deleteSearchDisabled(search.status)) return;
    if (!window.confirm(confirmDeleteSearchMessage(search, searchLocation(search)))) {
      return;
    }
    setDeletingId(search.id);
    setError(null);
    try {
      const counts = await deleteSearch(search.id);
      await load();
      notifyLeadsChanged(); // Leads / Pipeline / top-bar counts refetch
      setNotice(describeDeleteCounts(counts));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
            Overview
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <Button onClick={onNewSearch}>
          <Search className="mr-2 h-4 w-4" aria-hidden />
          New search
        </Button>
      </div>

      <CoachingTip tipId="dashboard" title="Start with a search">
        Press New search, type what kind of business and pick an area. The agents
        find every match, audit its website and score it.
      </CoachingTip>

      {error && (
        <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-3.5 py-2 text-xs text-agent-error">
          {error}
        </p>
      )}

      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard
          label="Total leads"
          value={kpis?.totalLeads}
          icon={<Users className="h-4 w-4" aria-hidden />}
          testId="kpi-total-leads"
        />
        <KpiCard
          label="Hot leads"
          value={kpis?.hotLeads}
          icon={<Flame className="h-4 w-4" aria-hidden />}
          accent
          testId="kpi-hot-leads"
        />
        <KpiCard
          label="Searches this month"
          value={kpis?.searchesThisMonth}
          icon={<MapPin className="h-4 w-4" aria-hidden />}
          testId="kpi-searches-month"
        />
        <KpiCard
          label="Calls made"
          value={kpis?.callsMade}
          icon={<Phone className="h-4 w-4" aria-hidden />}
          testId="kpi-calls-made"
        />
        <KpiCard
          label="API spend / mo"
          value={usage ? formatCents(usage.total_cents) : undefined}
          icon={<Wallet className="h-4 w-4" aria-hidden />}
          testId="kpi-api-spend"
        />
      </div>

      {/* Recent searches */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent searches</CardTitle>
          {notice && (
            <p
              className="text-xs text-agent-complete"
              role="status"
              aria-live="polite"
              data-testid="delete-notice"
            >
              {notice}
            </p>
          )}
        </CardHeader>
        <CardContent>
          {searches === null ? (
            <p className="inline-flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
              Loading…
            </p>
          ) : searches.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No searches yet — run your first sweep.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {searches.slice(0, 8).map((search) => {
                const locked = deleteSearchDisabled(search.status);
                const deleting = deletingId === search.id;
                return (
                  <li key={search.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpenSearch(search.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-1 py-2.5 text-left text-sm transition-colors hover:bg-accent/40"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{search.category}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {searchLocation(search)}
                        </span>
                      </span>
                      <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {search.results_count ?? 0} results
                      </span>
                      <StatusPill status={search.status ?? "pending"} />
                      <span className="w-20 whitespace-nowrap text-right font-mono text-[11px] text-muted-foreground">
                        {relativeTime(search.created_at) ?? "—"}
                      </span>
                    </button>
                    {/* Sibling of the row button, not nested — buttons can't nest. */}
                    <span title={locked ? DELETE_CANCEL_FIRST : undefined}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-agent-error"
                        aria-label="Delete search"
                        title={locked ? DELETE_CANCEL_FIRST : "Delete search"}
                        disabled={locked || deletingId !== null}
                        onClick={() => void removeSearch(search)}
                      >
                        {deleting ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden />
                        )}
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon,
  accent,
  testId,
}: {
  label: string;
  value: number | string | undefined;
  icon: React.ReactNode;
  accent?: boolean;
  testId: string;
}) {
  return (
    <div className="card-panel px-4 py-3.5">
      <div className="flex items-center justify-between text-muted-foreground">
        <p className="font-mono text-[10px] uppercase tracking-[0.15em]">
          {label}
        </p>
        {icon}
      </div>
      <p
        data-testid={testId}
        className={cn(
          "mt-1.5 font-mono text-2xl font-semibold",
          accent && "text-primary",
        )}
      >
        {value ?? "—"}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const done = status === "completed";
  const failed = status === "failed";
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[10px]",
        done
          ? "border-agent-complete/50 text-agent-complete"
          : failed
            ? "border-agent-error/50 text-agent-error"
            : "border-agent-waiting/50 text-agent-waiting",
      )}
    >
      {status}
    </span>
  );
}
