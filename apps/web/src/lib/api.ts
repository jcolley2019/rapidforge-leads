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
