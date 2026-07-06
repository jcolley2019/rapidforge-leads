/**
 * Pipeline kanban (PRD 7.3, Glass v2) — columns New / Called / Interested /
 * Sold / Dead across every search in the workspace. Drag-drop persists
 * search_results.status through the worker (optimistic move, revert on
 * failure). Cards show name, sellability badge, phone, last action; click
 * opens the lead drawer. Cards spring-animate between columns (motion
 * layout on a wrapper — the draggable itself stays a plain element so
 * native HTML5 DnD and framer never fight over drag events).
 */
import { motion } from "framer-motion";
import { Loader2, Phone, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LeadStatusSchema, type LeadStatus } from "@rapidforge/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import {
  fetchWorkspaceLeads,
  updateLeadStatus,
  type LeadView,
} from "@/lib/api";
import { dedupeLeads, type DedupedLead } from "@/lib/dedupe";
import { relativeTime } from "@/lib/format";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

const COLUMNS = LeadStatusSchema.options;

const COLUMN_LABELS: Record<LeadStatus, string> = {
  new: "New",
  called: "Called",
  interested: "Interested",
  sold: "Sold",
  dead: "Dead",
};

const DRAG_MIME = "application/x-rapidforge-lead";

export function PipelineView() {
  const { openLead, leadsVersion, notifyLeadsChanged } = useLeadDrawer();
  const [leads, setLeads] = useState<LeadView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hotOnly, setHotOnly] = useState(false);
  const [dragOver, setDragOver] = useState<LeadStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setLeads(await fetchWorkspaceLeads());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, leadsVersion]);

  // One card per business across all searches (S5.5 dedupe).
  const filtered = useMemo(() => {
    if (!leads) return [];
    const q = query.trim().toLowerCase();
    return dedupeLeads(leads).filter((lead) => {
      if (q && !lead.business.name.toLowerCase().includes(q)) return false;
      if (hotOnly && (lead.audit?.sellability_score ?? 0) < 90) return false;
      return true;
    });
  }, [leads, query, hotOnly]);

  const byColumn = useMemo(() => {
    const map = new Map<LeadStatus, DedupedLead[]>(
      COLUMNS.map((c) => [c, [] as DedupedLead[]]),
    );
    for (const lead of filtered) {
      map.get(lead.result.status ?? "new")?.push(lead);
    }
    return map;
  }, [filtered]);

  async function moveLead(id: string, to: LeadStatus) {
    const current = leads?.find((l) => l.result.id === id);
    if (!current || (current.result.status ?? "new") === to) return;
    // Optimistic move; a failed persist refetches the true state.
    setLeads(
      (prev) =>
        prev?.map((l) =>
          l.result.id === id
            ? { ...l, result: { ...l.result, status: to } }
            : l,
        ) ?? null,
    );
    try {
      await updateLeadStatus(id, { status: to });
      notifyLeadsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    }
  }

  return (
    <div className="flex h-full flex-col space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
            Pipeline
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Leads board</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name…"
              className="h-9 w-56 pl-9 text-xs"
              aria-label="Filter leads by name"
            />
          </div>
          <button
            type="button"
            onClick={() => setHotOnly((h) => !h)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs transition-colors",
              hotOnly
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={hotOnly}
          >
            Hot leads only
          </button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            title="Refresh"
            aria-label="Refresh pipeline"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-3.5 py-2 text-xs text-agent-error">
          {error}
        </p>
      )}

      {leads === null ? (
        <p className="inline-flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
          Loading pipeline…
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((status) => (
            <section
              key={status}
              className={cn(
                "card-panel flex min-h-[320px] w-64 shrink-0 flex-col transition-colors",
                dragOver === status && "border-primary/60 bg-primary/5",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(status);
              }}
              onDragLeave={() => setDragOver((d) => (d === status ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData(DRAG_MIME);
                if (id) void moveLead(id, status);
              }}
              aria-label={`${COLUMN_LABELS[status]} column`}
            >
              <header className="flex items-center justify-between px-4 pb-2 pt-4">
                <h2 className="text-sm font-semibold">{COLUMN_LABELS[status]}</h2>
                <span className="rounded-full border border-border px-2 font-mono text-[11px] text-muted-foreground">
                  {byColumn.get(status)?.length ?? 0}
                </span>
              </header>
              <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                {(byColumn.get(status) ?? []).map((lead) => (
                  <LeadCard
                    key={lead.result.id}
                    lead={lead}
                    onOpen={() => openLead(lead)}
                  />
                ))}
                {(byColumn.get(status)?.length ?? 0) === 0 && (
                  <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">
                    Drop leads here
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function LeadCard({ lead, onOpen }: { lead: DedupedLead; onOpen: () => void }) {
  const sell = lead.audit?.sellability_score ?? null;
  const lastAction =
    relativeTime(lead.result.last_contacted_at) ??
    (lead.result.created_at
      ? `found ${relativeTime(lead.result.created_at)}`
      : null);

  return (
    <motion.div layout transition={spring.default}>
      <article
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, lead.result.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={onOpen}
        className="cursor-grab rounded-xl border border-border/70 bg-card/60 p-3 shadow-card transition-colors hover:border-primary/40 active:cursor-grabbing"
        role="button"
        aria-label={`${lead.business.name} — open detail`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {lead.business.name}
          </p>
          {lead.seenIn > 1 && (
            <span
              className="shrink-0 rounded-full border border-border px-1.5 font-mono text-[10px] text-muted-foreground"
              title={`Seen in ${lead.seenIn} searches`}
            >
              ×{lead.seenIn}
            </span>
          )}
          {sell !== null && (
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 font-mono text-[11px] font-semibold",
                sell >= 90
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : sell >= 70
                    ? "border-agent-waiting/50 bg-agent-waiting/10 text-agent-waiting"
                    : "border-border text-muted-foreground",
              )}
              title="Sellability"
            >
              {sell}
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono">
            <Phone className="h-3 w-3" aria-hidden />
            {lead.business.phone ?? "—"}
          </span>
          {lastAction && <span className="truncate">{lastAction}</span>}
        </div>
      </article>
    </motion.div>
  );
}
