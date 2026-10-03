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
  Filter,
  Gauge,
  Globe,
  HeartPulse,
  List,
  MapPin,
  MessageSquareText,
  MousePointerClick,
  Palette,
  Play,
  Radar,
  Search,
  Star,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapDrawParams, ZipRadiusParams } from "@rapidforge/shared";
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
  // zip_radius carries zip; map_draw carries lat/lng — shared fields align.
  const params = (search?.params ?? {}) as Partial<ZipRadiusParams> &
    Partial<MapDrawParams>;
  const searchLocation =
    params.zip ??
    (params.lat !== undefined && params.lng !== undefined
      ? `${params.lat.toFixed(3)}, ${params.lng.toFixed(3)}`
      : "—");
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
                ? `${searchLocation} · ${search.category}`
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

      {error && (
        <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-4 py-2.5 text-xs text-agent-error">
          {error} — retrying; Realtime {connection}.
        </p>
      )}

      {/* Single selector: the pipeline chip bar filters the view below.
          "All" → results table; an agent chip → that agent's activity feed. */}
      <AgentPipelineBar
        statuses={live.statuses}
        scored={live.scored.length}
        queued={jobs?.queued ?? 0}
        running={jobs?.running ?? 0}
        activeTab={tab}
        onSelect={setTab}
      />

      {tab === "all" ? (
        <ResultsTable
          leads={detail?.leads ?? []}
          terminal={TERMINAL_STATUSES.has(status) || !searchId}
          onSelect={openLead}
        />
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

/** One icon per pipeline stage — scannable at a glance (DESIGN_NOTES v3). */
const AGENT_ICONS: Record<(typeof AGENTS)[number], LucideIcon> = {
  scout: Radar,
  filter: Filter,
  health: HeartPulse,
  conversion: MousePointerClick,
  presence: MapPin,
  traffic: TrendingUp,
  design: Palette,
  reputation: Star,
  seo: Globe,
  scorer: Gauge,
};

const CHIP_ACTIVE =
  "bg-primary/10 text-foreground ring-1 ring-inset ring-primary/40";
const CHIP_IDLE = "text-foreground hover:bg-accent/60";

/**
 * The pipeline chip bar (S8): the SINGLE view selector — a leading "All" chip
 * (→ results table) plus the ten agents in pipeline order (→ that agent's
 * feed). Replaces both the S7 card grid AND the old rounded pill strip. One
 * flex row at ≥1280/1600; the active chip carries a clear selected state. The
 * summary line reads the live pipeline state.
 */
function AgentPipelineBar({
  statuses,
  scored,
  queued,
  running,
  activeTab,
  onSelect,
}: {
  statuses: Record<string, AgentStatus>;
  scored: number;
  queued: number;
  /** jobs.running from the API — the table the poller claims from. */
  running: number;
  activeTab: TabKey;
  onSelect: (tab: TabKey) => void;
}) {
  // "complete" = finished ≥1 run and not currently working (live statuses);
  // "running" = jobs in the running state (RFL.QUEUE.8: the poller's source,
  // not a derivation from agent events that can miss a hung job).
  const complete = AGENTS.filter(
    (a) => (statuses[a]?.done ?? 0) > 0 && statuses[a]?.state !== "working",
  ).length;

  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] text-muted-foreground">
        <span className="text-foreground">{complete}</span> of {AGENTS.length}{" "}
        complete
        <span className="mx-1.5 text-muted-foreground/50">·</span>
        <span className="text-foreground">{scored}</span> scored
        <span className="mx-1.5 text-muted-foreground/50">·</span>
        <span className={running > 0 ? "text-primary" : "text-foreground"}>
          {running}
        </span>{" "}
        running
      </p>
      <div
        className="card-panel flex items-stretch gap-1 overflow-x-auto p-1.5"
        role="tablist"
        aria-label="Agent pipeline"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "all"}
          onClick={() => onSelect("all")}
          title="All results"
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-medium transition-colors",
            activeTab === "all" ? CHIP_ACTIVE : CHIP_IDLE,
          )}
        >
          <List
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              activeTab === "all" ? "text-primary" : "text-muted-foreground",
            )}
            aria-hidden
          />
          All
        </button>
        {AGENTS.map((agent) => (
          <PipelineChip
            key={agent}
            agent={agent}
            status={statuses[agent]}
            queued={agent === "scout" ? 0 : queued}
            active={activeTab === agent}
            onSelect={() => onSelect(agent)}
          />
        ))}
      </div>
    </div>
  );
}

function PipelineChip({
  agent,
  status,
  queued,
  active,
  onSelect,
}: {
  agent: (typeof AGENTS)[number];
  status: AgentStatus | undefined;
  queued: number;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = AGENT_ICONS[agent];
  const working = status?.state === "working";
  const done = status?.done ?? 0;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      title={`${agent} — ${done} done${queued > 0 ? `, ${queued} queued` : ""}`}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 rounded-xl px-2 py-1.5 text-left transition-colors",
        active ? CHIP_ACTIVE : CHIP_IDLE,
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          active || working ? "text-primary" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-center gap-1">
          <span className="truncate text-[11px] font-medium capitalize">
            {agent}
          </span>
          {status && <StatusDot status={status} />}
        </span>
        <span className="block font-mono text-[10px] text-muted-foreground">
          <span className="text-foreground">{done}</span>
          {queued > 0 && (
            <>
              {" / "}
              <span className="text-agent-waiting">{queued}</span>
            </>
          )}
        </span>
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
      <div className="card-panel flex flex-wrap items-center gap-x-8 gap-y-3 p-5">
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
                className="card-panel flex items-center gap-3 px-4 py-2.5"
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
          <div className="card-panel px-4 py-10 text-center text-sm text-muted-foreground">
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
