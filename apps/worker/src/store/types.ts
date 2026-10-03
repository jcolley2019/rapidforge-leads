/**
 * DataStore — the swappable persistence seam (Sprint 2 modified
 * constraint). Two implementations:
 *
 *   - SupabaseStore: real Postgres via service-role key (bypasses RLS —
 *     that key exists ONLY in the worker env, PRD 5.4)
 *   - MemoryStore:  in-memory, selected automatically when SUPABASE_URL
 *     is absent so the full search flow runs end-to-end with no external
 *     services
 *
 * Method surface is exactly what Sprint 2 needs — it grows with later
 * sprints rather than speculating.
 */
import type {
  AgentRun,
  Audit,
  Business,
  Issue,
  Job,
  JobStatus,
  LeadStatus,
  Search,
  SearchMode,
  SearchResult,
  UpdateWorkspaceConfigRequest,
  UsageEventType,
  UsageSummary,
  WebsiteKind,
  WorkspaceConfig,
} from "@rapidforge/shared";

// ---------------------------------------------------------------------------
// Dev identity (MemoryStore) — fixed UUIDs so the offline flow has a stable
// workspace/user without Supabase Auth.
// ---------------------------------------------------------------------------

export const DEV_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const DEV_USER_ID = "00000000-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateSearchInput {
  workspace_id: string;
  created_by: string;
  mode: SearchMode;
  params: Record<string, unknown>;
  category: string;
}

export interface EnqueueJobInput {
  workspace_id: string;
  job_type: string;
  payload: Record<string, unknown>;
}

export interface UpsertBusinessInput {
  workspace_id: string;
  google_place_id: string;
  name: string;
  phone: string | null;
  website_url: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  google_rating: number | null;
  review_count: number | null;
  category: string | null;
  business_status: string | null;
  is_chain: boolean;
  website_kind: WebsiteKind;
}

export interface InsertAuditInput {
  workspace_id: string;
  business_id: string;
  website_url: string | null;
  http_status: number | null;
  response_ms: number | null;
  ssl_valid: boolean | null;
  website_health_score: number | null;
  star_grade: number | null;
  sellability_score: number | null;
  score_breakdown: Record<string, unknown> | null;
  issues: Issue[] | null;
  /** 'completed' | 'pending' (audit agents land Sprint 3) | 'skipped' */
  status: string;
  error_message: string | null;
  completed_at: string | null;
}

/**
 * Scorer's finalize patch (Sprint 3): fills the measured fields on the
 * pending audit row Filter created and flips it to 'completed'. Audits
 * stay append-only PER RUN (PRD 5.5) — this updates the current run's
 * row, never a historical one.
 */
export interface UpdateAuditPatch {
  ps_performance?: number | null;
  ps_mobile_performance?: number | null;
  ps_accessibility?: number | null;
  ps_seo?: number | null;
  ps_best_practices?: number | null;
  ps_lcp_ms?: number | null;
  ps_cls?: number | null;
  http_status?: number | null;
  ssl_valid?: boolean | null;
  response_ms?: number | null;
  platform?: string | null;
  copyright_year?: number | null;
  has_phone?: boolean | null;
  has_form?: boolean | null;
  has_booking?: boolean | null;
  has_chat?: boolean | null;
  has_viewport_meta?: boolean | null;
  has_schema_markup?: boolean | null;
  gbp_photo_count?: number | null;
  has_crux_data?: boolean | null;
  /** Sprint 6: absolute (Supabase) or relative (fixture-static) URLs. */
  screenshot_desktop_url?: string | null;
  screenshot_mobile_url?: string | null;
  website_health_score?: number | null;
  star_grade?: number | null;
  sellability_score?: number | null;
  score_breakdown?: Record<string, unknown> | null;
  issues?: Issue[] | null;
  /** Sprint 7 money features (PRD 6.11–6.13) — dedicated columns (0002). */
  analyst_output?: Record<string, unknown> | null;
  builder_brief_md?: string | null;
  sales_summary?: Record<string, unknown> | null;
  status?: string;
  error_message?: string | null;
  completed_at?: string | null;
}

export interface InsertAgentRunInput {
  workspace_id: string;
  agent_name: string;
  job_id: string | null;
  target_id: string | null;
  /** Include search_id here — it is how runs are recalled per search. */
  input: Record<string, unknown> | null;
}

export interface UpdateAgentRunPatch {
  status: "completed" | "failed";
  output?: Record<string, unknown> | null;
  error?: string | null;
  model_used?: string | null;
  tokens_used?: number;
  cost_cents?: number;
  guardrail_passed?: boolean;
  guardrail_notes?: string | null;
  duration_ms?: number;
}

/**
 * Stale-claim sweep (audit finding 5): jobs / agent_runs left 'running' by a
 * dead worker. Jobs under maxAttempts go back to 'queued', the rest fail;
 * stale agent_runs always fail (they are never re-run in place).
 */
export interface ReclaimStaleInput {
  /** Rows whose started_at is before this ISO instant are stale. */
  staleBeforeIso: string;
  /** attempts >= maxAttempts → 'failed' instead of 'queued'. */
  maxAttempts: number;
  /** Written to jobs.error / agent_runs.error. */
  reason: string;
  /** Jobs this process still has in flight — never reclaimed, nor their runs. */
  excludeJobIds?: readonly string[];
}

export interface ReclaimStaleResult {
  /** Post-update rows. */
  requeued: Job[];
  failed: Job[];
  agentRunsFailed: AgentRun[];
}

export interface LogUsageEventInput {
  workspace_id: string;
  event_type: UsageEventType;
  cost_cents: number;
  metadata: Record<string, unknown> | null;
}

/**
 * Sprint 5 pipeline/drawer patch (PRD 7.3/7.4). last_contacted_at is set by
 * the route on status change, never taken from the client.
 */
export interface UpdateSearchResultPatch {
  status?: LeadStatus;
  notes?: string | null;
  last_contacted_at?: string | null;
  next_followup_at?: string | null;
}

// ---------------------------------------------------------------------------
// Read models (GET /api/searches/:id)
// ---------------------------------------------------------------------------

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

/** Per-agent AI spend for a business, read from agent_runs (PRD 7.2 / S8). */
export interface AgentCostRow {
  agent: string;
  cost_cents: number;
  runs: number;
}

export interface BusinessCostSummary {
  /** One row per agent that touched this business, highest cost first. */
  by_agent: AgentCostRow[];
  business_total_cents: number;
  /** Total cost of the business's most recent search (null if none). */
  search_total_cents: number | null;
}

export interface SearchDetail {
  search: Search;
  /** Sorted by sellability desc (nulls last), then name. */
  leads: LeadView[];
  agent_states: AgentRun[];
  job_counts: JobCounts;
}

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

export interface DataStore {
  readonly mode: "supabase" | "memory";

  // searches
  createSearch(input: CreateSearchInput): Promise<Search>;
  getSearch(id: string): Promise<Search | null>;
  /** Recent searches, newest first (S5.5 dashboard). */
  listRecentSearches(workspaceId: string, limit: number): Promise<Search[]>;
  updateSearch(
    id: string,
    patch: Partial<
      Pick<Search, "status" | "results_count" | "completed_at">
    >,
  ): Promise<void>;
  getSearchDetail(id: string): Promise<SearchDetail | null>;

  // jobs (the queue IS this table — CLAUDE.md Section 4)
  enqueueJob(input: EnqueueJobInput): Promise<Job>;
  /** Claim the oldest queued job (status→running, attempts+1) or null. */
  claimNextQueuedJob(): Promise<Job | null>;
  finishJob(
    id: string,
    outcome: { status: Extract<JobStatus, "done" | "failed" | "queued">; error?: string | null },
  ): Promise<void>;
  countActiveJobsForSearch(searchId: string): Promise<number>;
  /** Requeue/fail jobs and fail agent_runs stuck 'running' (finding 5). */
  reclaimStaleWork(input: ReclaimStaleInput): Promise<ReclaimStaleResult>;

  // businesses / results / audits
  upsertBusiness(input: UpsertBusinessInput): Promise<Business>;
  getBusiness(id: string): Promise<Business | null>;
  ensureSearchResult(
    workspaceId: string,
    searchId: string,
    businessId: string,
  ): Promise<SearchResult>;
  insertAudit(input: InsertAuditInput): Promise<Audit>;
  updateAudit(id: string, patch: UpdateAuditPatch): Promise<void>;
  /** Newest completed audit for a business — the 30-day cache (PRD 5.5). */
  getLatestCompletedAuditForBusiness(businessId: string): Promise<Audit | null>;
  setLatestAudit(searchId: string, businessId: string, auditId: string): Promise<void>;

  // agent_runs / usage_events
  insertAgentRun(input: InsertAgentRunInput): Promise<AgentRun>;
  updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<void>;
  logUsageEvent(input: LogUsageEventInput): Promise<void>;

  // Sprint 5: pipeline / drawer / leads / settings / usage
  getSearchResult(id: string): Promise<SearchResult | null>;
  /** Applies the patch; returns the updated row or null when absent. */
  updateSearchResult(
    id: string,
    patch: UpdateSearchResultPatch,
  ): Promise<SearchResult | null>;
  /** Every lead row in the workspace, across ALL searches (PRD 7.3 Lead List). */
  listWorkspaceLeads(workspaceId: string): Promise<LeadView[]>;
  /** Audit history for the drawer's History tab — newest first (PRD 7.4). */
  listAuditsForBusiness(businessId: string): Promise<Audit[]>;
  /** Newest search_result for a business — re-audit's search context. */
  getLatestSearchResultForBusiness(
    businessId: string,
  ): Promise<SearchResult | null>;
  /** usage_events rollup since the given ISO timestamp (GET /api/usage). */
  getUsageSummary(workspaceId: string, sinceIso: string): Promise<UsageSummary>;
  /** Per-agent AI spend for a business from agent_runs (drawer readout, S8). */
  getBusinessCostSummary(businessId: string): Promise<BusinessCostSummary>;
  getWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfig | null>;
  /** Upserts so a workspace missing its config row can still save. */
  updateWorkspaceConfig(
    workspaceId: string,
    patch: UpdateWorkspaceConfigRequest,
  ): Promise<WorkspaceConfig>;

  // auth support
  getWorkspaceIdForUser(userId: string): Promise<string | null>;
}

/** Shared lead ordering: sellability desc, nulls last, then name asc. */
export function sortLeads(leads: LeadView[]): LeadView[] {
  return [...leads].sort((a, b) => {
    const sa = a.audit?.sellability_score ?? null;
    const sb = b.audit?.sellability_score ?? null;
    if (sa === null && sb === null)
      return a.business.name.localeCompare(b.business.name);
    if (sa === null) return 1;
    if (sb === null) return -1;
    if (sb !== sa) return sb - sa;
    return a.business.name.localeCompare(b.business.name);
  });
}
