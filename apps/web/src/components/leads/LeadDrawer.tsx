/**
 * Lead detail drawer (PRD 7.4, Glass v2) — right glass panel, 560px.
 * Tabs: Overview (status dropdown, sellability + stars, what's-wrong, key
 * signals) · Audit (per-agent raw findings, expandable) · History (all
 * audits for the business) · Notes (auto-saved) · Screenshots (Sprint 6
 * placeholder). Status + notes persist via POST /api/leads/:id/status.
 */
import { AnimatePresence, motion } from "framer-motion";
import {
  Camera,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileText,
  Loader2,
  PhoneCall,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  LeadStatusSchema,
  type Audit,
  type Issue,
  type LeadStatus,
} from "@rapidforge/shared";
import { Button } from "@/components/ui/button";
import { useLeadDrawer } from "@/features/leads/LeadDrawerContext";
import {
  downloadReport,
  fetchBusinessAudits,
  fetchBusinessCosts,
  generateBuilderBrief,
  generateSalesSummary,
  resolveAssetUrl,
  updateLeadStatus,
  type AnalystResult,
  type BusinessCostSummary,
  type LeadView,
  type SalesSummaryResult,
} from "@/lib/api";
import {
  failedAuditReason,
  isFailedAudit,
  isProvisionalAudit,
} from "@/lib/audit-flags";
import { formatCents, relativeTime } from "@/lib/format";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CouldNotAuditChip, ProvisionalTag } from "./AuditTags";

const LEAD_STATUSES = LeadStatusSchema.options;

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  called: "Called",
  interested: "Interested",
  sold: "Sold",
  dead: "Dead",
};

type TabKey =
  | "overview"
  | "audit"
  | "brief"
  | "sales"
  | "history"
  | "notes"
  | "screenshots";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "audit", label: "Audit" },
  { key: "brief", label: "Builder Brief" },
  { key: "sales", label: "Sales Script" },
  { key: "history", label: "History" },
  { key: "notes", label: "Notes" },
  { key: "screenshots", label: "Screenshots" },
];

const NOTES_DEBOUNCE_MS = 700;

export function LeadDrawer() {
  const { lead, closeLead } = useLeadDrawer();

  return (
    <AnimatePresence>
      {lead && (
        <>
          {/* Click-away veil — content stays visible beneath. */}
          <motion.div
            key="veil"
            className="fixed inset-0 z-30 bg-black/20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeLead}
            aria-hidden
          />
          <motion.aside
            key={lead.result.id}
            className="glass fixed inset-y-0 right-0 z-40 flex w-[560px] max-w-full flex-col shadow-float"
            initial={{ x: 560 }}
            animate={{ x: 0 }}
            exit={{ x: 560 }}
            transition={spring.default}
            role="dialog"
            aria-label={`Lead detail — ${lead.business.name}`}
          >
            <DrawerBody lead={lead} onClose={closeLead} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function DrawerBody({ lead, onClose }: { lead: LeadView; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>("overview");

  // Reset tab when a different lead opens in the same mounted drawer.
  useEffect(() => setTab("overview"), [lead.result.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <header className="flex items-start gap-3 border-b border-border/70 px-6 py-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {lead.business.name}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {lead.business.address ?? "No address on file"}
          </p>
        </div>
        <SellabilityBadge audit={lead.audit} />
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          title="Close"
          aria-label="Close lead detail"
        >
          <X />
        </Button>
      </header>

      <nav
        className="flex gap-1 border-b border-border/70 px-4 pt-2"
        aria-label="Lead detail tabs"
      >
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "relative rounded-t-lg px-3 py-2 text-xs transition-colors",
              tab === key
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-current={tab === key ? "page" : undefined}
          >
            {label}
            {tab === key && (
              <motion.span
                layoutId="drawer-tab-underline"
                transition={spring.default}
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
              />
            )}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === "overview" && <OverviewTab lead={lead} />}
        {tab === "audit" && (
          <AuditTab audit={lead.audit} businessId={lead.business.id} />
        )}
        {tab === "brief" && <BuilderBriefTab lead={lead} />}
        {tab === "sales" && <SalesScriptTab lead={lead} />}
        {tab === "history" && <HistoryTab businessId={lead.business.id} />}
        {tab === "notes" && <NotesTab lead={lead} />}
        {tab === "screenshots" && <ScreenshotsTab audit={lead.audit} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ lead }: { lead: LeadView }) {
  const { notifyLeadsChanged } = useLeadDrawer();
  const [status, setStatus] = useState<LeadStatus>(
    lead.result.status ?? "new",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => setStatus(lead.result.status ?? "new"),
    [lead.result.id, lead.result.status],
  );

  async function changeStatus(next: LeadStatus) {
    const previous = status;
    setStatus(next);
    setSaving(true);
    setError(null);
    try {
      await updateLeadStatus(lead.result.id, { status: next });
      notifyLeadsChanged();
    } catch (err) {
      setStatus(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const audit = lead.audit;
  const issues = audit?.issues ?? [];
  const analyst = (audit?.analyst_output as AnalystResult | null) ?? null;

  return (
    <div className="space-y-6">
      <section className="flex items-center gap-3">
        <label
          htmlFor="lead-status"
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
        >
          Status
        </label>
        <select
          id="lead-status"
          value={status}
          onChange={(e) => void changeStatus(e.target.value as LeadStatus)}
          className="h-9 rounded-xl border border-border bg-transparent px-3 text-sm outline-none ring-primary/40 focus:ring-2"
        >
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s} className="bg-background">
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        {saving && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        )}
        {error && <span className="text-xs text-agent-error">{error}</span>}
      </section>

      <section className="grid grid-cols-2 gap-3">
        <ScoreCard
          label="Sellability"
          value={audit?.sellability_score ?? null}
          accent="primary"
          provisional={isProvisionalAudit(audit)}
        />
        <ScoreCard
          label="Health"
          value={audit?.website_health_score ?? null}
          accent="health"
          stars={audit?.star_grade ?? null}
          provisional={isProvisionalAudit(audit)}
        />
      </section>

      {analyst && (
        <section>
          <SectionTitle>Analyst verdict</SectionTitle>
          <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
            <p className="text-sm font-medium leading-snug">
              {analyst.one_line_verdict}
            </p>
            <p className="mt-1.5 font-mono text-[11px] uppercase tracking-wider text-primary">
              {analyst.verdict.replace(/_/g, " ")} · {analyst.sales_lead_priority}
            </p>
          </div>
        </section>
      )}

      <section>
        <SectionTitle>What&rsquo;s wrong</SectionTitle>
        {issues.length > 0 ? (
          <ul className="space-y-1.5">
            {issues.map((issue, i) => (
              <IssueBullet key={i} issue={issue} />
            ))}
          </ul>
        ) : isFailedAudit(audit) ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CouldNotAuditChip reason={failedAuditReason(audit)} />
            {failedAuditReason(audit)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {audit
              ? "Nothing measurable is wrong — weakest pitch in the list."
              : "Not audited yet."}
          </p>
        )}
      </section>

      <section>
        <SectionTitle>Key signals</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Signal label="Phone" value={lead.business.phone} mono />
          <Signal
            label="Website"
            value={websiteLabel(lead)}
            title={lead.business.website_url ?? undefined}
            mono
          />
          <Signal
            label="Reviews"
            value={
              lead.business.google_rating !== null
                ? `★ ${lead.business.google_rating.toFixed(1)} · ${lead.business.review_count ?? 0}`
                : null
            }
            mono
          />
          <Signal label="Platform" value={audit?.platform ?? null} mono />
          <Signal
            label="Last action"
            value={relativeTime(lead.result.last_contacted_at)}
          />
          <Signal
            label="Follow-up"
            value={relativeTime(lead.result.next_followup_at)}
          />
        </dl>
      </section>

      {audit && audit.status === "completed" && (
        <DownloadReportButton businessId={lead.business.id} />
      )}
    </div>
  );
}

/** 2-page client-ready audit report (PDF, or printable HTML without Chrome). */
function DownloadReportButton({ businessId }: { businessId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      await downloadReport(businessId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => void download()}
        disabled={busy}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Download className="h-3.5 w-3.5" aria-hidden />
        )}
        {busy ? "Preparing report…" : "Download audit report"}
      </Button>
      {error && <p className="mt-1.5 text-xs text-agent-error">{error}</p>}
    </section>
  );
}

function websiteLabel(lead: LeadView): string | null {
  const kind = lead.business.website_kind ?? "unknown";
  if (kind === "none") return "No website — easiest pitch";
  if (kind === "social_only") return "Social only";
  if (!lead.business.website_url) return null;
  try {
    return new URL(lead.business.website_url).hostname.replace(/^www\./, "");
  } catch {
    return lead.business.website_url;
  }
}

// ---------------------------------------------------------------------------
// Audit — per-agent raw findings, expandable
// ---------------------------------------------------------------------------

/** Sprint 6 agent findings persisted by the Scorer in score_breakdown. */
interface V15Agents {
  design?: {
    modernity_0_100?: number;
    feels_like_year?: number;
    used_vision?: boolean;
    critical_issues?: Array<{ issue: string; evidence: string }>;
  };
  reputation?: {
    google_rating?: number | null;
    review_count?: number | null;
    volume_band?: string;
    review_velocity_per_month?: number | null;
    rating_divergence?: number | null;
    summary?: { verdict?: string; reasoning?: string };
  };
  seo?: {
    title?: { found: boolean; value: string | null };
    meta_description?: { found: boolean };
    h1_count?: number;
    schema_types?: string[];
    has_sitemap?: boolean | null;
    has_robots_txt?: boolean | null;
    summary?: { local_fit_score_1_5?: number; gaps?: string[] };
  };
}

function AuditTab({
  audit,
  businessId,
}: {
  audit: Audit | null;
  businessId: string;
}) {
  if (!audit) {
    return (
      <p className="text-sm text-muted-foreground">
        No audit yet — this lead is still queued or was skipped before audit.
      </p>
    );
  }
  const v15 =
    (audit.score_breakdown as { v15_agents?: V15Agents } | null)?.v15_agents ??
    {};
  const groups: Array<{ title: string; rows: Array<[string, ReactNode]> }> = [
    {
      title: "Health — PageSpeed + availability",
      rows: [
        ["Performance (desktop)", num(audit.ps_performance)],
        ["Performance (mobile)", num(audit.ps_mobile_performance)],
        ["Accessibility", num(audit.ps_accessibility)],
        ["SEO", num(audit.ps_seo)],
        ["Best practices", num(audit.ps_best_practices)],
        ["LCP", audit.ps_lcp_ms !== null ? `${audit.ps_lcp_ms} ms` : dash()],
        ["CLS", audit.ps_cls !== null ? String(audit.ps_cls) : dash()],
        ["HTTP status", num(audit.http_status)],
        ["SSL valid", bool(audit.ssl_valid)],
        [
          "Response time",
          audit.response_ms !== null ? `${audit.response_ms} ms` : dash(),
        ],
        ["Platform", audit.platform ?? dash()],
        ["Copyright year", num(audit.copyright_year)],
      ],
    },
    {
      title: "Conversion — on-page capture",
      rows: [
        ["Phone on site", bool(audit.has_phone)],
        ["Contact form", bool(audit.has_form)],
        ["Online booking", bool(audit.has_booking)],
        ["Chat widget", bool(audit.has_chat)],
      ],
    },
    {
      title: "Presence — technical hygiene",
      rows: [
        ["Viewport meta", bool(audit.has_viewport_meta)],
        ["Schema markup", bool(audit.has_schema_markup)],
        ["GBP photos", num(audit.gbp_photo_count)],
      ],
    },
    {
      title: "Traffic — real-user data",
      rows: [["CrUX field data", bool(audit.has_crux_data)]],
    },
    {
      title: "Design — visual critique",
      rows: [
        ["Modernity", num(v15.design?.modernity_0_100 ?? null)],
        ["Feels like year", num(v15.design?.feels_like_year ?? null)],
        [
          "Vision critique",
          v15.design === undefined ? dash() : bool(v15.design.used_vision ?? false),
        ],
        [
          "Critical issues",
          v15.design?.critical_issues?.length ? (
            <ul className="mt-1 space-y-1 text-left">
              {v15.design.critical_issues.map((item) => (
                <li key={item.issue} className="font-sans">
                  <span className="text-foreground">{item.issue}</span>
                  <span className="block text-muted-foreground">
                    {item.evidence}
                  </span>
                </li>
              ))}
            </ul>
          ) : v15.design ? (
            "none"
          ) : (
            dash()
          ),
        ],
      ],
    },
    {
      title: "Reputation — Google signals",
      rows: [
        ["Google rating", num(v15.reputation?.google_rating ?? null)],
        ["Reviews", num(v15.reputation?.review_count ?? null)],
        ["Verdict", v15.reputation?.summary?.verdict ?? dash()],
        ["Review volume", v15.reputation?.volume_band ?? dash()],
        [
          "Review velocity",
          v15.reputation?.review_velocity_per_month != null
            ? `${v15.reputation.review_velocity_per_month}/mo`
            : dash(),
        ],
        [
          "Yelp divergence",
          v15.reputation?.rating_divergence != null
            ? String(v15.reputation.rating_divergence)
            : "v1.5",
        ],
      ],
    },
    {
      title: "SEO — on-page + local fit",
      rows: [
        [
          "Local fit",
          v15.seo?.summary?.local_fit_score_1_5 != null
            ? `${v15.seo.summary.local_fit_score_1_5}/5`
            : dash(),
        ],
        [
          "Title",
          v15.seo?.title
            ? v15.seo.title.found
              ? (v15.seo.title.value ?? "present")
              : "missing"
            : dash(),
        ],
        [
          "Meta description",
          v15.seo ? bool(v15.seo.meta_description?.found ?? false) : dash(),
        ],
        ["H1 count", num(v15.seo?.h1_count ?? null)],
        [
          "Schema types",
          v15.seo?.schema_types
            ? v15.seo.schema_types.join(", ") || "none"
            : dash(),
        ],
        ["sitemap.xml", bool(v15.seo?.has_sitemap ?? null)],
        ["robots.txt", bool(v15.seo?.has_robots_txt ?? null)],
        [
          "Gaps",
          v15.seo?.summary?.gaps?.length ? (
            <ul className="mt-1 space-y-0.5 text-left font-sans">
              {v15.seo.summary.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          ) : v15.seo ? (
            "none"
          ) : (
            dash()
          ),
        ],
      ],
    },
    {
      title: "Scorer — breakdown",
      rows: [
        ["Health score", num(audit.website_health_score)],
        ["Star grade", num(audit.star_grade)],
        ["Sellability", num(audit.sellability_score)],
        [
          "Breakdown",
          audit.score_breakdown ? (
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-accent/40 p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(audit.score_breakdown, null, 2)}
            </pre>
          ) : (
            dash()
          ),
        ],
      ],
    },
  ];

  return (
    <div className="space-y-2">
      <AuditCostReadout businessId={businessId} />
      {groups.map((group) => (
        <Disclosure key={group.title} title={group.title}>
          <dl className="space-y-1.5">
            {group.rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3 text-xs">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      ))}
      {audit.error_message && (
        <p className="rounded-xl border border-agent-error/40 bg-agent-error/10 px-3.5 py-2 text-xs text-agent-error">
          {audit.error_message}
        </p>
      )}
    </div>
  );
}

/** Read-only per-agent AI spend for the business (from agent_runs, S8). */
function AuditCostReadout({ businessId }: { businessId: string }) {
  const [costs, setCosts] = useState<BusinessCostSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCosts(null);
    fetchBusinessCosts(businessId).then(
      (c) => {
        if (!cancelled) setCosts(c);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  if (!costs) return null;
  const spenders = costs.by_agent.filter((r) => r.cost_cents > 0);

  return (
    <div className="rounded-xl border border-border/70 p-3.5">
      <div className="mb-2 flex items-baseline justify-between">
        <SectionTitle>AI cost</SectionTitle>
        <span className="font-mono text-xs">
          <span className="text-foreground">
            {formatCents(costs.business_total_cents)}
          </span>
          <span className="text-muted-foreground"> this lead</span>
          {costs.search_total_cents !== null && (
            <span className="text-muted-foreground">
              {" · "}
              {formatCents(costs.search_total_cents)} search
            </span>
          )}
        </span>
      </div>
      {spenders.length > 0 ? (
        <dl className="space-y-1">
          {spenders.map((row) => (
            <div
              key={row.agent}
              className="flex items-baseline justify-between text-xs"
            >
              <dt className="capitalize text-muted-foreground">
                {row.agent}
                {row.runs > 1 && (
                  <span className="text-muted-foreground/60"> ×{row.runs}</span>
                )}
              </dt>
              <dd className="font-mono">{formatCents(row.cost_cents)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">
          No AI spend recorded — deterministic scoring or template mode.
        </p>
      )}
    </div>
  );
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border/70">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs font-medium"
        aria-expanded={open}
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={spring.snappy}
          className="inline-flex"
        >
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </motion.span>
        {title}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.expand}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 px-3.5 py-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History — every audit for this business (PRD 5.5: audits are append-only)
// ---------------------------------------------------------------------------

function HistoryTab({ businessId }: { businessId: string }) {
  const [audits, setAudits] = useState<Audit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAudits(null);
    setError(null);
    fetchBusinessAudits(businessId)
      .then((rows) => {
        if (!cancelled) setAudits(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  if (error) return <p className="text-xs text-agent-error">{error}</p>;
  if (audits === null) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
        Loading history…
      </p>
    );
  }
  if (audits.length === 0) {
    return <p className="text-sm text-muted-foreground">No audits yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {audits.map((audit) => (
        <li
          key={audit.id}
          className="flex items-center justify-between gap-3 rounded-xl border border-border/70 px-3.5 py-2.5 text-xs"
        >
          <span className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {audit.completed_at
              ? new Date(audit.completed_at).toLocaleString()
              : `${audit.status ?? "pending"}…`}
            {isFailedAudit(audit) && (
              <CouldNotAuditChip reason={failedAuditReason(audit)} />
            )}
          </span>
          <span className="font-mono">
            health {audit.website_health_score ?? "—"} · sell{" "}
            {audit.sellability_score ?? "—"}
            {isProvisionalAudit(audit) && <ProvisionalTag />}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Notes — auto-saved to search_results.notes (PRD 7.4)
// ---------------------------------------------------------------------------

function NotesTab({ lead }: { lead: LeadView }) {
  const { notifyLeadsChanged } = useLeadDrawer();
  const [notes, setNotes] = useState(lead.result.notes ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const timer = useRef<number | null>(null);
  const latest = useRef(notes);

  useEffect(() => {
    setNotes(lead.result.notes ?? "");
    setState("idle");
  }, [lead.result.id]);

  const save = useCallback(
    async (value: string) => {
      setState("saving");
      try {
        await updateLeadStatus(lead.result.id, { notes: value });
        notifyLeadsChanged();
        setState("saved");
      } catch {
        setState("error");
      }
    },
    [lead.result.id, notifyLeadsChanged],
  );

  function onChange(value: string) {
    setNotes(value);
    latest.current = value;
    setState("idle");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void save(latest.current);
    }, NOTES_DEBOUNCE_MS);
  }

  // Flush a pending debounce when the tab/drawer unmounts.
  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        void save(latest.current);
      }
    };
  }, [save]);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionTitle>Notes</SectionTitle>
        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          {state === "saving" && (
            <>
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> saving…
            </>
          )}
          {state === "saved" && (
            <>
              <Check className="h-3 w-3 text-agent-complete" aria-hidden /> saved
            </>
          )}
          {state === "error" && (
            <span className="text-agent-error">save failed — retrying on next edit</span>
          )}
        </span>
      </div>
      <textarea
        value={notes}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Call outcomes, decision makers, follow-up angles…"
        className="min-h-[280px] flex-1 resize-none rounded-xl border border-border bg-transparent p-3.5 text-sm leading-relaxed outline-none ring-primary/40 placeholder:text-muted-foreground/60 focus:ring-2"
        aria-label="Lead notes (auto-saved)"
      />
      <p className="text-[11px] text-muted-foreground">
        Auto-saves as you type.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screenshots (Sprint 6) — desktop + mobile homepage captures off the audit
// ---------------------------------------------------------------------------

function ScreenshotsTab({ audit }: { audit: Audit | null }) {
  const desktop = audit?.screenshot_desktop_url ?? null;
  const mobile = audit?.screenshot_mobile_url ?? null;

  if (!desktop && !mobile) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
        <Camera className="h-6 w-6" aria-hidden />
        <p className="text-sm">No screenshots for this audit.</p>
        <p className="text-xs">
          Captured on the next audit run (no website — or capture unavailable).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {desktop && (
        <ScreenshotFigure
          url={desktop}
          label="Desktop · 1440px"
          alt="Desktop homepage screenshot"
        />
      )}
      {mobile && (
        <ScreenshotFigure
          url={mobile}
          label="Mobile · 390px"
          alt="Mobile homepage screenshot"
          narrow
        />
      )}
    </div>
  );
}

function ScreenshotFigure({
  url,
  label,
  alt,
  narrow = false,
}: {
  url: string;
  label: string;
  alt: string;
  narrow?: boolean;
}) {
  const src = resolveAssetUrl(url);
  return (
    <figure>
      <SectionTitle>{label}</SectionTitle>
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        title="Open full size"
        className={cn(
          "block overflow-hidden rounded-xl border border-border bg-card transition-opacity hover:opacity-90",
          narrow && "mx-auto max-w-[240px]",
        )}
      >
        <img src={src} alt={alt} loading="lazy" className="block w-full" />
      </a>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Builder Brief (PRD 6.12) — on-demand Fable 5 markdown, generate/copy/regen
// ---------------------------------------------------------------------------

/** A completed audit is required before either money deliverable can run. */
function auditReadyFor(lead: LeadView): boolean {
  return lead.audit !== null && lead.audit.status === "completed";
}

function DeliverableLocked({ kind }: { kind: "brief" | "script" }) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center text-muted-foreground">
      {kind === "brief" ? (
        <FileText className="h-6 w-6" aria-hidden />
      ) : (
        <PhoneCall className="h-6 w-6" aria-hidden />
      )}
      <p className="text-sm">Audit this lead first.</p>
      <p className="text-xs">
        The {kind === "brief" ? "Builder Brief" : "sales script"} is generated
        from a completed audit.
      </p>
    </div>
  );
}

function BuilderBriefTab({ lead }: { lead: LeadView }) {
  const [markdown, setMarkdown] = useState<string | null>(
    lead.audit?.builder_brief_md ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMarkdown(lead.audit?.builder_brief_md ?? null);
    setError(null);
  }, [lead.result.id, lead.audit?.builder_brief_md]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await generateBuilderBrief(lead.business.id);
      setMarkdown(r.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (!auditReadyFor(lead)) return <DeliverableLocked kind="brief" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>Builder Brief</SectionTitle>
        <div className="flex items-center gap-1.5">
          {markdown && (
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-agent-complete" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          <Button
            variant={markdown ? "outline" : "default"}
            size="sm"
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : markdown ? (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
            )}
            {busy ? "Generating…" : markdown ? "Regenerate" : "Generate brief"}
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-agent-error">{error}</p>}
      {markdown ? (
        <div className="rounded-xl border border-border bg-card">
          <pre className="max-h-[62vh] overflow-auto whitespace-pre-wrap p-4 font-mono text-[11px] leading-relaxed">
            {markdown}
          </pre>
        </div>
      ) : (
        !busy && (
          <p className="text-sm text-muted-foreground">
            Generate a paste-ready rebuild brief (Fable 5) from this audit —
            competitors, keywords, pages, SEO, conversion, and deploy steps a
            developer can scaffold from directly.
          </p>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sales Script (PRD 6.13) — on-demand Sonnet talk track + objections
// ---------------------------------------------------------------------------

function SalesScriptTab({ lead }: { lead: LeadView }) {
  const [script, setScript] = useState<SalesSummaryResult | null>(
    (lead.audit?.sales_summary as SalesSummaryResult | null) ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setScript((lead.audit?.sales_summary as SalesSummaryResult | null) ?? null);
    setError(null);
  }, [lead.result.id, lead.audit?.sales_summary]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setScript(await generateSalesSummary(lead.business.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!script) return;
    await navigator.clipboard.writeText(script.full_talk_track);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (!auditReadyFor(lead)) return <DeliverableLocked kind="script" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>Sales script</SectionTitle>
        <div className="flex items-center gap-1.5">
          {script && (
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-agent-complete" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          <Button
            variant={script ? "outline" : "default"}
            size="sm"
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : script ? (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
            )}
            {busy ? "Generating…" : script ? "Regenerate" : "Generate script"}
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-agent-error">{error}</p>}
      {script ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <SectionTitle>Talk track · ~60s</SectionTitle>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {script.full_talk_track}
            </p>
          </div>
          <div>
            <SectionTitle>Anticipated objections</SectionTitle>
            <ul className="space-y-2">
              {script.anticipated_objections.map((o, i) => (
                <li
                  key={i}
                  className="rounded-xl border border-border/70 px-3.5 py-2.5 text-xs"
                >
                  <p className="font-medium">&ldquo;{o.objection}&rdquo;</p>
                  <p className="mt-1 text-muted-foreground">{o.response}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        !busy && (
          <p className="text-sm text-muted-foreground">
            Generate a ~60-second cold-call talk track (Sonnet) that opens with
            a specific audit finding, plus 2–3 objections and responses.
          </p>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

function SellabilityBadge({ audit }: { audit: Audit | null }) {
  const sell = audit?.sellability_score ?? null;
  if (sell === null) return null;
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-1 font-mono text-sm font-semibold",
        sell >= 90
          ? "border-primary/50 bg-primary/10 text-primary"
          : sell >= 70
            ? "border-agent-waiting/50 bg-agent-waiting/10 text-agent-waiting"
            : "border-border text-muted-foreground",
      )}
      title="Sellability score"
    >
      {sell}
    </span>
  );
}

function ScoreCard({
  label,
  value,
  accent,
  stars,
  provisional = false,
}: {
  label: string;
  value: number | null;
  accent: "primary" | "health";
  stars?: number | null;
  /** Placeholder score (bot-blocked audit) — tagged, not presented as measured. */
  provisional?: boolean;
}) {
  const color =
    value === null
      ? "text-muted-foreground"
      : accent === "primary"
        ? value >= 90
          ? "text-primary"
          : value >= 70
            ? "text-agent-waiting"
            : "text-foreground"
        : value >= 70
          ? "text-agent-complete"
          : value >= 40
            ? "text-agent-waiting"
            : "text-agent-error";
  return (
    <div className="rounded-xl border border-border/70 px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("font-mono text-2xl font-semibold", color)}>
        {value ?? "—"}
        {provisional && value !== null && <ProvisionalTag className="ml-2" />}
      </p>
      {stars !== undefined && stars !== null && (
        <p
          className="text-[11px] tracking-tighter text-agent-waiting"
          aria-label={`${stars} star grade`}
        >
          {"★".repeat(Math.round(stars))}
          <span className="text-muted-foreground/40">
            {"★".repeat(Math.max(0, 5 - Math.round(stars)))}
          </span>
        </p>
      )}
    </div>
  );
}

function Signal({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  title?: string;
}) {
  return (
    <>
      <dt className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn("truncate text-right text-xs", mono && "font-mono")}
        title={title ?? value ?? undefined}
      >
        {value ?? <span className="text-muted-foreground">—</span>}
      </dd>
    </>
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

function num(value: number | null): ReactNode {
  return value !== null ? String(value) : dash();
}

function bool(value: boolean | null): ReactNode {
  if (value === null) return dash();
  return value ? (
    <span className="text-agent-complete">yes</span>
  ) : (
    <span className="text-agent-error">no</span>
  );
}

function dash(): ReactNode {
  return <span className="text-muted-foreground">—</span>;
}
