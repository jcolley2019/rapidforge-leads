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
  Search,
  SearchResult,
  UpdateLeadStatusRequest,
  UpdateWorkspaceConfigRequest,
  UsageSummary,
  WorkspaceConfig,
} from "@rapidforge/shared";
import { supabase } from "@/lib/supabase";

const WORKER_URL: string = import.meta.env.VITE_WORKER_URL ?? "";

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

// ---------------------------------------------------------------------------
// Sprint 5: pipeline / drawer / leads / settings / usage (PRD Section 8)
// ---------------------------------------------------------------------------

/** Every lead in the workspace, all searches — Pipeline + Leads views. */
export async function fetchWorkspaceLeads(): Promise<LeadView[]> {
  const { leads } = await apiFetch<{ leads: LeadView[] }>("/api/leads");
  return leads;
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
