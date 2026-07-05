/**
 * SupabaseStore — real DataStore over Postgres via the service-role key
 * (bypasses RLS; that key exists ONLY in the worker env — PRD 5.4).
 * Selected automatically when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are present. Zero code changes to flip from MemoryStore.
 *
 * Job claiming is optimistic (guarded UPDATE … eq status 'queued'): v1
 * runs a single worker process, so lost races just retry next tick — no
 * SQL function needed, keeping migrations 0001–0004 untouched.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AgentRun,
  Audit,
  Business,
  Job,
  JobStatus,
  Search,
  SearchResult,
} from "@rapidforge/shared";
import {
  sortLeads,
  type CreateSearchInput,
  type DataStore,
  type EnqueueJobInput,
  type InsertAgentRunInput,
  type InsertAuditInput,
  type JobCounts,
  type LeadView,
  type LogUsageEventInput,
  type SearchDetail,
  type UpdateAgentRunPatch,
  type UpsertBusinessInput,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

/** Throw with context — worker logs it and the job/report surfaces it. */
function must<T>(data: T | null, error: { message: string } | null, op: string): T {
  if (error) throw new Error(`[store] ${op}: ${error.message}`);
  if (data === null) throw new Error(`[store] ${op}: no row returned`);
  return data;
}

export class SupabaseStore implements DataStore {
  readonly mode = "supabase" as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  // -- searches -------------------------------------------------------------

  async createSearch(input: CreateSearchInput): Promise<Search> {
    const { data, error } = await this.db
      .from("searches")
      .insert(input)
      .select()
      .single();
    return must(data, error, "createSearch") as Search;
  }

  async getSearch(id: string): Promise<Search | null> {
    const { data, error } = await this.db
      .from("searches")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`[store] getSearch: ${error.message}`);
    return (data as Search | null) ?? null;
  }

  async updateSearch(
    id: string,
    patch: Partial<Pick<Search, "status" | "results_count" | "completed_at">>,
  ): Promise<void> {
    const { error } = await this.db.from("searches").update(patch).eq("id", id);
    if (error) throw new Error(`[store] updateSearch: ${error.message}`);
  }

  async getSearchDetail(id: string): Promise<SearchDetail | null> {
    const search = await this.getSearch(id);
    if (!search) return null;

    const { data: results, error: rErr } = await this.db
      .from("search_results")
      .select("*")
      .eq("search_id", id);
    if (rErr) throw new Error(`[store] getSearchDetail results: ${rErr.message}`);
    const resultRows = (results ?? []) as SearchResult[];

    const businessIds = resultRows.map((r) => r.business_id);
    const auditIds = resultRows
      .map((r) => r.latest_audit_id)
      .filter((v): v is string => v !== null);

    const [businesses, audits, agentRuns, jobs] = await Promise.all([
      businessIds.length
        ? this.db.from("businesses").select("*").in("id", businessIds)
        : Promise.resolve({ data: [], error: null }),
      auditIds.length
        ? this.db.from("audits").select("*").in("id", auditIds)
        : Promise.resolve({ data: [], error: null }),
      this.db
        .from("agent_runs")
        .select("*")
        .contains("input", { search_id: id })
        .order("started_at", { ascending: true }),
      this.db.from("jobs").select("status").contains("payload", { search_id: id }),
    ]);
    for (const [label, res] of [
      ["businesses", businesses],
      ["audits", audits],
      ["agent_runs", agentRuns],
      ["jobs", jobs],
    ] as const) {
      if (res.error)
        throw new Error(`[store] getSearchDetail ${label}: ${res.error.message}`);
    }

    const businessById = new Map(
      ((businesses.data ?? []) as Business[]).map((b) => [b.id, b]),
    );
    const auditById = new Map(
      ((audits.data ?? []) as Audit[]).map((a) => [a.id, a]),
    );

    const leads: LeadView[] = [];
    for (const result of resultRows) {
      const business = businessById.get(result.business_id);
      if (!business) continue;
      leads.push({
        result,
        business,
        audit: result.latest_audit_id
          ? (auditById.get(result.latest_audit_id) ?? null)
          : null,
      });
    }

    const job_counts: JobCounts = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const row of (jobs.data ?? []) as Array<{ status: string | null }>) {
      const status = (row.status ?? "queued") as keyof JobCounts;
      if (status in job_counts) job_counts[status] += 1;
    }

    return {
      search,
      leads: sortLeads(leads),
      agent_states: (agentRuns.data ?? []) as AgentRun[],
      job_counts,
    };
  }

  // -- jobs -----------------------------------------------------------------

  async enqueueJob(input: EnqueueJobInput): Promise<Job> {
    const { data, error } = await this.db
      .from("jobs")
      .insert(input)
      .select()
      .single();
    return must(data, error, "enqueueJob") as Job;
  }

  async claimNextQueuedJob(): Promise<Job | null> {
    const { data: candidates, error } = await this.db
      .from("jobs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw new Error(`[store] claimNextQueuedJob: ${error.message}`);
    const candidate = (candidates ?? [])[0] as Job | undefined;
    if (!candidate) return null;

    const { data: claimed, error: claimErr } = await this.db
      .from("jobs")
      .update({
        status: "running",
        started_at: nowIso(),
        attempts: (candidate.attempts ?? 0) + 1,
      })
      .eq("id", candidate.id)
      .eq("status", "queued") // optimistic guard
      .select();
    if (claimErr) throw new Error(`[store] claim update: ${claimErr.message}`);
    return ((claimed ?? [])[0] as Job | undefined) ?? null;
  }

  async finishJob(
    id: string,
    outcome: {
      status: Extract<JobStatus, "done" | "failed" | "queued">;
      error?: string | null;
    },
  ): Promise<void> {
    const { error } = await this.db
      .from("jobs")
      .update({
        status: outcome.status,
        error: outcome.error ?? null,
        finished_at: outcome.status === "queued" ? null : nowIso(),
      })
      .eq("id", id);
    if (error) throw new Error(`[store] finishJob: ${error.message}`);
  }

  async countActiveJobsForSearch(searchId: string): Promise<number> {
    const { count, error } = await this.db
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .contains("payload", { search_id: searchId })
      .in("status", ["queued", "running"]);
    if (error)
      throw new Error(`[store] countActiveJobsForSearch: ${error.message}`);
    return count ?? 0;
  }

  // -- businesses / results / audits ----------------------------------------

  async upsertBusiness(input: UpsertBusinessInput): Promise<Business> {
    const { data, error } = await this.db
      .from("businesses")
      .upsert(
        { ...input, last_refreshed_at: nowIso() },
        { onConflict: "workspace_id,google_place_id" },
      )
      .select()
      .single();
    return must(data, error, "upsertBusiness") as Business;
  }

  async getBusiness(id: string): Promise<Business | null> {
    const { data, error } = await this.db
      .from("businesses")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`[store] getBusiness: ${error.message}`);
    return (data as Business | null) ?? null;
  }

  async ensureSearchResult(
    workspaceId: string,
    searchId: string,
    businessId: string,
  ): Promise<SearchResult> {
    const { data, error } = await this.db
      .from("search_results")
      .upsert(
        { workspace_id: workspaceId, search_id: searchId, business_id: businessId },
        { onConflict: "search_id,business_id" },
      )
      .select()
      .single();
    return must(data, error, "ensureSearchResult") as SearchResult;
  }

  async insertAudit(input: InsertAuditInput): Promise<Audit> {
    const { data, error } = await this.db
      .from("audits")
      .insert(input)
      .select()
      .single();
    return must(data, error, "insertAudit") as Audit;
  }

  async setLatestAudit(
    searchId: string,
    businessId: string,
    auditId: string,
  ): Promise<void> {
    const { error } = await this.db
      .from("search_results")
      .update({ latest_audit_id: auditId })
      .eq("search_id", searchId)
      .eq("business_id", businessId);
    if (error) throw new Error(`[store] setLatestAudit: ${error.message}`);
  }

  // -- agent_runs / usage_events ---------------------------------------------

  async insertAgentRun(input: InsertAgentRunInput): Promise<AgentRun> {
    const { data, error } = await this.db
      .from("agent_runs")
      .insert({ ...input, status: "running" })
      .select()
      .single();
    return must(data, error, "insertAgentRun") as AgentRun;
  }

  async updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<void> {
    const { error } = await this.db
      .from("agent_runs")
      .update({ ...patch, ended_at: nowIso() })
      .eq("id", id);
    if (error) throw new Error(`[store] updateAgentRun: ${error.message}`);
  }

  async logUsageEvent(input: LogUsageEventInput): Promise<void> {
    const { error } = await this.db.from("usage_events").insert(input);
    if (error) throw new Error(`[store] logUsageEvent: ${error.message}`);
  }

  // -- auth -------------------------------------------------------------------

  async getWorkspaceIdForUser(userId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .limit(1);
    if (error)
      throw new Error(`[store] getWorkspaceIdForUser: ${error.message}`);
    return (data?.[0]?.workspace_id as string | undefined) ?? null;
  }
}
