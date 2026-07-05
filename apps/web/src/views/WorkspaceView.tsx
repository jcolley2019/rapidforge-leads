/**
 * Workspace — the primary page (Sprint 4). Agent tabs across the top
 * (All · Scout · Filter · Health · Conversion · Presence · Traffic ·
 * Scorer); All shows the pipeline overview + live results table, each
 * agent tab shows live status + an activity feed of its events as cards.
 *
 * Data: Realtime events via LiveContext drive statuses/feed instantly;
 * GET /api/searches/:id polling stays as the results fallback (PRD 5.6)
 * and is nudged immediately whenever a lead.scored event arrives.
 */
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  CircleDashed,
  MessageSquareText,
  Play,
  Search,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ZipRadiusParams } from "@rapidforge/shared";
import { ResultsTable } from "@/components/leads/ResultsTable";
import { Button } from "@/components/ui/button";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import { useLive } from "@/features/live/useWorkspaceLive";
import {
  AGENTS,
  type AgentActivity,
  type AgentStatus,
} from "@/lib/agent-state";
import { fetchSearchDetail, type SearchDetail } from "@/lib/api";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

type TabKey = "all" | (typeof AGENTS)[number];

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "all", label: "All" },
  ...AGENTS.map((a) => ({
    key: a as TabKey,
    label: a.charAt(0).toUpperCase() + a.slice(1),
  })),
];

export interface WorkspaceViewProps {
  searchId: string | null;
  onNewSearch: () => void;
}

export function WorkspaceView({ searchId, onNewSearch }: WorkspaceViewProps) {
  const { live, connection } = useLive();
  const { openLead, leadsVersion } = useLeadDrawer();
  const [tab, setTab] = useState<TabKey>("all");
  const [detail, setDetail] = useState<SearchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);

  // Drawer edits (status/notes) refresh the table without waiting on a poll.
  useEffect(() => {
    if (!searchId || leadsVersion === 0) return;
    let cancelled = false;
    void fetchSearchDetail(searchId).then(
      (next) => {
        if (!cancelled) setDetail(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [searchId, leadsVersion]);

  // Polling fallback while the search is active (PRD 5.6).
  useEffect(() => {
    if (!searchId) return;
    stopped.current = false;
    setDetail(null);
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      if (!searchId) return;
      try {
        const next = await fetchSearchDetail(searchId);
        if (stopped.current) return;
        setDetail(next);
        setError(null);
        if (TERMINAL_STATUSES.has(next.search.status ?? "") && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch (err) {
        if (!stopped.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped.current = true;
      if (timer) clearInterval(timer);
    };
  }, [searchId]);

  // Realtime nudge: a lead.scored broadcast refreshes results immediately,
  // even after the poller has gone terminal (e.g. re-audits).
  const scoredCount = live.scored.length;
  useEffect(() => {
    if (!searchId || scoredCount === 0) return;
    let cancelled = false;
    void fetchSearchDetail(searchId).then(
      (next) => {
        if (!cancelled) setDetail(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [searchId, scoredCount]);

  // business_id → display name, for feed cards and "current business".
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const lead of detail?.leads ?? []) {
      map.set(lead.business.id, lead.business.name);
    }
    return map;
  }, [detail]);

  const search = detail?.search;
  const params = (search?.params ?? {}) as Partial<ZipRadiusParams>;
  const status = search?.status ?? (searchId ? "loading" : "idle");
  const jobs = detail?.job_counts;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
            Workspace
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {search
                ? `${params.zip ?? "—"} · ${search.category}`
                : "Agent pipeline"}
            </h1>
            {searchId && <StatusPill status={status} />}
          </div>
          {search && (
            <p className="font-mono text-xs text-muted-foreground">
              {params.radius_miles ?? "—"} mi radius · min{" "}
              {params.min_reviews ?? 0} reviews · min rating{" "}
              {params.min_rating || "any"}
              {params.exclude_chains ? " · chains excluded" : ""}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onNewSearch}>
          <Search className="h-4 w-4" aria-hidden /> New search
        </Button>
      </div>

      {/* Signature element: floating glass agent tab strip with live dots */}
      <div
        className="glass-card flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-full p-1.5"
        role="tablist"
        aria-label="Agents"
      >
        {TABS.map(({ key, label }) => {
          const active = tab === key;
          const agentStatus = key !== "all" ? live.statuses[key] : undefined;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(key)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] transition-colors",
                active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active && (
                <motion.span
                  layoutId="agent-tab-pill"
                  transition={spring.default}
                  className="absolute inset-0 rounded-full bg-accent shadow-card"
                  aria-hidden
                />
              )}
              <span className="relative flex items-center gap-1.5">
                {agentStatus && <StatusDot status={agentStatus} />}
                {label}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-4 py-2.5 text-xs text-agent-error">
          {error} — retrying; Realtime {connection}.
        </p>
      )}

      {tab === "all" ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            {AGENTS.map((agent) => (
              <AgentSummaryCard
                key={agent}
                status={live.statuses[agent]}
                agent={agent}
                queued={agent === "scout" ? 0 : (jobs?.queued ?? 0)}
                nameById={nameById}
                onOpen={() => setTab(agent)}
              />
            ))}
          </div>
          <ResultsTable
            leads={detail?.leads ?? []}
            terminal={TERMINAL_STATUSES.has(status) || !searchId}
            onSelect={openLead}
          />
        </div>
      ) : (
        <AgentDetail
          agent={tab}
          status={live.statuses[tab]}
          queued={tab === "scout" ? 0 : (jobs?.queued ?? 0)}
          feed={live.feed.filter((f) => f.agent === tab)}
          nameById={nameById}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "border-agent-waiting/50 bg-agent-waiting/10 text-agent-waiting",
    scouting: "border-primary/50 bg-primary/10 text-primary animate-pulse",
    auditing: "border-primary/50 bg-primary/10 text-primary animate-pulse",
    completed:
      "border-agent-complete/50 bg-agent-complete/10 text-agent-complete",
    failed: "border-agent-error/50 bg-agent-error/10 text-agent-error",
  };
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider",
        styles[status] ??
          "border-border bg-muted/30 text-muted-foreground animate-pulse",
      )}
    >
      {status}
    </span>
  );
}

/** Idle = quiet dot; working = cyan breathing pulse. */
function StatusDot({ status }: { status: AgentStatus }) {
  const working = status.state === "working";
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 rounded-full",
        working ? "bg-agent-active pulse-live" : "bg-muted-foreground/40",
      )}
      aria-label={working ? "working" : "idle"}
    />
  );
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function AgentSummaryCard({
  agent,
  status,
  queued,
  nameById,
  onOpen,
}: {
  agent: string;
  status: AgentStatus | undefined;
  queued: number;
  nameById: Map<string, string>;
  onOpen: () => void;
}) {
  const working = status?.state === "working";
  const target = status?.currentTarget
    ? (nameById.get(status.currentTarget) ?? "…")
    : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "glass-card group flex flex-col items-start gap-1.5 p-3.5 text-left transition-transform duration-150 hover:-translate-y-0.5",
        working && "pulse-live",
      )}
    >
      <span className="flex w-full items-center justify-between">
        <span className="text-[13px] font-medium capitalize">{agent}</span>
        {status && <StatusDot status={status} />}
      </span>
      <span className="min-h-4 w-full truncate text-[11px] text-muted-foreground">
        {working ? (target ?? "working…") : "idle"}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">
        <span className="text-foreground">{status?.done ?? 0}</span> done
        {queued > 0 && (
          <>
            {" · "}
            <span className="text-agent-waiting">{queued}</span> queued
          </>
        )}
        {" · "}
        {formatMs(status?.avgRuntimeMs ?? null)}
      </span>
    </button>
  );
}

const FEED_ICONS = {
  "agent.started": Play,
  "agent.progress": MessageSquareText,
  "agent.completed": CheckCircle2,
  "agent.failed": XCircle,
  "lead.scored": CheckCircle2,
} as const;

function relativeTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function AgentDetail({
  agent,
  status,
  queued,
  feed,
  nameById,
}: {
  agent: string;
  status: AgentStatus | undefined;
  queued: number;
  feed: AgentActivity[];
  nameById: Map<string, string>;
}) {
  const working = status?.state === "working";
  const target = status?.currentTarget
    ? (nameById.get(status.currentTarget) ?? status.currentTarget.slice(0, 8))
    : null;

  return (
    <div className="space-y-4">
      <div className="glass-card flex flex-wrap items-center gap-x-8 gap-y-3 p-5">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full",
              working
                ? "bg-primary/15 text-primary pulse-live"
                : "bg-muted text-muted-foreground",
            )}
          >
            {working ? (
              <CircleDashed className="h-4 w-4 animate-spin [animation-duration:3s]" />
            ) : (
              <CircleDashed className="h-4 w-4" />
            )}
          </span>
          <div>
            <p className="text-[15px] font-semibold capitalize leading-tight">
              {agent}
            </p>
            <p className="text-xs text-muted-foreground">
              {working ? `working${target ? ` on ${target}` : "…"}` : "idle"}
            </p>
          </div>
        </div>
        <Metric label="done" value={String(status?.done ?? 0)} />
        <Metric label="queued" value={String(queued)} />
        <Metric
          label="failed"
          value={String(status?.failed ?? 0)}
          tone={status?.failed ? "error" : undefined}
        />
        <Metric label="avg runtime" value={formatMs(status?.avgRuntimeMs ?? null)} />
      </div>

      <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
        <AnimatePresence initial={false}>
          {feed.map((item) => {
            const Icon = FEED_ICONS[item.kind];
            const failed = item.kind === "agent.failed";
            const targetName = item.target
              ? (nameById.get(item.target) ?? item.target.slice(0, 8))
              : null;
            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring.snappy}
                className="glass-card flex items-center gap-3 px-4 py-2.5"
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    failed
                      ? "text-agent-error"
                      : item.kind === "agent.completed"
                        ? "text-agent-complete"
                        : "text-primary",
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">
                    <span className="capitalize">
                      {item.kind.replace("agent.", "")}
                    </span>
                    {targetName && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {targetName}
                      </span>
                    )}
                  </p>
                  {item.message && (
                    <p
                      className={cn(
                        "truncate text-xs",
                        failed ? "text-agent-error" : "text-muted-foreground",
                      )}
                    >
                      {item.message}
                    </p>
                  )}
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {relativeTime(item.at)}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {feed.length === 0 && (
          <div className="glass-card px-4 py-10 text-center text-sm text-muted-foreground">
            No activity yet — events appear here the moment {agent} starts
            working.
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "error";
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-lg font-semibold",
          tone === "error" && "text-agent-error",
        )}
      >
        {value}
      </span>
    </div>
  );
}
