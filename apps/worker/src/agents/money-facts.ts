/**
 * Shared measured-data view for the Sprint 7 money agents (Analyst, Builder
 * Brief, Sales Summary). All three synthesize FROM the same deterministic
 * facts — never re-scoring, never inventing measurements (CLAUDE.md 4.2/6.3).
 *
 * Health/Conversion/Traffic land on the audit's typed columns; the Sprint 6
 * agents (Design/Reputation/SEO) ride score_breakdown.v15_agents. This module
 * reads both defensively (the jsonb is untyped) into one flat shape.
 */
import type { Audit, Business, Issue } from "@rapidforge/shared";

/** The audit agents whose findings the money agents may cite by name. */
export const CITABLE_AGENTS = [
  "health",
  "conversion",
  "presence",
  "traffic",
  "design",
  "reputation",
  "seo",
] as const;
export type CitableAgent = (typeof CITABLE_AGENTS)[number];

export interface AuditFacts {
  business: {
    name: string;
    category: string | null;
    address: string | null;
    phone: string | null;
    website_url: string | null;
    google_rating: number | null;
    review_count: number | null;
    business_status: string | null;
    is_chain: boolean;
    website_kind: string | null;
  };
  scores: {
    health_score: number | null;
    star_grade: number | null;
    sellability_score: number | null;
  };
  health: {
    platform: string | null;
    copyright_year: number | null;
    ssl_valid: boolean | null;
    ps_mobile_performance: number | null;
    ps_desktop_performance: number | null;
    ps_seo: number | null;
    ps_accessibility: number | null;
    ps_lcp_ms: number | null;
    ps_cls: number | null;
    response_ms: number | null;
    has_crux_data: boolean | null;
  };
  conversion: {
    has_phone: boolean | null;
    has_form: boolean | null;
    has_booking: boolean | null;
    has_chat: boolean | null;
    has_viewport_meta: boolean | null;
    has_schema_markup: boolean | null;
  };
  design: {
    modernity_0_100: number | null;
    feels_like_year: number | null;
    critical_issues: string[];
  } | null;
  reputation: {
    verdict: string | null;
    volume_band: string | null;
    google_rating: number | null;
    review_count: number | null;
    review_velocity_per_month: number | null;
  } | null;
  seo: {
    local_fit_score_1_5: number | null;
    has_title: boolean | null;
    has_meta_description: boolean | null;
    has_sitemap: boolean | null;
  } | null;
  issues: Issue[];
  /** Which audit agents produced usable data — the citable set for guardrails. */
  agents_run: CitableAgent[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Extract the Sprint 6 agent blocks from score_breakdown.v15_agents. */
function v15(audit: Audit): Record<string, unknown> {
  const breakdown = asRecord(audit.score_breakdown);
  return asRecord(breakdown?.v15_agents) ?? {};
}

export function buildAuditFacts(business: Business, audit: Audit): AuditFacts {
  const agents = v15(audit);

  const designRaw = asRecord(agents.design);
  const design = designRaw
    ? {
        modernity_0_100: num(designRaw.modernity_0_100),
        feels_like_year: num(designRaw.feels_like_year),
        // Design persists {issue, evidence} objects (prompts/design.ts);
        // older rows may hold plain strings. Both reach the money agents
        // (RFL.FIX.3g — the object form used to be dropped as []).
        critical_issues: Array.isArray(designRaw.critical_issues)
          ? designRaw.critical_issues
              .map((x: unknown) =>
                typeof x === "string"
                  ? x
                  : typeof (x as { issue?: unknown } | null)?.issue === "string"
                    ? ((x as { issue: string }).issue)
                    : null,
              )
              .filter((x): x is string => x !== null && x.length > 0)
          : [],
      }
    : null;

  const repRaw = asRecord(agents.reputation);
  const repSummary = asRecord(repRaw?.summary);
  const reputation = repRaw
    ? {
        verdict: str(repSummary?.verdict),
        volume_band: str(repRaw.volume_band),
        google_rating: num(repRaw.google_rating),
        review_count: num(repRaw.review_count),
        review_velocity_per_month: num(repRaw.review_velocity_per_month),
      }
    : null;

  const seoRaw = asRecord(agents.seo);
  const seoSummary = asRecord(seoRaw?.summary);
  const seo = seoRaw
    ? {
        local_fit_score_1_5: num(seoSummary?.local_fit_score_1_5),
        has_title: bool(asRecord(seoRaw.title)?.found),
        has_meta_description: bool(asRecord(seoRaw.meta_description)?.found),
        has_sitemap: bool(seoRaw.has_sitemap),
      }
    : null;

  // "Ran" = produced usable data. Health/Conversion/Traffic are inferred from
  // their audit columns; Design/Reputation/SEO from their v15 blocks.
  const agentsRun: CitableAgent[] = [];
  if (audit.platform !== null || audit.ps_mobile_performance !== null) {
    agentsRun.push("health");
  }
  if (audit.has_phone !== null || audit.has_form !== null) {
    agentsRun.push("conversion");
  }
  if (audit.gbp_photo_count !== null || business.address !== null) {
    agentsRun.push("presence");
  }
  if (audit.has_crux_data !== null) agentsRun.push("traffic");
  if (design) agentsRun.push("design");
  if (reputation) agentsRun.push("reputation");
  if (seo) agentsRun.push("seo");

  return {
    business: {
      name: business.name,
      category: business.category,
      address: business.address,
      phone: business.phone,
      website_url: business.website_url,
      google_rating: business.google_rating,
      review_count: business.review_count,
      business_status: business.business_status,
      is_chain: business.is_chain === true,
      website_kind: business.website_kind,
    },
    scores: {
      health_score: audit.website_health_score,
      star_grade: audit.star_grade,
      sellability_score: audit.sellability_score,
    },
    health: {
      platform: audit.platform,
      copyright_year: audit.copyright_year,
      ssl_valid: audit.ssl_valid,
      ps_mobile_performance: audit.ps_mobile_performance,
      ps_desktop_performance: audit.ps_performance,
      ps_seo: audit.ps_seo,
      ps_accessibility: audit.ps_accessibility,
      ps_lcp_ms: audit.ps_lcp_ms,
      ps_cls: audit.ps_cls,
      response_ms: audit.response_ms,
      has_crux_data: audit.has_crux_data,
    },
    conversion: {
      has_phone: audit.has_phone,
      has_form: audit.has_form,
      has_booking: audit.has_booking,
      has_chat: audit.has_chat,
      has_viewport_meta: audit.has_viewport_meta,
      has_schema_markup: audit.has_schema_markup,
    },
    design,
    reputation,
    seo,
    issues: audit.issues ?? [],
    agents_run: agentsRun,
  };
}

/** Compact JSON the money-agent prompts embed as the measured-data block. */
export function factsToPromptJson(facts: AuditFacts): string {
  return JSON.stringify(facts, null, 2);
}
