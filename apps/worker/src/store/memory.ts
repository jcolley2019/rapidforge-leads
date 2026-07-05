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
  UsageEvent,
} from "@rapidforge/shared";
import {
  DEV_WORKSPACE_ID,
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
  type UpdateAuditPatch,
  type UpsertBusinessInput,
} from "./types";

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

    const leads: LeadView[] = [];
    for (const result of this.searchResults.values()) {
      if (result.search_id !== id) continue;
      const business = this.businesses.get(result.business_id);
      if (!business) continue;
      const audit = result.latest_audit_id
        ? (this.audits.get(result.latest_audit_id) ?? null)
        : null;
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

  // -- businesses / results / audits ----------------------------------------

  async upsertBusiness(input: UpsertBusinessInput): Promise<Business> {
    const existing = [...this.businesses.values()].find(
      (b) =>
        b.workspace_id === input.workspace_id &&
        b.google_place_id === input.google_place_id,
    );
    if (existing) {
      Object.assign(existing, input, { last_refreshed_at: nowIso() });
      return existing;
    }
    const business: Business = {
      id: randomUUID(),
      ...input,
      first_seen_at: nowIso(),
      last_refreshed_at: nowIso(),
    };
    this.businesses.set(business.id, business);
    return business;
  }

  async getBusiness(id: string): Promise<Business | null> {
    return this.businesses.get(id) ?? null;
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
    for (const result of this.searchResults.values()) {
      if (result.search_id === searchId && result.business_id === businessId) {
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
  listUsageEvents(): readonly UsageEvent[] {
    return this.usageEvents;
  }

  // -- auth -------------------------------------------------------------------

  async getWorkspaceIdForUser(_userId: string): Promise<string | null> {
    return DEV_WORKSPACE_ID;
  }
}
