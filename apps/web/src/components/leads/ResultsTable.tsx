/**
 * Live results table (Glass v2) — Sprint 4 fixes from real use:
 * phones and STATE badges never wrap (nowrap + reserved column widths),
 * columns rebalanced via table-fixed, row expand spring-animated.
 */
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Issue } from "@rapidforge/shared";
import type { LeadView } from "@/lib/api";
import {
  failedAuditReason,
  isFailedAudit,
  isProvisionalAudit,
} from "@/lib/audit-flags";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CouldNotAuditChip, ProvisionalTag } from "./AuditTags";

export interface ResultsTableProps {
  leads: LeadView[];
  /** Search status — drives the empty-state copy. */
  terminal: boolean;
  /**
   * Counts say rows exist but the list has not arrived (RFL.WEB.10): show a
   * loading state instead of "No results." while the poller catches up.
   */
  pending?: boolean;
  /** Row click → lead drawer (Sprint 5). Chevron still inline-expands issues. */
  onSelect?: (lead: LeadView) => void;
  /** Per-row action cell (Workspace: the Re-audit button, RFL.WEB.10). */
  renderAction?: (lead: LeadView) => ReactNode;
}

export function ResultsTable({
  leads,
  terminal,
  pending = false,
  onSelect,
  renderAction,
}: ResultsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const columns = renderAction ? 9 : 8;

  return (
    <div className="card-panel dense-surface overflow-hidden">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-11" />
          <col />
          <col className="w-[124px]" />
          <col className="w-[116px]" />
          <col className="w-[150px]" />
          <col className="w-[84px]" />
          <col className="w-[104px]" />
          <col className="w-[168px]" />
          {renderAction && <col className="w-[44px]" />}
        </colgroup>
        <thead>
          <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-[7px] font-medium">#</th>
            <th className="px-3 py-[7px] font-medium">Business</th>
            <th className="px-3 py-[7px] font-medium">Phone</th>
            <th className="px-3 py-[7px] font-medium">Reviews</th>
            <th className="px-3 py-[7px] font-medium">Website</th>
            <th className="px-3 py-[7px] text-right font-medium">Health</th>
            <th className="px-3 py-[7px] text-right font-medium">Sell</th>
            <th className="px-3 py-[7px] font-medium">State</th>
            {renderAction && (
              <th className="px-1 py-[7px] font-medium">
                <span className="sr-only">Actions</span>
              </th>
            )}
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
              onSelect={onSelect}
              renderAction={renderAction}
              columns={columns}
            />
          ))}
          {leads.length === 0 && (
            <tr>
              <td
                colSpan={columns}
                className="px-4 py-14 text-center text-sm text-muted-foreground"
              >
                {pending ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2
                      className="h-4 w-4 animate-spin text-primary"
                      aria-hidden
                    />
                    Loading results…
                  </span>
                ) : terminal ? (
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
    </div>
  );
}

function LeadRow({
  lead,
  rank,
  expanded,
  onToggle,
  onSelect,
  renderAction,
  columns,
}: {
  lead: LeadView;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
  onSelect?: (lead: LeadView) => void;
  renderAction?: (lead: LeadView) => ReactNode;
  columns: number;
}) {
  const { business, audit } = lead;
  const sellability = audit?.sellability_score ?? null;
  const health = audit?.website_health_score ?? null;
  const stars = audit?.star_grade ?? null;
  const provisional = Boolean(
    (audit?.score_breakdown as { provisional?: boolean } | null)?.provisional,
  );
  const skipped = audit?.status === "skipped";
  const provisionalAudit = isProvisionalAudit(audit);
  const issues = audit?.issues ?? [];
  const expandable = issues.length > 0;

  return (
    <>
      <tr
        className={cn(
          "border-b border-border transition-colors last:border-0",
          skipped && "opacity-45",
          (onSelect || expandable) && "cursor-pointer hover:bg-accent/40",
        )}
        onClick={
          onSelect
            ? () => onSelect(lead)
            : expandable
              ? onToggle
              : undefined
        }
        title={
          onSelect
            ? "Open lead detail"
            : expandable
              ? `${issues.length} issue(s) — click to expand`
              : undefined
        }
      >
        <td className="px-3 py-[7px] font-mono text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {expandable && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="inline-flex"
                title={`${issues.length} issue(s) — expand inline`}
                aria-expanded={expanded}
                aria-label="Toggle issue list"
              >
                <motion.span
                  animate={{ rotate: expanded ? 90 : 0 }}
                  transition={spring.snappy}
                  className="inline-flex"
                >
                  <ChevronRight className="h-3 w-3" aria-hidden />
                </motion.span>
              </button>
            )}
            {rank}
          </span>
        </td>
        <td className="px-3 py-[7px]">
          <div className="truncate font-medium">{business.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {business.address}
          </div>
        </td>
        {/* Joey's fix: phone on ONE line, always */}
        <td className="whitespace-nowrap px-3 py-[7px] font-mono text-xs">
          {business.phone ?? <span className="text-muted-foreground">—</span>}
        </td>
        <td className="whitespace-nowrap px-3 py-[7px] font-mono text-xs">
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
        <td className="px-3 py-[7px]">
          <WebsiteCell lead={lead} />
        </td>
        <td className="px-3 py-[7px] text-right">
          <HealthCell health={health} stars={stars} />
        </td>
        <td className="px-3 py-[7px] text-right">
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
              {provisionalAudit && <ProvisionalTag />}
            </span>
          ) : (
            <span className="font-mono text-muted-foreground">—</span>
          )}
        </td>
        {/* Joey's fix: state chips on ONE line in a reserved-width column */}
        <td className="whitespace-nowrap px-3 py-[7px]">
          <StateChip lead={lead} />
        </td>
        {renderAction && (
          <td className="px-1 py-[7px] text-center" onClick={(e) => e.stopPropagation()}>
            {renderAction(lead)}
          </td>
        )}
      </tr>
      <tr className="border-0">
        <td colSpan={columns} className="p-0">
          <AnimatePresence initial={false}>
            {expanded && expandable && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={spring.expand}
                className="overflow-hidden border-b border-border bg-accent/30"
              >
                <div className="px-4 py-4 pl-12">
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                    What&rsquo;s wrong
                  </p>
                  <ul className="space-y-1.5">
                    {issues.map((issue, i) => (
                      <IssueBullet key={i} issue={issue} />
                    ))}
                  </ul>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </td>
      </tr>
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
          className="whitespace-nowrap text-[10px] tracking-tighter text-agent-waiting"
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
          "rounded-full border px-1.5 font-mono text-[10px] uppercase",
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
  if (kind === "none" || kind === "social_only") {
    return (
      <span className="whitespace-nowrap rounded-full border border-agent-waiting/50 bg-agent-waiting/10 px-2 py-0.5 text-[11px] text-agent-waiting">
        {kind === "none" ? "No website" : "Social only"}
      </span>
    );
  }
  let host = business.website_url ?? "";
  try {
    host = new URL(business.website_url ?? "").hostname.replace(/^www\./, "");
  } catch {
    // show the raw value
  }
  return (
    <span className="block truncate font-mono text-xs text-muted-foreground">
      {host}
    </span>
  );
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
        className="block truncate font-mono text-[11px] text-muted-foreground"
        title={audit.error_message ?? undefined}
      >
        Skipped · {audit.error_message}
      </span>
    );
  }
  if (isFailedAudit(audit)) {
    return <CouldNotAuditChip reason={failedAuditReason(audit)} />;
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
      <span className="rounded-full border border-agent-error/50 bg-agent-error/10 px-2 py-0.5 text-[11px] text-agent-error">
        Site broken — urgent
      </span>
    );
  }
  if ((audit.sellability_score ?? 0) >= 90) {
    return (
      <span className="rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
        Hot lead
      </span>
    );
  }
  return (
    <span className="font-mono text-[11px] text-agent-complete">scored</span>
  );
}
