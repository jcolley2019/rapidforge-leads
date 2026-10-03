/**
 * Zod schemas for the core tables (PRD Section 5). Field names are
 * snake_case to match Postgres rows as returned by supabase-js.
 *
 * Timestamps are ISO strings; uuids are strings. Nullability mirrors the
 * DDL: columns without NOT NULL are nullable here.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums / fragments
// ---------------------------------------------------------------------------

export const WorkspaceRoleSchema = z.enum(["owner", "admin", "member"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const SearchModeSchema = z.enum(["zip_radius", "map_draw", "keyword"]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const WebsiteKindSchema = z.enum([
  "real",
  "social_only",
  "none",
  "unknown",
]);

export const LeadStatusSchema = z.enum([
  "new",
  "called",
  "interested",
  "sold",
  "dead",
]);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const AgentRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const UsageEventTypeSchema = z.enum([
  "places_call",
  "pagespeed_call",
  "ai_call",
  "audit_run",
]);
export type UsageEventType = z.infer<typeof UsageEventTypeSchema>;

/**
 * Zip/radius search params (PRD 7.3 New Search tab; searches.params jsonb).
 * Validated by the web form before POST and by the worker on receipt.
 */
export const ZipRadiusParamsSchema = z.object({
  zip: z.string().regex(/^\d{5}$/, "5-digit US zip code"),
  radius_miles: z.number().min(1).max(25),
  min_reviews: z.number().int().min(0).default(0),
  min_rating: z.number().min(0).max(5).default(0),
  /** PRD 6.2: is_chain exclusion is configurable; ON by default (RFL-04). */
  exclude_chains: z.boolean().default(true),
});
export type ZipRadiusParams = z.infer<typeof ZipRadiusParamsSchema>;

/**
 * Map-radius search params (Sprint 5 map tab; searches.params jsonb).
 * Same filter set as zip/radius; the pin replaces the zip geocode.
 */
export const MapDrawParamsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_miles: z.number().min(1).max(25),
  min_reviews: z.number().int().min(0).default(0),
  min_rating: z.number().min(0).max(5).default(0),
  /** Same default as zip/radius: chains excluded unless the user opts in. */
  exclude_chains: z.boolean().default(true),
});
export type MapDrawParams = z.infer<typeof MapDrawParamsSchema>;

/** POST /api/searches body (PRD Section 8). keyword mode lands v1.5. */
export const CreateSearchRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("zip_radius"),
    /** Places (New) included type, e.g. 'plumber'. */
    category: z.string().min(1),
    params: ZipRadiusParamsSchema,
  }),
  z.object({
    mode: z.literal("map_draw"),
    category: z.string().min(1),
    params: MapDrawParamsSchema,
  }),
]);
export type CreateSearchRequest = z.infer<typeof CreateSearchRequestSchema>;

/**
 * POST /api/leads/:id/status body (PRD Section 8). Every field optional so
 * the drawer can autosave notes without touching status; at least one field
 * must be present. last_contacted_at is server-managed (set on status change).
 */
export const UpdateLeadStatusRequestSchema = z
  .object({
    status: LeadStatusSchema.optional(),
    notes: z.string().max(20_000).nullable().optional(),
    next_followup_at: z.string().nullable().optional(),
  })
  .refine(
    (o) =>
      o.status !== undefined ||
      o.notes !== undefined ||
      o.next_followup_at !== undefined,
    { message: "at least one of status, notes, next_followup_at required" },
  );
export type UpdateLeadStatusRequest = z.infer<
  typeof UpdateLeadStatusRequestSchema
>;

/** PUT /api/config body — the six cascading variables (CLAUDE.md 6.4). */
export const UpdateWorkspaceConfigRequestSchema = z.object({
  your_offer: z.string().nullable().optional(),
  target_industry: z.string().nullable().optional(),
  ideal_website_traits: z.string().nullable().optional(),
  sales_tone: z.string().nullable().optional(),
  user_location: z.string().nullable().optional(),
  user_brand: z.string().nullable().optional(),
});
export type UpdateWorkspaceConfigRequest = z.infer<
  typeof UpdateWorkspaceConfigRequestSchema
>;

/** GET /api/usage response — current-month usage_events rollup (PRD 7.2). */
export const UsageSummarySchema = z.object({
  month_start: z.string(),
  total_cents: z.number().int(),
  events: z.number().int(),
  by_type: z.record(
    z.string(),
    z.object({ count: z.number().int(), cost_cents: z.number().int() }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/** "What's wrong" issue bullet (PRD 4.5), stored in audits.issues. */
export const IssueSchema = z.object({
  severity: z.enum(["low", "medium", "high"]),
  label: z.string(),
  detail: z.string().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

const uuid = z.string().uuid();
const timestamp = z.string(); // timestamptz → ISO string via supabase-js
const jsonb = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// 5.1 Tenancy
// ---------------------------------------------------------------------------

export const PlanSchema = z.object({
  id: uuid,
  name: z.string(), // 'founder' | 'free' | 'starter' | 'pro'
  monthly_search_limit: z.number().int().nullable(), // null = unlimited
  monthly_audit_limit: z.number().int().nullable(),
  max_radius_miles: z.number().int().nullable(),
  max_results_per_search: z.number().int().nullable(),
  price_cents: z.number().int().nullable(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const WorkspaceSchema = z.object({
  id: uuid,
  name: z.string(),
  plan_id: uuid.nullable(),
  owner_user_id: uuid.nullable(),
  places_api_key: z.string().nullable(), // BYOK, null = platform key (v2)
  created_at: timestamp.nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceMemberSchema = z.object({
  workspace_id: uuid,
  user_id: uuid,
  role: WorkspaceRoleSchema,
  created_at: timestamp.nullable(),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

/** Cascading agent variables (CLAUDE.md 6.4) — per workspace. */
export const WorkspaceConfigSchema = z.object({
  workspace_id: uuid,
  your_offer: z.string().nullable(),
  target_industry: z.string().nullable(),
  ideal_website_traits: z.string().nullable(),
  sales_tone: z.string().nullable(),
  user_location: z.string().nullable(),
  user_brand: z.string().nullable(),
  updated_at: timestamp.nullable(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// ---------------------------------------------------------------------------
// 5.2 Domain
// ---------------------------------------------------------------------------

export const SearchSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  created_by: uuid,
  mode: SearchModeSchema,
  params: jsonb,
  category: z.string(),
  status: z.string().nullable(), // 'pending' default; lifecycle owned by worker
  results_count: z.number().int().nullable(),
  created_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
});
export type Search = z.infer<typeof SearchSchema>;

/** Why a business was marked is_chain (RFL-04; migration 0008). */
export const ChainReasonSchema = z.enum([
  "known_brand",
  "url_shape",
  "multi_location",
]);
export type ChainReason = z.infer<typeof ChainReasonSchema>;

export const BusinessSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  google_place_id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  website_url: z.string().nullable(),
  address: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  google_rating: z.number().nullable(),
  review_count: z.number().int().nullable(),
  category: z.string().nullable(),
  business_status: z.string().nullable(),
  is_chain: z.boolean().nullable(),
  /** Optional: columns arrive with migration 0008. */
  chain_reason: ChainReasonSchema.nullable().optional(),
  name_normalized: z.string().nullable().optional(),
  website_kind: WebsiteKindSchema.nullable(),
  first_seen_at: timestamp.nullable(),
  last_refreshed_at: timestamp.nullable(),
});
export type Business = z.infer<typeof BusinessSchema>;

export const SearchResultSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  search_id: uuid,
  business_id: uuid,
  latest_audit_id: uuid.nullable(),
  status: LeadStatusSchema.nullable(),
  notes: z.string().nullable(),
  last_contacted_at: timestamp.nullable(),
  next_followup_at: timestamp.nullable(),
  created_at: timestamp.nullable(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const AuditSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  business_id: uuid,
  website_url: z.string().nullable(),
  ps_performance: z.number().int().nullable(),
  ps_mobile_performance: z.number().int().nullable(),
  ps_accessibility: z.number().int().nullable(),
  ps_seo: z.number().int().nullable(),
  ps_best_practices: z.number().int().nullable(),
  ps_lcp_ms: z.number().int().nullable(),
  ps_cls: z.number().nullable(),
  http_status: z.number().int().nullable(),
  ssl_valid: z.boolean().nullable(),
  response_ms: z.number().int().nullable(),
  platform: z.string().nullable(),
  copyright_year: z.number().int().nullable(),
  has_phone: z.boolean().nullable(),
  has_form: z.boolean().nullable(),
  has_booking: z.boolean().nullable(),
  has_chat: z.boolean().nullable(),
  has_viewport_meta: z.boolean().nullable(),
  has_schema_markup: z.boolean().nullable(),
  gbp_photo_count: z.number().int().nullable(),
  gbp_review_velocity: z.number().nullable(),
  has_crux_data: z.boolean().nullable(),
  screenshot_desktop_url: z.string().nullable(),
  screenshot_mobile_url: z.string().nullable(),
  website_health_score: z.number().int().nullable(),
  star_grade: z.number().nullable(),
  sellability_score: z.number().int().nullable(),
  score_breakdown: jsonb.nullable(),
  issues: z.array(IssueSchema).nullable(),
  analyst_output: jsonb.nullable(), // Fable 5 narrative (v1.5)
  builder_brief_md: z.string().nullable(), // Fable 5 brief (v1.5)
  sales_summary: jsonb.nullable(), // talk track (v1.5)
  status: z.string().nullable(),
  error_message: z.string().nullable(),
  /**
   * Scores are placeholders, not measurements — e.g. bot protection blocked
   * the audit (finding 4). Migration 0007a; optional so rows read before the
   * column exists still parse.
   */
  provisional: z.boolean().nullable().optional(),
  created_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
});
export type Audit = z.infer<typeof AuditSchema>;

// ---------------------------------------------------------------------------
// 5.3 Operational
// ---------------------------------------------------------------------------

export const JobSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  job_type: z.string(), // 'scout' | 'audit_business' | 'analyst' | ...
  payload: jsonb,
  status: JobStatusSchema.nullable(),
  attempts: z.number().int().nullable(),
  error: z.string().nullable(),
  created_at: timestamp.nullable(),
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const AgentRunSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  agent_name: z.string(),
  job_id: uuid.nullable(),
  target_id: uuid.nullable(), // business_id typically
  status: AgentRunStatusSchema,
  input: jsonb.nullable(),
  output: jsonb.nullable(),
  error: z.string().nullable(),
  model_used: z.string().nullable(),
  tokens_used: z.number().int().nullable(),
  cost_cents: z.number().int().nullable(),
  guardrail_passed: z.boolean().nullable(),
  guardrail_notes: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const UsageEventSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  event_type: UsageEventTypeSchema,
  cost_cents: z.number().int().nullable(),
  metadata: jsonb.nullable(),
  created_at: timestamp.nullable(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;
