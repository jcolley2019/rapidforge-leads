/**
 * Live Search — Sprint 2 polling version (PRD 7.3). Polls
 * GET /api/searches/:id every 2s until the search settles; the results
 * table populates live, sorted by sellability desc (server-side).
 * Sprint 4 replaces polling with Realtime agent events + pulse grid.
 */
import { ArrowLeft, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Issue, ZipRadiusParams } from "@rapidforge/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchSearchDetail, type LeadView, type SearchDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export interface LiveSearchViewProps {
  searchId: string;
  onNewSearch: () => void;
}

export function LiveSearchView({ searchId, onNewSearch }: LiveSearchViewProps) {
  const [detail, setDetail] = useState<SearchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
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

  const search = detail?.search;
  const params = (search?.params ?? {}) as Partial<ZipRadiusParams>;
  const status = search?.status ?? "loading";
  const leads = detail?.leads ?? [];
  const jobs = detail?.job_counts;
  const filterRuns = (detail?.agent_states ?? []).filter(
    (r) => r.agent_name === "filter",
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="font-mono text-[11px] uppercase tracking-widest text-primary">
            Live Search
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {search ? `${params.zip ?? "—"} · ${search.category}` : "Loading…"}
            </h1>
            <StatusPill status={status} />
          </div>
          {search && (
            <p className="font-mono text-xs text-muted-foreground">
              {params.radius_miles ?? "—"} mi radius · min {params.min_reviews ?? 0}{" "}
              reviews · min rating {params.min_rating || "any"}
              {params.exclude_chains ? " · chains excluded" : ""}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onNewSearch}>
          <ArrowLeft className="mr-2 h-4 w-4" aria-hidden /> New search
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 font-mono text-[11px]">
        <Stat label="results" value={String(leads.length)} />
        <Stat
          label="filtered"
          value={`${filterRuns.filter((r) => r.status !== "running").length}/${search?.results_count ?? "—"}`}
        />
        {jobs && (
          <>
            <Stat label="jobs queued" value={String(jobs.queued)} />
            <Stat label="running" value={String(jobs.running)} />
            <Stat label="done" value={String(jobs.done)} />
            {jobs.failed > 0 && (
              <Stat label="failed" value={String(jobs.failed)} tone="error" />
            )}
          </>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-agent-error/40 bg-agent-error/10 px-3 py-2 text-xs text-agent-error">
          {error}
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Business</th>
                <th className="px-4 py-2.5 font-medium">Phone</th>
                <th className="px-4 py-2.5 font-medium">Reviews</th>
                <th className="px-4 py-2.5 font-medium">Website</th>
                <th className="px-4 py-2.5 text-right font-medium">Health</th>
                <th className="px-4 py-2.5 text-right font-medium">Sellability</th>
                <th className="px-4 py-2.5 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead, i) => (
                <LeadRow
                  key={lead.result.id}
                  lead={lead}
                  rank={i + 1}
                  expanded={expandedId === lead.result.id}
                  onToggle={() =>
                    setExpandedId((current) =>
                      current === lead.result.id ? null : lead.result.id,
                    )
                  }
                />
              ))}
              {leads.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
                  >
                    {TERMINAL_STATUSES.has(status) ? (
                      "No results."
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <Loader2
                          className="h-4 w-4 animate-spin text-primary"
                          aria-hidden
                        />
                        Scout is sweeping the area…
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

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
        "rounded-md border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider",
        styles[status] ??
          "border-border bg-muted/30 text-muted-foreground animate-pulse",
      )}
    >
      {status}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "error";
}) {
  return (
    <span
      className={cn(
        "rounded-md border border-border px-2 py-1",
        tone === "error" ? "text-agent-error" : "text-muted-foreground",
      )}
    >
      {label} <span className="text-foreground">{value}</span>
    </span>
  );
}

function LeadRow({
  lead,
  rank,
  expanded,
  onToggle,
}: {
  lead: LeadView;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { business, audit } = lead;
  const sellability = audit?.sellability_score ?? null;
  const health = audit?.website_health_score ?? null;
  const stars = audit?.star_grade ?? null;
  const provisional = Boolean(
    (audit?.score_breakdown as { provisional?: boolean } | null)?.provisional,
  );
  const skipped = audit?.status === "skipped";
  const issues = audit?.issues ?? [];
  const expandable = issues.length > 0;

  return (
    <>
      <tr
        className={cn(
          "border-b border-border/60 last:border-0",
          skipped && "opacity-45",
          expandable && "cursor-pointer hover:bg-muted/20",
        )}
        onClick={expandable ? onToggle : undefined}
        title={expandable ? `${issues.length} issue(s) — click to expand` : undefined}
      >
        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {expandable &&
              (expanded ? (
                <ChevronDown className="h-3 w-3" aria-hidden />
              ) : (
                <ChevronRight className="h-3 w-3" aria-hidden />
              ))}
            {rank}
          </span>
        </td>
        <td className="px-4 py-2.5">
          <div className="font-medium">{business.name}</div>
          <div className="text-xs text-muted-foreground">{business.address}</div>
        </td>
        <td className="px-4 py-2.5 font-mono text-xs">
          {business.phone ?? <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-4 py-2.5 font-mono text-xs">
          {business.google_rating !== null ? (
            <>
              <span className="text-agent-waiting">★</span>{" "}
              {business.google_rating.toFixed(1)}
              <span className="text-muted-foreground">
                {" "}
                · {business.review_count ?? 0}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">no reviews</span>
          )}
        </td>
        <td className="px-4 py-2.5">
          <WebsiteCell lead={lead} />
        </td>
        <td className="px-4 py-2.5 text-right">
          <HealthCell health={health} stars={stars} />
        </td>
        <td className="px-4 py-2.5 text-right">
          {sellability !== null ? (
            <span
              className={cn(
                "font-mono text-base font-semibold",
                sellability >= 90
                  ? "text-primary"
                  : sellability >= 70
                    ? "text-agent-waiting"
                    : "text-muted-foreground",
              )}
            >
              {sellability}
              {provisional && (
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  est
                </span>
              )}
            </span>
          ) : (
            <span className="font-mono text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-4 py-2.5">
          <StateChip lead={lead} />
        </td>
      </tr>
      {expanded && expandable && (
        <tr className="border-b border-border/60 bg-muted/10">
          <td colSpan={8} className="px-4 py-3 pl-12">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              What&rsquo;s wrong
            </p>
            <ul className="space-y-1">
              {issues.map((issue, i) => (
                <IssueBullet key={i} issue={issue} />
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

/** Health score + star grade (PRD 4.1/4.2). Null = never audited. */
function HealthCell({
  health,
  stars,
}: {
  health: number | null;
  stars: number | null;
}) {
  if (health === null) {
    return <span className="font-mono text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span
        className={cn(
          "font-mono text-base font-semibold",
          health >= 70
            ? "text-agent-complete"
            : health >= 40
              ? "text-agent-waiting"
              : "text-agent-error",
        )}
      >
        {health}
      </span>
      {stars !== null && (
        <span
          className="text-[10px] tracking-tighter text-agent-waiting"
          aria-label={`${stars} star grade`}
        >
          {"★".repeat(Math.round(stars))}
          <span className="text-muted-foreground/40">
            {"★".repeat(Math.max(0, 5 - Math.round(stars)))}
          </span>
        </span>
      )}
    </span>
  );
}

function IssueBullet({ issue }: { issue: Issue }) {
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span
        className={cn(
          "rounded border px-1 font-mono text-[10px] uppercase",
          issue.severity === "high"
            ? "border-agent-error/50 text-agent-error"
            : issue.severity === "medium"
              ? "border-agent-waiting/50 text-agent-waiting"
              : "border-border text-muted-foreground",
        )}
      >
        {issue.severity}
      </span>
      <span>
        {issue.label}
        {issue.detail && (
          <span className="text-muted-foreground"> — {issue.detail}</span>
        )}
      </span>
    </li>
  );
}

function WebsiteCell({ lead }: { lead: LeadView }) {
  const { business } = lead;
  const kind = business.website_kind ?? "unknown";
  if (kind === "none") {
    return (
      <span className="rounded border border-agent-waiting/50 bg-agent-waiting/10 px-1.5 py-0.5 text-[11px] text-agent-waiting">
        No website
      </span>
    );
  }
  if (kind === "social_only") {
    return (
      <span className="rounded border border-agent-waiting/50 bg-agent-waiting/10 px-1.5 py-0.5 text-[11px] text-agent-waiting">
        Social only
      </span>
    );
  }
  let host = business.website_url ?? "";
  try {
    host = new URL(business.website_url ?? "").hostname.replace(/^www\./, "");
  } catch {
    // show the raw value
  }
  return <span className="font-mono text-xs text-muted-foreground">{host}</span>;
}

function StateChip({ lead }: { lead: LeadView }) {
  const { audit } = lead;
  if (!audit) {
    return (
      <span className="font-mono text-[11px] text-muted-foreground animate-pulse">
        queued…
      </span>
    );
  }
  if (audit.status === "skipped") {
    return (
      <span
        className="font-mono text-[11px] text-muted-foreground"
        title={audit.error_message ?? undefined}
      >
        Skipped · {audit.error_message}
      </span>
    );
  }
  if (audit.status === "pending") {
    return (
      <span className="font-mono text-[11px] text-primary animate-pulse">
        auditing…
      </span>
    );
  }
  if (audit.website_health_score !== null && audit.website_health_score <= 10) {
    return (
      <span className="rounded border border-agent-error/50 bg-agent-error/10 px-1.5 py-0.5 text-[11px] text-agent-error">
        Site broken — urgent
      </span>
    );
  }
  if ((audit.sellability_score ?? 0) >= 90) {
    return (
      <span className="rounded border border-primary/50 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
        Hot lead
      </span>
    );
  }
  return (
    <span className="font-mono text-[11px] text-agent-complete">scored</span>
  );
}
