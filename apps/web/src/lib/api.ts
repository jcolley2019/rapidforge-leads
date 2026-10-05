/**
 * Worker HTTP API client (PRD Section 8). The web app talks to the worker
 * with the caller's Supabase JWT; in offline preview mode (no Supabase
 * env) it sends a placeholder token that the worker's dev mode accepts.
 *
 * Base URL: VITE_WORKER_URL when web and worker live on different origins
 * (Vercel → Railway); empty in dev, where Vite proxies /api to
 * localhost:8788. No secrets here — ever (CLAUDE.md Section 9).
 */
import type {
  AgentRun,
  Audit,
  Business,
  CreateSearchRequest,
  DesignBrief,
  Search,
  SearchResult,
  UpdateLeadStatusRequest,
  UpdateWorkspaceConfigRequest,
  UsageSummary,
  WorkspaceConfig,
} from "@rapidforge/shared";
import { supabase } from "@/lib/supabase";

const WORKER_URL: string = import.meta.env.VITE_WORKER_URL ?? "";

/**
 * Resolve a worker-relative asset URL (e.g. fixture screenshots stored as
 * "/fixtures/screenshots/…") against the worker base. Absolute URLs
 * (Supabase Storage public URLs) pass through untouched.
 */
export function resolveAssetUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${WORKER_URL}${url}`;
}

/** Mirrors the worker's LeadView/SearchDetail read models. */
export interface LeadView {
  result: SearchResult;
  business: Business;
  audit: Audit | null;
}

export interface JobCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
}

export interface SearchDetail {
  search: Search;
  leads: LeadView[];
  agent_states: AgentRun[];
  job_counts: JobCounts;
}

async function bearerToken(): Promise<string> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) return token;
  }
  // Worker dev mode (no Supabase env) accepts any non-empty token.
  return "dev-offline";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await bearerToken()}`,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; details?: string[] };
      if (body.error) message = body.error;
      if (body.details?.length) message += ` — ${body.details.join("; ")}`;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function createSearch(
  request: CreateSearchRequest,
): Promise<{ search_id: string; status: string }> {
  return apiFetch("/api/searches", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function fetchSearchDetail(id: string): Promise<SearchDetail> {
  return apiFetch(`/api/searches/${encodeURIComponent(id)}`);
}

export interface CancelSearchResult {
  status: string;
  queued_failed: number;
  running_aborted: number;
}

/** Stop a running search: queued jobs fail, in-flight ones abort (RFL.WEB.10). */
export async function cancelSearch(id: string): Promise<CancelSearchResult> {
  return apiFetch(`/api/searches/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Sprint 5: pipeline / drawer / leads / settings / usage (PRD Section 8)
// ---------------------------------------------------------------------------

/** Every lead in the workspace, all searches — Pipeline + Leads views. */
export async function fetchWorkspaceLeads(): Promise<LeadView[]> {
  const { leads } = await apiFetch<{ leads: LeadView[] }>("/api/leads");
  return leads;
}

/** Recent searches, newest first — dashboard (S5.5). */
export async function fetchRecentSearches(limit = 20): Promise<Search[]> {
  const { searches } = await apiFetch<{ searches: Search[] }>(
    `/api/searches?limit=${limit}`,
  );
  return searches;
}

/** Status / notes / follow-up patch. Returns the updated lead row. */
export async function updateLeadStatus(
  id: string,
  patch: UpdateLeadStatusRequest,
): Promise<SearchResult> {
  const { lead } = await apiFetch<{ lead: SearchResult }>(
    `/api/leads/${encodeURIComponent(id)}/status`,
    { method: "POST", body: JSON.stringify(patch) },
  );
  return lead;
}

/** Audit history for the drawer's History tab — newest first. */
export async function fetchBusinessAudits(businessId: string): Promise<Audit[]> {
  const { audits } = await apiFetch<{ audits: Audit[] }>(
    `/api/businesses/${encodeURIComponent(businessId)}/audits`,
  );
  return audits;
}

export interface AgentCostRow {
  agent: string;
  cost_cents: number;
  runs: number;
}

export interface BusinessCostSummary {
  by_agent: AgentCostRow[];
  business_total_cents: number;
  search_total_cents: number | null;
}

/** Per-agent AI spend for a business (drawer Audit-tab readout, S8). */
export async function fetchBusinessCosts(
  businessId: string,
): Promise<BusinessCostSummary> {
  return apiFetch(`/api/businesses/${encodeURIComponent(businessId)}/costs`);
}

/** Enqueue a fresh audit; force=true bypasses the 30-day cache (PRD 5.5). */
export async function reauditBusiness(
  businessId: string,
  options: { force: boolean },
): Promise<{ job_id: string; status: string }> {
  return apiFetch(
    `/api/businesses/${encodeURIComponent(businessId)}/reaudit`,
    { method: "POST", body: JSON.stringify(options) },
  );
}

/** Current-month usage_events rollup — the top-bar meter. */
export async function fetchUsage(): Promise<UsageSummary> {
  return apiFetch("/api/usage");
}

/** The workspace's cascading variables (Settings). */
export async function fetchConfig(): Promise<WorkspaceConfig> {
  const { config } = await apiFetch<{ config: WorkspaceConfig }>("/api/config");
  return config;
}

export async function saveConfig(
  patch: UpdateWorkspaceConfigRequest,
): Promise<WorkspaceConfig> {
  const { config } = await apiFetch<{ config: WorkspaceConfig }>(
    "/api/config",
    { method: "PUT", body: JSON.stringify(patch) },
  );
  return config;
}

// ---------------------------------------------------------------------------
// Sprint 7: on-demand money agents (PRD 6.11–6.13). These mint the deliverable
// on the worker (Fable 5 / Sonnet) and persist it on the latest audit.
// ---------------------------------------------------------------------------

export interface AnalystResult {
  verdict: string;
  sales_lead_priority: string;
  top_3_improvements: Array<{
    priority: number;
    improvement: string;
    rationale: string;
    estimated_impact: string;
  }>;
  reasoning: string;
  one_line_verdict: string;
}

export interface SalesSummaryResult {
  opener: string;
  earned_observation: string;
  pain_hypothesis: string;
  offer: string;
  soft_close: string;
  full_talk_track: string;
  anticipated_objections: Array<{ objection: string; response: string }>;
}

export interface BuilderBriefResult {
  markdown: string;
  word_count: number;
  sections: string[];
}

/** Run (or re-run) the Analyst for a business (PRD 6.11). */
export async function generateAnalyst(
  businessId: string,
): Promise<AnalystResult> {
  const { analyst } = await apiFetch<{ analyst: AnalystResult }>(
    `/api/businesses/${encodeURIComponent(businessId)}/analyst`,
    { method: "POST" },
  );
  return analyst;
}

/** Run (or re-run) the Builder Brief for a business (PRD 6.12). */
export async function generateBuilderBrief(
  businessId: string,
): Promise<BuilderBriefResult> {
  const res = await apiFetch<{
    builder_brief_md: string;
    word_count: number;
    sections: string[];
  }>(`/api/businesses/${encodeURIComponent(businessId)}/builder-brief`, {
    method: "POST",
  });
  return {
    markdown: res.builder_brief_md,
    word_count: res.word_count,
    sections: res.sections,
  };
}

/**
 * Design Brief JSON (RFL.BRIEF.7). The worker returns the stored brief when
 * one exists; force=true re-runs the agent (one Haiku call).
 */
export async function generateDesignBrief(
  businessId: string,
  force = false,
): Promise<{ brief: DesignBrief; stored: boolean }> {
  const res = await apiFetch<{ design_brief: DesignBrief; stored: boolean }>(
    `/api/businesses/${encodeURIComponent(businessId)}/design-brief${force ? "?force=true" : ""}`,
    { method: "POST" },
  );
  return { brief: res.design_brief, stored: res.stored };
}

/**
 * Fetch a worker photo-route URL (/api/places/photo/:ref) as a blob URL —
 * the route needs the Bearer token, so an <img src> cannot load it directly.
 * Caller revokes the URL when done.
 */
export async function fetchPlacePhotoUrl(photoRouteUrl: string): Promise<string> {
  const res = await fetch(resolveAssetUrl(photoRouteUrl), {
    headers: { Authorization: `Bearer ${await bearerToken()}` },
  });
  if (!res.ok) throw new Error(`Photo request failed (${res.status})`);
  return URL.createObjectURL(await res.blob());
}

/** Run (or re-run) the Sales Summary for a business (PRD 6.13). */
export async function generateSalesSummary(
  businessId: string,
): Promise<SalesSummaryResult> {
  const { sales_summary } = await apiFetch<{
    sales_summary: SalesSummaryResult;
  }>(`/api/businesses/${encodeURIComponent(businessId)}/sales-summary`, {
    method: "POST",
  });
  return sales_summary;
}

/**
 * Fetch the 2-page audit report and trigger a browser download. The worker
 * returns a PDF when Chrome is available, else printable HTML; either way the
 * Content-Disposition filename is honored.
 */
export async function downloadReport(businessId: string): Promise<void> {
  const res = await fetch(
    `${WORKER_URL}/api/businesses/${encodeURIComponent(businessId)}/report`,
    { headers: { Authorization: `Bearer ${await bearerToken()}` } },
  );
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename =
    disposition.match(/filename="([^"]+)"/)?.[1] ?? "audit-report";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
