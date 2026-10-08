/**
 * Leads view (PRD 7.3 Lead List, Glass v2) — every lead in the workspace
 * across ALL searches. Sortable columns, filters (has/no website, platform,
 * status, score ranges), bulk select → CSV export / status update /
 * re-audit (force flag honors the 30-day cache override). Row click opens
 * the lead drawer.
 */
import { ArrowDown, ArrowUp, Download, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LeadStatusSchema, type LeadStatus } from "@rapidforge/shared";
import { CoachingTip } from "@/components/CoachingTip";
import { ProvisionalTag } from "@/components/leads/AuditTags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import {
  fetchWorkspaceLeads,
  reauditBusiness,
  updateLeadStatus,
  type LeadView,
} from "@/lib/api";
import { isProvisionalAudit } from "@/lib/audit-flags";
import { downloadCsv, leadsToCsv } from "@/lib/csv";
import { dedupeLeads, type DedupedLead } from "@/lib/dedupe";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUSES = LeadStatusSchema.options;

type WebsiteFilter = "all" | "has" | "none";
type SortKey =
  | "name"
  | "rating"
  | "reviews"
  | "platform"
  | "health"
  | "sellability"
  | "status"
  | "last_action";

interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

function sortValue(lead: DedupedLead, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return lead.business.name.toLowerCase();
    case "rating":
      return lead.business.google_rating;
    case "reviews":
      return lead.business.review_count;
    case "platform":
      return lead.audit?.platform ?? null;
    case "health":
      return lead.audit?.website_health_score ?? null;
    case "sellability":
      return lead.audit?.sellability_score ?? null;
    case "status":
      return lead.result.status ?? "new";
    case "last_action":
      return lead.result.last_contacted_at ?? null;
  }
}

export function LeadsView() {
  const {
    lead: drawerLead,
    openLead,
    leadsVersion,
    notifyLeadsChanged,
    selectedLeadIds: selected,
    setSelectedLeadIds: setSelected,
  } = useLeadDrawer();
  const [leads, setLeads] = useState<LeadView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // filters
  const [website, setWebsite] = useState<WebsiteFilter>("all");
  const [platform, setPlatform] = useState<string>("all");
  const [status, setStatus] = useState<LeadStatus | "all">("all");
  const [sellMin, setSellMin] = useState("");
  const [sellMax, setSellMax] = useState("");
  const [healthMin, setHealthMin] = useState("");
  const [healthMax, setHealthMax] = useState("");

  const [sort, setSort] = useState<SortState>({ key: "sellability", dir: -1 });
  const [bulkStatus, setBulkStatus] = useState<LeadStatus>("called");
  const [forceReaudit, setForceReaudit] = useState(false);
  const [busy, setBusy] = useState(false);

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

  // Keep an open drawer on the fresh row (re-audit scores, RFL.WEB.10).
  useEffect(() => {
    if (!drawerLead || !leads) return;
    const fresh = leads.find((l) => l.result.id === drawerLead.result.id);
    if (fresh && fresh !== drawerLead) openLead(fresh);
  }, [leads, drawerLead, openLead]);

  const platforms = useMemo(() => {
    const set = new Set<string>();
    for (const lead of leads ?? []) {
      if (lead.audit?.platform) set.add(lead.audit.platform);
    }
    return [...set].sort();
  }, [leads]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    const bounds = {
      sellMin: sellMin === "" ? null : Number(sellMin),
      sellMax: sellMax === "" ? null : Number(sellMax),
      healthMin: healthMin === "" ? null : Number(healthMin),
      healthMax: healthMax === "" ? null : Number(healthMax),
    };
    // One row per business across all searches (S5.5 dedupe).
    const rows = dedupeLeads(leads).filter((lead) => {
      const kind = lead.business.website_kind ?? "unknown";
      if (website === "has" && kind !== "real") return false;
      if (website === "none" && kind !== "none" && kind !== "social_only")
        return false;
      if (platform !== "all" && lead.audit?.platform !== platform) return false;
      if (status !== "all" && (lead.result.status ?? "new") !== status)
        return false;
      const sell = lead.audit?.sellability_score ?? null;
      if (bounds.sellMin !== null && (sell ?? -1) < bounds.sellMin) return false;
      if (bounds.sellMax !== null && (sell ?? 101) > bounds.sellMax)
        return false;
      const health = lead.audit?.website_health_score ?? null;
      if (bounds.healthMin !== null && (health ?? -1) < bounds.healthMin)
        return false;
      if (bounds.healthMax !== null && (health ?? 101) > bounds.healthMax)
        return false;
      return true;
    });
    return [...rows].sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return 0;
    });
  }, [leads, website, platform, status, sellMin, sellMax, healthMin, healthMax, sort]);

  const allSelected =
    filtered.length > 0 && filtered.every((l) => selected.has(l.result.id));

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 },
    );
  }

  function toggleAll() {
    setSelected(
      allSelected ? new Set() : new Set(filtered.map((l) => l.result.id)),
    );
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  const selectedLeads = filtered.filter((l) => selected.has(l.result.id));

  function exportCsv() {
    const rows = selectedLeads.length > 0 ? selectedLeads : filtered;
    downloadCsv(
      `rapidforge-leads-${new Date().toISOString().slice(0, 10)}.csv`,
      leadsToCsv(rows),
    );
    setNotice(
      `Exported ${rows.length} lead${rows.length === 1 ? "" : "s"} to CSV`,
    );
  }

  async function applyBulkStatus() {
    if (selectedLeads.length === 0) return;
    setBusy(true);
    setError(null);
    let ok = 0;
    for (const lead of selectedLeads) {
      try {
        await updateLeadStatus(lead.result.id, { status: bulkStatus });
        ok += 1;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    setBusy(false);
    setNotice(`Updated ${ok}/${selectedLeads.length} leads → ${bulkStatus}`);
    notifyLeadsChanged();
  }

  async function bulkReaudit() {
    if (selectedLeads.length === 0) return;
    setBusy(true);
    setError(null);
    const businessIds = [...new Set(selectedLeads.map((l) => l.business.id))];
    let ok = 0;
    for (const id of businessIds) {
      try {
        await reauditBusiness(id, { force: forceReaudit });
        ok += 1;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    setBusy(false);
    setNotice(
      `Re-audit queued for ${ok}/${businessIds.length} businesses${forceReaudit ? " (forced fresh)" : " (30-day cache respected)"}`,
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
            Pipeline
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            All leads{" "}
            <span className="font-mono text-base text-muted-foreground">
              {leads ? filtered.length : "…"}
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Export CSV{selectedLeads.length > 0 ? ` (${selectedLeads.length})` : ""}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            title="Refresh"
            aria-label="Refresh leads"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <CoachingTip tipId="leads" title="Every lead, in one list">
        Open any row for the drawer; export CSV from here. Tick rows to change
        status or re-audit several at once.
      </CoachingTip>

      {/* Filter bar */}
      <div className="card-panel flex flex-wrap items-center gap-2 px-4 py-3 text-xs">
        <FilterSelect
          label="Website"
          value={website}
          onChange={(v) => setWebsite(v as WebsiteFilter)}
          options={[
            { value: "all", label: "All" },
            { value: "has", label: "Has website" },
            { value: "none", label: "No / social only" },
          ]}
        />
        <FilterSelect
          label="Platform"
          value={platform}
          onChange={setPlatform}
          options={[
            { value: "all", label: "All" },
            ...platforms.map((p) => ({ value: p, label: p })),
          ]}
        />
        <FilterSelect
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as LeadStatus | "all")}
          options={[
            { value: "all", label: "All" },
            ...STATUSES.map((s) => ({ value: s, label: s })),
          ]}
        />
        <RangeInput label="Sell ≥" value={sellMin} onChange={setSellMin} />
        <RangeInput label="Sell ≤" value={sellMax} onChange={setSellMax} />
        <RangeInput label="Health ≥" value={healthMin} onChange={setHealthMin} />
        <RangeInput label="Health ≤" value={healthMax} onChange={setHealthMax} />
      </div>

      {/* Bulk action bar */}
      {selectedLeads.length > 0 && (
        <div className="card-panel flex flex-wrap items-center gap-3 border-primary/40 px-4 py-2.5 text-xs">
          <span className="font-mono">
            {selectedLeads.length} selected
          </span>
          <span className="h-4 w-px bg-border" aria-hidden />
          <label className="flex items-center gap-1.5">
            Set status
            <select
              value={bulkStatus}
              onChange={(e) => setBulkStatus(e.target.value as LeadStatus)}
              className="h-7 rounded-lg border border-border bg-transparent px-2 text-xs outline-none"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="bg-background">
                  {s}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void applyBulkStatus()}
          >
            Apply
          </Button>
          <span className="h-4 w-px bg-border" aria-hidden />
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={forceReaudit}
              onChange={(e) => setForceReaudit(e.target.checked)}
              className="accent-[hsl(var(--primary))]"
            />
            Force fresh (ignore 30-day cache)
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void bulkReaudit()}
          >
            {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden />}
            Re-audit
          </Button>
          <span className="flex-1" />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      {notice && (
        <p className="rounded-xl border border-agent-complete/40 bg-agent-complete/10 px-3.5 py-2 text-xs text-agent-complete">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-3.5 py-2 text-xs text-agent-error">
          {error}
        </p>
      )}

      {/* Table */}
      <div className="card-panel dense-surface overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-[124px]" />
            <col className="w-[76px]" />
            <col className="w-[84px]" />
            <col className="w-[104px]" />
            <col className="w-[76px]" />
            <col className="w-[64px]" />
            <col className="w-[110px]" />
            <col className="w-[110px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-[7px]">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-[hsl(var(--primary))]"
                  aria-label="Select all filtered leads"
                />
              </th>
              <SortHeader label="Business" k="name" sort={sort} onSort={toggleSort} />
              <th className="px-3 py-[7px] font-medium">Website</th>
              <SortHeader label="Rating" k="rating" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="Reviews" k="reviews" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="Platform" k="platform" sort={sort} onSort={toggleSort} />
              <SortHeader label="Health" k="health" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="Sell" k="sellability" sort={sort} onSort={toggleSort} align="right" />
              <SortHeader label="Status" k="status" sort={sort} onSort={toggleSort} />
              <SortHeader label="Last action" k="last_action" sort={sort} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {leads === null && (
              <tr>
                <td colSpan={10} className="px-4 py-14 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
                    Loading leads…
                  </span>
                </td>
              </tr>
            )}
            {leads !== null && filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-14 text-center text-sm text-muted-foreground">
                  No leads match the filters.
                </td>
              </tr>
            )}
            {filtered.map((lead) => (
              <LeadRow
                key={lead.result.id}
                lead={lead}
                checked={selected.has(lead.result.id)}
                onCheck={() => toggleOne(lead.result.id)}
                onOpen={() => openLead(lead)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align,
}: {
  label: string;
  k: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "right";
}) {
  return (
    <th className={cn("px-3 py-[7px] font-medium", align === "right" && "text-right")}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className="inline-flex items-center gap-1 uppercase hover:text-foreground"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {sort.key === k &&
          (sort.dir === -1 ? (
            <ArrowDown className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowUp className="h-3 w-3" aria-hidden />
          ))}
      </button>
    </th>
  );
}

function LeadRow({
  lead,
  checked,
  onCheck,
  onOpen,
}: {
  lead: DedupedLead;
  checked: boolean;
  onCheck: () => void;
  onOpen: () => void;
}) {
  const { business, audit, result } = lead;
  const health = audit?.website_health_score ?? null;
  const sell = audit?.sellability_score ?? null;
  const status = result.status ?? "new";

  return (
    <tr
      className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-accent/40"
      onClick={onOpen}
      title="Open lead detail"
    >
      <td className="px-3 py-[7px]" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onCheck}
          className="accent-[hsl(var(--primary))]"
          aria-label={`Select ${business.name}`}
        />
      </td>
      <td className="px-3 py-[7px]">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{business.name}</span>
          {lead.seenIn > 1 && (
            <span
              className="shrink-0 rounded-full border border-border px-1.5 font-mono text-[10px] text-muted-foreground"
              title={`Seen in ${lead.seenIn} searches`}
            >
              ×{lead.seenIn}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {business.phone ?? "no phone"}
        </div>
      </td>
      <td className="truncate px-3 py-[7px] font-mono text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate">{websiteHost(lead)}</span>
          {business.demo_url && (
            // RFL.DEMO.1: the built demo site, opened without opening the row.
            <a
              href={business.demo_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 rounded-full border border-primary/50 bg-primary/10 px-1.5 text-[10px] text-primary hover:bg-primary/20"
              title={business.demo_url}
            >
              Demo
            </a>
          )}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-[7px] text-right font-mono text-xs">
        {business.google_rating !== null ? (
          <>
            <span className="text-agent-waiting">★</span>{" "}
            {business.google_rating.toFixed(1)}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-[7px] text-right font-mono text-xs">
        {business.review_count ?? "—"}
      </td>
      <td className="truncate px-3 py-[7px] font-mono text-xs text-muted-foreground">
        {audit?.platform ?? "—"}
      </td>
      <td
        className={cn(
          "px-3 py-[7px] text-right font-mono text-sm font-semibold",
          health === null
            ? "text-muted-foreground"
            : health >= 70
              ? "text-agent-complete"
              : health >= 40
                ? "text-agent-waiting"
                : "text-agent-error",
        )}
      >
        {health ?? "—"}
      </td>
      <td
        className={cn(
          "px-3 py-[7px] text-right font-mono text-sm font-semibold",
          sell === null
            ? "text-muted-foreground"
            : sell >= 90
              ? "text-primary"
              : sell >= 70
                ? "text-agent-waiting"
                : "text-foreground",
        )}
      >
        {sell ?? "—"}
        {isProvisionalAudit(audit) && <ProvisionalTag />}
      </td>
      <td className="whitespace-nowrap px-3 py-[7px]">
        <StatusChip status={status} />
      </td>
      <td className="whitespace-nowrap px-3 py-[7px] text-xs text-muted-foreground">
        {relativeTime(result.last_contacted_at) ?? "—"}
      </td>
    </tr>
  );
}

function websiteHost(lead: LeadView): string {
  const kind = lead.business.website_kind ?? "unknown";
  if (kind === "none") return "no website";
  if (kind === "social_only") return "social only";
  try {
    return new URL(lead.business.website_url ?? "").hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    return lead.business.website_url ?? "—";
  }
}

function StatusChip({ status }: { status: LeadStatus }) {
  const styles: Record<LeadStatus, string> = {
    new: "border-border text-muted-foreground",
    called: "border-agent-waiting/50 bg-agent-waiting/10 text-agent-waiting",
    interested: "border-primary/50 bg-primary/10 text-primary",
    sold: "border-agent-complete/50 bg-agent-complete/10 text-agent-complete",
    dead: "border-agent-error/50 bg-agent-error/10 text-agent-error",
  };
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[11px]",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-lg border border-border bg-transparent px-2 text-xs text-foreground outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-background">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RangeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-muted-foreground">
      {label}
      <Input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
        className="h-7 w-16 px-2 font-mono text-xs"
      />
    </label>
  );
}
