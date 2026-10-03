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
  UpdateWorkspaceConfigRequest,
  UsageSummary,
  WorkspaceConfig,
} from "@rapidforge/shared";
import {
  sortLeads,
  type BusinessCostSummary,
  type CreateSearchInput,
  type DataStore,
  type EnqueueJobInput,
  type InsertAgentRunInput,
  type InsertAuditInput,
  type JobCounts,
  type LeadView,
  type LogUsageEventInput,
  type QueueHealth,
  type ReclaimStaleInput,
  type ReclaimStaleResult,
  type SearchDetail,
  type UpdateAgentRunPatch,
  type UpdateAuditPatch,
  type UpdateSearchResultPatch,
  type UpsertBusinessInput,
} from "./types";
import {
  MULTI_LOCATION_CHAIN_THRESHOLD,
  normalizeBusinessName,
} from "../lib/chains";
import { summarizeUsage, type UsageRollupRow } from "./usage";

/** Row cap for the month rollup fetch — logged when hit, never silent. */
const USAGE_ROLLUP_ROW_CAP = 10_000;

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

  async listRecentSearches(
    workspaceId: string,
    limit: number,
  ): Promise<Search[]> {
    const { data, error } = await this.db
      .from("searches")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`[store] listRecentSearches: ${error.message}`);
    return (data ?? []) as Search[];
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

  async getQueueHealth(now: Date = new Date()): Promise<QueueHealth> {
    const tenMinAgoIso = new Date(now.getTime() - 10 * 60_000).toISOString();
    const [queued, running, runningOver, oldest] = await Promise.all([
      this.db.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
      this.db.from("jobs").select("id", { count: "exact", head: true }).eq("status", "running"),
      this.db
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "running")
        .lt("started_at", tenMinAgoIso),
      this.db
        .from("jobs")
        .select("created_at")
        .eq("status", "queued")
        .order("created_at", { ascending: true })
        .limit(1),
    ]);
    for (const r of [queued, running, runningOver, oldest]) {
      if (r.error) throw new Error(`[store] getQueueHealth: ${r.error.message}`);
    }
    const oldestIso = ((oldest.data ?? [])[0] as { created_at?: string } | undefined)?.created_at;
    const oldestMs = oldestIso ? Date.parse(oldestIso) : NaN;
    return {
      queued: queued.count ?? 0,
      running: running.count ?? 0,
      running_over_10m: runningOver.count ?? 0,
      oldest_queued_age_s: Number.isFinite(oldestMs)
        ? Math.max(0, Math.round((now.getTime() - oldestMs) / 1000))
        : null,
    };
  }

  async reclaimStaleWork(input: ReclaimStaleInput): Promise<ReclaimStaleResult> {
    const exclude = new Set(input.excludeJobIds ?? []);

    const { data: staleJobs, error } = await this.db
      .from("jobs")
      .select("*")
      .eq("status", "running")
      .lt("started_at", input.staleBeforeIso);
    if (error) throw new Error(`[store] reclaimStaleWork jobs: ${error.message}`);
    const candidates = ((staleJobs ?? []) as Job[]).filter(
      (j) => !exclude.has(j.id),
    );
    const requeueIds = candidates
      .filter((j) => (j.attempts ?? 0) < input.maxAttempts)
      .map((j) => j.id);
    const failIds = candidates
      .filter((j) => (j.attempts ?? 0) >= input.maxAttempts)
      .map((j) => j.id);

    const requeued = await this.reclaimJobs(requeueIds, {
      status: "queued",
      error: input.reason,
      finished_at: null,
    });
    const failed = await this.reclaimJobs(failIds, {
      status: "failed",
      error: input.reason,
      finished_at: nowIso(),
    });

    const { data: staleRuns, error: runsErr } = await this.db
      .from("agent_runs")
      .select("id, job_id")
      .eq("status", "running")
      .lt("started_at", input.staleBeforeIso);
    if (runsErr)
      throw new Error(`[store] reclaimStaleWork agent_runs: ${runsErr.message}`);
    const runIds = ((staleRuns ?? []) as { id: string; job_id: string | null }[])
      .filter((r) => r.job_id === null || !exclude.has(r.job_id))
      .map((r) => r.id);
    let agentRunsFailed: AgentRun[] = [];
    if (runIds.length > 0) {
      const { data, error: updErr } = await this.db
        .from("agent_runs")
        .update({ status: "failed", error: input.reason, ended_at: nowIso() })
        .in("id", runIds)
        .eq("status", "running") // optimistic guard — a run may finish meanwhile
        .select();
      if (updErr)
        throw new Error(`[store] reclaimStaleWork agent_runs update: ${updErr.message}`);
      agentRunsFailed = (data ?? []) as AgentRun[];
    }

    return { requeued, failed, agentRunsFailed };
  }

  private async reclaimJobs(
    ids: string[],
    patch: { status: "queued" | "failed"; error: string; finished_at: string | null },
  ): Promise<Job[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.db
      .from("jobs")
      .update(patch)
      .in("id", ids)
      .eq("status", "running") // optimistic guard — same as claim
      .select();
    if (error) throw new Error(`[store] reclaimJobs: ${error.message}`);
    return (data ?? []) as Job[];
  }

  // -- businesses / results / audits ----------------------------------------

  async upsertBusiness(input: UpsertBusinessInput): Promise<Business> {
    const name_normalized = normalizeBusinessName(input.name);
    // places_details undefined → key omitted → the stored record survives
    // the upsert (PostgREST only writes the columns present in the body).
    const { places_details, ...fields } = input;
    const { data, error } = await this.db
      .from("businesses")
      .upsert(
        {
          ...fields,
          chain_reason: input.chain_reason ?? null,
          name_normalized,
          ...(places_details === undefined ? {} : { places_details }),
          last_refreshed_at: nowIso(),
        },
        { onConflict: "workspace_id,google_place_id" },
      )
      .select()
      .single();
    const business = must(data, error, "upsertBusiness") as Business;
    return this.markMultiLocationChains(business, name_normalized);
  }

  /**
   * Workspace-wide multi-location check (see DataStore.upsertBusiness).
   * One indexed read on (workspace_id, name_normalized); one update only
   * when the threshold is crossed and some row is not yet a chain.
   */
  private async markMultiLocationChains(
    business: Business,
    nameNormalized: string,
  ): Promise<Business> {
    const { data, error } = await this.db
      .from("businesses")
      .select("id, google_place_id, is_chain, chain_reason")
      .eq("workspace_id", business.workspace_id)
      .eq("name_normalized", nameNormalized);
    if (error) throw new Error(`[store] multiLocation read: ${error.message}`);
    const rows = (data ?? []) as Pick<
      Business,
      "id" | "google_place_id" | "is_chain" | "chain_reason"
    >[];
    const distinctPlaces = new Set(rows.map((r) => r.google_place_id));
    if (distinctPlaces.size < MULTI_LOCATION_CHAIN_THRESHOLD) return business;
    const ids = rows
      .filter((r) => !(r.is_chain === true && r.chain_reason))
      .map((r) => r.id);
    if (ids.length === 0) return business;
    const { error: updErr } = await this.db
      .from("businesses")
      .update({ is_chain: true, chain_reason: "multi_location" })
      .in("id", ids);
    if (updErr) throw new Error(`[store] multiLocation update: ${updErr.message}`);
    console.log(
      `[store] "${nameNormalized}" at ${distinctPlaces.size} places in workspace ${business.workspace_id} — ${ids.length} marked is_chain (multi_location)`,
    );
    return ids.includes(business.id)
      ? { ...business, is_chain: true, chain_reason: "multi_location" }
      : business;
  }

  async setBusinessPlacesDetails(
    id: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db
      .from("businesses")
      .update({ places_details: details, last_refreshed_at: nowIso() })
      .eq("id", id);
    if (error) throw new Error(`[store] setBusinessPlacesDetails: ${error.message}`);
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

  async updateAudit(id: string, patch: UpdateAuditPatch): Promise<void> {
    const { error } = await this.db.from("audits").update(patch).eq("id", id);
    if (error) throw new Error(`[store] updateAudit: ${error.message}`);
  }

  async getLatestCompletedAuditForBusiness(
    businessId: string,
  ): Promise<Audit | null> {
    const { data, error } = await this.db
      .from("audits")
      .select("*")
      .eq("business_id", businessId)
      .eq("status", "completed")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(1);
    if (error) {
      throw new Error(
        `[store] getLatestCompletedAuditForBusiness: ${error.message}`,
      );
    }
    return ((data ?? [])[0] as Audit | undefined) ?? null;
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

  // -- Sprint 5: pipeline / drawer / leads / settings / usage -----------------

  async getSearchResult(id: string): Promise<SearchResult | null> {
    const { data, error } = await this.db
      .from("search_results")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`[store] getSearchResult: ${error.message}`);
    return (data as SearchResult | null) ?? null;
  }

  async updateSearchResult(
    id: string,
    patch: UpdateSearchResultPatch,
  ): Promise<SearchResult | null> {
    const { data, error } = await this.db
      .from("search_results")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw new Error(`[store] updateSearchResult: ${error.message}`);
    return (data as SearchResult | null) ?? null;
  }

  async listWorkspaceLeads(workspaceId: string): Promise<LeadView[]> {
    const { data: results, error: rErr } = await this.db
      .from("search_results")
      .select("*")
      .eq("workspace_id", workspaceId);
    if (rErr) throw new Error(`[store] listWorkspaceLeads: ${rErr.message}`);
    const resultRows = (results ?? []) as SearchResult[];
    if (resultRows.length === 0) return [];

    const businessIds = [...new Set(resultRows.map((r) => r.business_id))];
    const auditIds = resultRows
      .map((r) => r.latest_audit_id)
      .filter((v): v is string => v !== null);

    const [businesses, audits] = await Promise.all([
      this.db.from("businesses").select("*").in("id", businessIds),
      auditIds.length
        ? this.db.from("audits").select("*").in("id", auditIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (businesses.error)
      throw new Error(
        `[store] listWorkspaceLeads businesses: ${businesses.error.message}`,
      );
    if (audits.error)
      throw new Error(
        `[store] listWorkspaceLeads audits: ${audits.error.message}`,
      );

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
    return sortLeads(leads);
  }

  async listAuditsForBusiness(businessId: string): Promise<Audit[]> {
    const { data, error } = await this.db
      .from("audits")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    if (error)
      throw new Error(`[store] listAuditsForBusiness: ${error.message}`);
    return (data ?? []) as Audit[];
  }

  async getLatestSearchResultForBusiness(
    businessId: string,
  ): Promise<SearchResult | null> {
    const { data, error } = await this.db
      .from("search_results")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error)
      throw new Error(
        `[store] getLatestSearchResultForBusiness: ${error.message}`,
      );
    return ((data ?? [])[0] as SearchResult | undefined) ?? null;
  }

  async getUsageSummary(
    workspaceId: string,
    sinceIso: string,
  ): Promise<UsageSummary> {
    const { data, error } = await this.db
      .from("usage_events")
      .select("event_type, cost_cents")
      .eq("workspace_id", workspaceId)
      .gte("created_at", sinceIso)
      .range(0, USAGE_ROLLUP_ROW_CAP - 1);
    if (error) throw new Error(`[store] getUsageSummary: ${error.message}`);
    const rows = (data ?? []) as UsageRollupRow[];
    if (rows.length === USAGE_ROLLUP_ROW_CAP) {
      console.warn(
        `[store] getUsageSummary hit the ${USAGE_ROLLUP_ROW_CAP}-row cap — meter undercounts this month`,
      );
    }
    return summarizeUsage(rows, sinceIso);
  }

  async getBusinessCostSummary(
    businessId: string,
  ): Promise<BusinessCostSummary> {
    const { data, error } = await this.db
      .from("agent_runs")
      .select("agent_name, cost_cents")
      .eq("target_id", businessId);
    if (error) {
      throw new Error(`[store] getBusinessCostSummary: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{
      agent_name: string;
      cost_cents: number | null;
    }>;
    const byAgent = new Map<string, { cost_cents: number; runs: number }>();
    let businessTotal = 0;
    for (const row of rows) {
      const cents = row.cost_cents ?? 0;
      const cur = byAgent.get(row.agent_name) ?? { cost_cents: 0, runs: 0 };
      cur.cost_cents += cents;
      cur.runs += 1;
      byAgent.set(row.agent_name, cur);
      businessTotal += cents;
    }

    const latest = await this.getLatestSearchResultForBusiness(businessId);
    let searchTotal: number | null = null;
    if (latest) {
      const { data: searchRows, error: sErr } = await this.db
        .from("agent_runs")
        .select("cost_cents")
        .eq("input->>search_id", latest.search_id);
      if (sErr) {
        throw new Error(`[store] getBusinessCostSummary(search): ${sErr.message}`);
      }
      searchTotal = ((searchRows ?? []) as Array<{ cost_cents: number | null }>).reduce(
        (sum, r) => sum + (r.cost_cents ?? 0),
        0,
      );
    }

    const by_agent = [...byAgent.entries()]
      .map(([agent, v]) => ({ agent, ...v }))
      .sort((a, b) => b.cost_cents - a.cost_cents);
    return {
      by_agent,
      business_total_cents: businessTotal,
      search_total_cents: searchTotal,
    };
  }

  async getWorkspaceConfig(
    workspaceId: string,
  ): Promise<WorkspaceConfig | null> {
    const { data, error } = await this.db
      .from("workspace_config")
      .select("*")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) throw new Error(`[store] getWorkspaceConfig: ${error.message}`);
    return (data as WorkspaceConfig | null) ?? null;
  }

  async updateWorkspaceConfig(
    workspaceId: string,
    patch: UpdateWorkspaceConfigRequest,
  ): Promise<WorkspaceConfig> {
    const { data, error } = await this.db
      .from("workspace_config")
      .upsert(
        { workspace_id: workspaceId, ...patch, updated_at: nowIso() },
        { onConflict: "workspace_id" },
      )
      .select()
      .single();
    return must(data, error, "updateWorkspaceConfig") as WorkspaceConfig;
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
