/**
 * MemoryStore — in-memory DataStore, selected automatically when
 * SUPABASE_URL is absent (Sprint 2 modified constraint). Lets the full
 * search flow run end-to-end in dev with no external services. Data lives
 * for the process lifetime only.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  Audit,
  Business,
  Job,
  JobStatus,
  Search,
  SearchResult,
  UpdateWorkspaceConfigRequest,
  UsageEvent,
  UsageSummary,
  WorkspaceConfig,
} from "@rapidforge/shared";
import {
  DEV_WORKSPACE_ID,
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
  type UpdateBusinessPatch,
  type UpdateSearchResultPatch,
  type UpsertBusinessInput,
} from "./types";
import {
  MULTI_LOCATION_CHAIN_THRESHOLD,
  normalizeBusinessName,
} from "../lib/chains";
import {
  groupAuditsByBusiness,
  pickDisplayAudit,
  shouldRepointLatestAudit,
} from "./latest-audit";
import { summarizeUsage } from "./usage";

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryStore implements DataStore {
  readonly mode = "memory" as const;

  private searches = new Map<string, Search>();
  private jobs = new Map<string, Job>();
  private businesses = new Map<string, Business>();
  private searchResults = new Map<string, SearchResult>();
  private audits = new Map<string, Audit>();
  private agentRuns = new Map<string, AgentRun>();
  private usageEvents: UsageEvent[] = [];
  private configs = new Map<string, WorkspaceConfig>();

  // -- searches -------------------------------------------------------------

  async createSearch(input: CreateSearchInput): Promise<Search> {
    const search: Search = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      created_by: input.created_by,
      mode: input.mode,
      params: input.params,
      category: input.category,
      status: "pending",
      results_count: 0,
      created_at: nowIso(),
      completed_at: null,
    };
    this.searches.set(search.id, search);
    return search;
  }

  async getSearch(id: string): Promise<Search | null> {
    return this.searches.get(id) ?? null;
  }

  async listRecentSearches(
    workspaceId: string,
    limit: number,
  ): Promise<Search[]> {
    return [...this.searches.values()]
      .filter((s) => s.workspace_id === workspaceId)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .slice(0, limit);
  }

  async updateSearch(
    id: string,
    patch: Partial<Pick<Search, "status" | "results_count" | "completed_at">>,
  ): Promise<void> {
    const search = this.searches.get(id);
    if (search) Object.assign(search, patch);
  }

  async getSearchDetail(id: string): Promise<SearchDetail | null> {
    const search = this.searches.get(id);
    if (!search) return null;

    const auditsByBusiness = groupAuditsByBusiness([...this.audits.values()]);
    const leads: LeadView[] = [];
    for (const result of this.searchResults.values()) {
      if (result.search_id !== id) continue;
      const business = this.businesses.get(result.business_id);
      if (!business) continue;
      // RFL.WEB.10: newest completed audit, never the raw pointer.
      const audit = pickDisplayAudit(auditsByBusiness.get(business.id) ?? []);
      leads.push({ result, business, audit });
    }

    const agent_states = [...this.agentRuns.values()]
      .filter((run) => (run.input as { search_id?: string } | null)?.search_id === id)
      .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));

    const job_counts: JobCounts = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const job of this.jobs.values()) {
      if ((job.payload as { search_id?: string }).search_id !== id) continue;
      const status = (job.status ?? "queued") as keyof JobCounts;
      if (status in job_counts) job_counts[status] += 1;
    }

    return { search, leads: sortLeads(leads), agent_states, job_counts };
  }

  // -- jobs -----------------------------------------------------------------

  async enqueueJob(input: EnqueueJobInput): Promise<Job> {
    const job: Job = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      job_type: input.job_type,
      payload: input.payload,
      status: "queued",
      attempts: 0,
      error: null,
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async claimNextQueuedJob(): Promise<Job | null> {
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === "queued")
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    const job = queued[0];
    if (!job) return null;
    job.status = "running";
    job.started_at = nowIso();
    job.attempts = (job.attempts ?? 0) + 1;
    return { ...job };
  }

  async finishJob(
    id: string,
    outcome: {
      status: Extract<JobStatus, "done" | "failed" | "queued">;
      error?: string | null;
    },
  ): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = outcome.status;
    job.error = outcome.error ?? null;
    job.finished_at = outcome.status === "queued" ? null : nowIso();
  }

  async countActiveJobsForSearch(searchId: string): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if ((job.payload as { search_id?: string }).search_id !== searchId) continue;
      if (job.status === "queued" || job.status === "running") count += 1;
    }
    return count;
  }

  async failQueuedJobsForSearch(searchId: string, reason: string): Promise<Job[]> {
    const failed: Job[] = [];
    for (const job of this.jobs.values()) {
      if ((job.payload as { search_id?: string }).search_id !== searchId) continue;
      if (job.status !== "queued") continue;
      job.status = "failed";
      job.error = reason;
      job.finished_at = nowIso();
      failed.push({ ...job });
    }
    return failed;
  }

  async getQueueHealth(now: Date = new Date()): Promise<QueueHealth> {
    const tenMinAgo = now.getTime() - 10 * 60_000;
    let queued = 0;
    let running = 0;
    let runningOver = 0;
    let oldestQueued: number | null = null;
    for (const job of this.jobs.values()) {
      if (job.status === "queued") {
        queued += 1;
        const created = job.created_at ? Date.parse(job.created_at) : NaN;
        if (Number.isFinite(created) && (oldestQueued === null || created < oldestQueued)) {
          oldestQueued = created;
        }
      } else if (job.status === "running") {
        running += 1;
        const started = job.started_at ? Date.parse(job.started_at) : NaN;
        if (Number.isFinite(started) && started < tenMinAgo) runningOver += 1;
      }
    }
    return {
      queued,
      running,
      running_over_10m: runningOver,
      oldest_queued_age_s:
        oldestQueued === null ? null : Math.max(0, Math.round((now.getTime() - oldestQueued) / 1000)),
    };
  }

  async reclaimStaleWork(input: ReclaimStaleInput): Promise<ReclaimStaleResult> {
    const exclude = new Set(input.excludeJobIds ?? []);
    const isStale = (startedAt: string | null): boolean =>
      startedAt !== null && startedAt < input.staleBeforeIso;
    const result: ReclaimStaleResult = {
      requeued: [],
      failed: [],
      agentRunsFailed: [],
    };

    for (const job of this.jobs.values()) {
      if (job.status !== "running" || exclude.has(job.id)) continue;
      if (!isStale(job.started_at)) continue;
      job.error = input.reason;
      if ((job.attempts ?? 0) < input.maxAttempts) {
        job.status = "queued";
        job.finished_at = null;
        result.requeued.push({ ...job });
      } else {
        job.status = "failed";
        job.finished_at = nowIso();
        result.failed.push({ ...job });
      }
    }

    for (const run of this.agentRuns.values()) {
      if (run.status !== "running" || !isStale(run.started_at)) continue;
      if (run.job_id !== null && exclude.has(run.job_id)) continue;
      run.status = "failed";
      run.error = input.reason;
      run.ended_at = nowIso();
      result.agentRunsFailed.push({ ...run });
    }
    return result;
  }

  // -- businesses / results / audits ----------------------------------------

  async upsertBusiness(input: UpsertBusinessInput): Promise<Business> {
    const { places_details, ...fields } = input;
    const row = {
      ...fields,
      chain_reason: input.chain_reason ?? null,
      name_normalized: normalizeBusinessName(input.name),
      // undefined = leave the stored record alone; null/object = write it.
      ...(places_details === undefined ? {} : { places_details }),
    };
    let business = [...this.businesses.values()].find(
      (b) =>
        b.workspace_id === input.workspace_id &&
        b.google_place_id === input.google_place_id,
    );
    if (business) {
      Object.assign(business, row, { last_refreshed_at: nowIso() });
    } else {
      business = {
        id: randomUUID(),
        places_details: null,
        ...row,
        first_seen_at: nowIso(),
        last_refreshed_at: nowIso(),
      };
      this.businesses.set(business.id, business);
    }
    this.markMultiLocationChains(input.workspace_id, row.name_normalized);
    return business;
  }

  async setBusinessPlacesDetails(
    id: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const business = this.businesses.get(id);
    if (business) business.places_details = details;
  }

  /** Workspace-wide multi-location check (see DataStore.upsertBusiness). */
  private markMultiLocationChains(workspaceId: string, nameNormalized: string): void {
    const sameName = [...this.businesses.values()].filter(
      (b) => b.workspace_id === workspaceId && b.name_normalized === nameNormalized,
    );
    const distinctPlaces = new Set(sameName.map((b) => b.google_place_id));
    if (distinctPlaces.size < MULTI_LOCATION_CHAIN_THRESHOLD) return;
    for (const b of sameName) {
      if (b.is_chain === true && b.chain_reason) continue;
      b.is_chain = true;
      b.chain_reason = "multi_location";
    }
  }

  async getBusiness(id: string): Promise<Business | null> {
    return this.businesses.get(id) ?? null;
  }

  async updateBusiness(
    id: string,
    patch: UpdateBusinessPatch,
  ): Promise<Business | null> {
    const business = this.businesses.get(id);
    if (!business) return null;
    Object.assign(business, patch);
    return { ...business };
  }

  async ensureSearchResult(
    workspaceId: string,
    searchId: string,
    businessId: string,
  ): Promise<SearchResult> {
    const existing = [...this.searchResults.values()].find(
      (r) => r.search_id === searchId && r.business_id === businessId,
    );
    if (existing) return existing;
    const result: SearchResult = {
      id: randomUUID(),
      workspace_id: workspaceId,
      search_id: searchId,
      business_id: businessId,
      latest_audit_id: null,
      status: "new",
      notes: null,
      last_contacted_at: null,
      next_followup_at: null,
      created_at: nowIso(),
    };
    this.searchResults.set(result.id, result);
    return result;
  }

  async insertAudit(input: InsertAuditInput): Promise<Audit> {
    const audit: Audit = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      business_id: input.business_id,
      website_url: input.website_url,
      ps_performance: null,
      ps_mobile_performance: null,
      ps_accessibility: null,
      ps_seo: null,
      ps_best_practices: null,
      ps_lcp_ms: null,
      ps_cls: null,
      http_status: input.http_status,
      ssl_valid: input.ssl_valid,
      response_ms: input.response_ms,
      platform: null,
      copyright_year: null,
      has_phone: null,
      has_form: null,
      has_booking: null,
      has_chat: null,
      has_viewport_meta: null,
      has_schema_markup: null,
      gbp_photo_count: null,
      gbp_review_velocity: null,
      has_crux_data: null,
      screenshot_desktop_url: null,
      screenshot_mobile_url: null,
      website_health_score: input.website_health_score,
      star_grade: input.star_grade,
      sellability_score: input.sellability_score,
      score_breakdown: input.score_breakdown,
      issues: input.issues,
      analyst_output: null,
      builder_brief_md: null,
      sales_summary: null,
      status: input.status,
      error_message: input.error_message,
      provisional: input.provisional ?? false,
      design_brief: null,
      created_at: nowIso(),
      completed_at: input.completed_at,
    };
    this.audits.set(audit.id, audit);
    return audit;
  }

  async updateAudit(id: string, patch: UpdateAuditPatch): Promise<void> {
    const audit = this.audits.get(id);
    if (audit) Object.assign(audit, patch);
  }

  async getLatestCompletedAuditForBusiness(
    businessId: string,
  ): Promise<Audit | null> {
    let latest: Audit | null = null;
    for (const audit of this.audits.values()) {
      if (audit.business_id !== businessId) continue;
      if (audit.status !== "completed" || audit.completed_at === null) continue;
      if (latest === null || audit.completed_at > (latest.completed_at ?? "")) {
        latest = audit;
      }
    }
    return latest;
  }

  async setLatestAudit(
    searchId: string,
    businessId: string,
    auditId: string,
  ): Promise<void> {
    const next = this.audits.get(auditId) ?? null;
    for (const result of this.searchResults.values()) {
      if (result.search_id === searchId && result.business_id === businessId) {
        const current = result.latest_audit_id
          ? (this.audits.get(result.latest_audit_id) ?? null)
          : null;
        // RFL.WEB.10: a failed/pending audit never displaces a completed one.
        if (!shouldRepointLatestAudit(current, next)) return;
        result.latest_audit_id = auditId;
        return;
      }
    }
  }

  // -- agent_runs / usage_events ---------------------------------------------

  async insertAgentRun(input: InsertAgentRunInput): Promise<AgentRun> {
    const run: AgentRun = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      agent_name: input.agent_name,
      job_id: input.job_id,
      target_id: input.target_id,
      status: "running",
      input: input.input,
      output: null,
      error: null,
      model_used: null,
      tokens_used: 0,
      cost_cents: 0,
      guardrail_passed: true,
      guardrail_notes: null,
      duration_ms: null,
      started_at: nowIso(),
      ended_at: null,
    };
    this.agentRuns.set(run.id, run);
    return run;
  }

  async updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<void> {
    const run = this.agentRuns.get(id);
    if (!run) return;
    Object.assign(run, patch, { ended_at: nowIso() });
  }

  async logUsageEvent(input: LogUsageEventInput): Promise<void> {
    this.usageEvents.push({
      id: randomUUID(),
      workspace_id: input.workspace_id,
      event_type: input.event_type,
      cost_cents: input.cost_cents,
      metadata: input.metadata,
      created_at: nowIso(),
    });
  }

  /** Test/report helper — not part of the DataStore contract. */
  /** Test helper: every agent_runs row (MemoryStore only). */
  listAgentRuns(): readonly AgentRun[] {
    return [...this.agentRuns.values()];
  }

  listUsageEvents(): readonly UsageEvent[] {
    return this.usageEvents;
  }

  // -- Sprint 5: pipeline / drawer / leads / settings / usage -----------------

  async getSearchResult(id: string): Promise<SearchResult | null> {
    return this.searchResults.get(id) ?? null;
  }

  async updateSearchResult(
    id: string,
    patch: UpdateSearchResultPatch,
  ): Promise<SearchResult | null> {
    const result = this.searchResults.get(id);
    if (!result) return null;
    Object.assign(result, patch);
    return { ...result };
  }

  async listWorkspaceLeads(workspaceId: string): Promise<LeadView[]> {
    const auditsByBusiness = groupAuditsByBusiness([...this.audits.values()]);
    const leads: LeadView[] = [];
    for (const result of this.searchResults.values()) {
      if (result.workspace_id !== workspaceId) continue;
      const business = this.businesses.get(result.business_id);
      if (!business) continue;
      // RFL.WEB.10: newest completed audit, never the raw pointer.
      const audit = pickDisplayAudit(auditsByBusiness.get(business.id) ?? []);
      leads.push({ result, business, audit });
    }
    return sortLeads(leads);
  }

  async listAuditsForBusiness(businessId: string): Promise<Audit[]> {
    return [...this.audits.values()]
      .filter((a) => a.business_id === businessId)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  }

  async getLatestSearchResultForBusiness(
    businessId: string,
  ): Promise<SearchResult | null> {
    let latest: SearchResult | null = null;
    for (const result of this.searchResults.values()) {
      if (result.business_id !== businessId) continue;
      if (
        latest === null ||
        (result.created_at ?? "") > (latest.created_at ?? "")
      ) {
        latest = result;
      }
    }
    return latest;
  }

  async getUsageSummary(
    workspaceId: string,
    sinceIso: string,
  ): Promise<UsageSummary> {
    const rows = this.usageEvents.filter(
      (e) =>
        e.workspace_id === workspaceId && (e.created_at ?? "") >= sinceIso,
    );
    return summarizeUsage(rows, sinceIso);
  }

  async getBusinessCostSummary(
    businessId: string,
  ): Promise<BusinessCostSummary> {
    const byAgent = new Map<string, { cost_cents: number; runs: number }>();
    let businessTotal = 0;
    for (const run of this.agentRuns.values()) {
      if (run.target_id !== businessId) continue;
      const cents = run.cost_cents ?? 0;
      const cur = byAgent.get(run.agent_name) ?? { cost_cents: 0, runs: 0 };
      cur.cost_cents += cents;
      cur.runs += 1;
      byAgent.set(run.agent_name, cur);
      businessTotal += cents;
    }

    const latest = await this.getLatestSearchResultForBusiness(businessId);
    let searchTotal: number | null = null;
    if (latest) {
      searchTotal = 0;
      for (const run of this.agentRuns.values()) {
        const sid = (run.input as { search_id?: string } | null)?.search_id;
        if (sid === latest.search_id) searchTotal += run.cost_cents ?? 0;
      }
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
    return this.configs.get(workspaceId) ?? null;
  }

  async updateWorkspaceConfig(
    workspaceId: string,
    patch: UpdateWorkspaceConfigRequest,
  ): Promise<WorkspaceConfig> {
    const existing = this.configs.get(workspaceId) ?? {
      workspace_id: workspaceId,
      your_offer: null,
      target_industry: null,
      ideal_website_traits: null,
      // 0001 column defaults (bootstrap_workspace inserts them in Supabase).
      sales_tone: "direct, friendly, peer-to-peer, no-BS",
      user_location: null,
      user_brand: "RapidForgeAI",
      updated_at: null,
    };
    const updated: WorkspaceConfig = {
      ...existing,
      ...patch,
      updated_at: nowIso(),
    };
    this.configs.set(workspaceId, updated);
    return updated;
  }

  // -- auth -------------------------------------------------------------------

  async getWorkspaceIdForUser(_userId: string): Promise<string | null> {
    return DEV_WORKSPACE_ID;
  }
}
