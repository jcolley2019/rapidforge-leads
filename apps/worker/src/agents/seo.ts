/**
 * SEO — PRD 6.10 (v1.5, deterministic + Sonnet 4.6).
 *
 * The worker MEASURES everything (CLAUDE.md 4.2 deterministic-before-AI):
 * title, meta description, H1s, schema.org types from the fetched
 * homepage; /sitemap.xml + /robots.txt existence via the SiteFetcher seam
 * (null = unknown, never "missing"); and local-keyword presence for
 * {city} + {category} (city parsed from the Places address). Sonnet only
 * judges element quality and local fit over those facts.
 *
 * Guardrails (PRD 6.10): found=true with a null value never persists
 * (deterministic invariant), and a local-fit score of 5 with a missing
 * title/meta/H1 is rejected, re-run once, then persisted flagged.
 */
import type { AgentResult, Business } from "@rapidforge/shared";
import { cityFromPlacesAddress } from "../lib/address";
import { generateJsonSummary, MODEL_HAIKU } from "../lib/ai";
import type { FetchedSite } from "../lib/site";
import { stripTags } from "./conversion";
import {
  makeSeoSummaryGuardrail,
  seoChecksInvariant,
  type SeoElement,
} from "./guardrails/seo-summary";
import {
  describeLocalTarget,
  humanizeCategory,
  resolveLocalTarget,
} from "./prompts/config-vars";
import {
  buildSeoSummaryPrompt,
  buildSeoSummarySystem,
  SeoSummarySchema,
  type SeoSummary,
} from "./prompts/seo";

// ---------------------------------------------------------------------------
// Deterministic extraction (pure — exported for unit tests)
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&middot;/gi, "·")
    .replace(/&nbsp;/gi, " ");
}

export function extractTitle(html: string): SeoElement {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const value = match ? decodeEntities(stripTags(match[1] ?? "")).trim() : "";
  return value ? { found: true, value } : { found: false, value: null };
}

export function extractMetaDescription(html: string): SeoElement {
  // Attribute order varies: name before content and content before name.
  const match =
    html.match(
      /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i,
    ) ??
    html.match(
      /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i,
    );
  const value = match ? decodeEntities(match[1] ?? "").trim() : "";
  return value ? { found: true, value } : { found: false, value: null };
}

export function extractH1s(html: string): string[] {
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((m) => decodeEntities(stripTags(m[1] ?? "")).trim())
    .filter((h1) => h1.length > 0);
}

/** schema.org types from ld+json blocks and microdata itemtype attributes. */
export function extractSchemaTypes(html: string): string[] {
  const types = new Set<string>();
  for (const block of html.matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = block[1] ?? "";
    try {
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (node && typeof node === "object") {
          const type = (node as { "@type"?: unknown })["@type"];
          if (typeof type === "string") types.add(type);
          if (Array.isArray(type))
            type.forEach((t) => typeof t === "string" && types.add(t));
          Object.values(node).forEach(collect);
        }
      };
      collect(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD: fall back to a literal @type scan.
      for (const m of raw.matchAll(/"@type"\s*:\s*"([^"]+)"/g)) {
        types.add(m[1]!);
      }
    }
  }
  for (const m of html.matchAll(
    /itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi,
  )) {
    types.add(m[1]!);
  }
  return [...types].sort();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary matching so "boisedrainpros" does NOT count as "Boise".
 */
function includesToken(haystack: string | null, token: string | null): boolean {
  if (!haystack || !token) return false;
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(haystack);
}

/**
 * How a page names each Places type (RFL.FIX.3b): "plumber" is written
 * "Plumbing", "general_contractor" "Remodeling Contractor". Regex sources,
 * matched at a word start ("plumb" hits "Plumbers"); a trailing \b makes a
 * stem whole-word ("tan\b" never hits "Tank"). Covers every type in the web
 * category picker plus the primary types Places has returned for them.
 */
const CATEGORY_STEMS: Readonly<Record<string, readonly string[]>> = {
  plumber: ["plumb"],
  electrician: ["electric"],
  roofing_contractor: ["roof"],
  general_contractor: ["contractor", "contracting", "construction", "remodel", "renovat", "handyman"],
  hvac_contractor: ["hvac", "heating", "cooling", "air\\s+condition", "furnace"],
  painter: ["paint"],
  locksmith: ["lock"],
  moving_company: ["mover", "moving"],
  landscaper: ["landscap", "lawn", "yard"],
  dentist: ["dentist", "dental"],
  dental_clinic: ["dentist", "dental"],
  hair_salon: ["salon", "hair", "barber", "stylist"],
  barber_shop: ["barber", "hair"],
  beauty_salon: ["salon", "beauty", "nail", "lash", "brow", "esthetic"],
  nail_salon: ["nail", "salon"],
  tanning_studio: ["tanning", "tan\\b"],
  cosmetics_store: ["cosmetic", "makeup", "beauty", "skin\\s*care"],
  spa: ["spas?\\b", "massage", "facial"],
  gym: ["gym", "fitness", "crossfit"],
  fitness_center: ["gym", "fitness", "crossfit"],
  restaurant: ["restaurant", "grill", "kitchen", "bistro", "eatery", "diner", "dining", "cuisine"],
  cafe: ["cafe", "café", "coffee", "espresso"],
  coffee_shop: ["cafe", "café", "coffee", "espresso"],
  car_repair: ["auto", "mechanic", "repair", "brake", "transmission"],
  car_wash: ["wash", "detailing"],
  real_estate_agency: ["real\\s+estate", "realt", "broker", "homes\\s+for\\s+sale"],
  lawyer: ["lawyer", "attorney", "law\\b", "legal", "counsel"],
  veterinary_care: ["vets?\\b", "veterinar", "animal\\s+(hospital|clinic)"],
  florist: ["florist", "floral", "flower"],
  educational_institution: ["school", "academy", "college", "institute", "education"],
};

/**
 * Word-start pattern for a Places type: its stems (by exact type, else by
 * its last word — "mexican_restaurant" uses "restaurant") plus the type
 * itself with "_" → space as a whole word, plural allowed ("general
 * contractors"; "spa" never hits "Spanish").
 */
export function categoryPattern(category: string): RegExp {
  const words = category.toLowerCase().split("_").filter((w) => w.length > 0);
  const stems = CATEGORY_STEMS[category.toLowerCase()] ?? CATEGORY_STEMS[words.at(-1) ?? ""] ?? [];
  const humanised = `${words.map(escapeRegExp).join("\\s+")}s?\\b`;
  return new RegExp(`\\b(?:${[...stems, humanised].join("|")})`, "i");
}

function mentionsCategory(haystack: string | null, category: string | null): boolean {
  if (!haystack || !category) return false;
  return categoryPattern(category).test(haystack);
}

export interface SeoChecks extends Record<string, unknown> {
  title: SeoElement;
  meta_description: SeoElement;
  h1s: string[];
  h1_count: number;
  schema_types: string[];
  has_schema: boolean;
  /** Null = unknown (probe failed) — never reported as missing. */
  has_sitemap: boolean | null;
  has_robots_txt: boolean | null;
  city: string | null;
  /** Raw Places type ("general_contractor") — the matching key. */
  category: string | null;
  /** Humanised for prose ("general contractor") — what prompts and templates print (RFL.FIX.3c). */
  category_label: string | null;
  title_has_city: boolean;
  title_has_category: boolean;
  h1_has_city: boolean;
  h1_has_category: boolean;
  meta_has_city: boolean;
  meta_has_category: boolean;
}

export function runSeoChecks(
  html: string,
  business: Pick<Business, "address" | "category">,
  hasSitemap: boolean | null,
  hasRobots: boolean | null,
): SeoChecks {
  const title = extractTitle(html);
  const meta = extractMetaDescription(html);
  const h1s = extractH1s(html);
  const schemaTypes = extractSchemaTypes(html);
  const city = cityFromPlacesAddress(business.address);
  const category = business.category;
  const h1Text = h1s.join(" ");
  return {
    title,
    meta_description: meta,
    h1s,
    h1_count: h1s.length,
    schema_types: schemaTypes,
    has_schema: schemaTypes.length > 0,
    has_sitemap: hasSitemap,
    has_robots_txt: hasRobots,
    city,
    category,
    category_label: humanizeCategory(category),
    title_has_city: includesToken(title.value, city),
    title_has_category: mentionsCategory(title.value, category),
    h1_has_city: includesToken(h1Text, city),
    h1_has_category: mentionsCategory(h1Text, category),
    meta_has_city: includesToken(meta.value, city),
    meta_has_category: mentionsCategory(meta.value, category),
  };
}

// ---------------------------------------------------------------------------
// Template summary (deterministic)
// ---------------------------------------------------------------------------

export function buildTemplateSeoSummary(checks: SeoChecks): SeoSummary {
  const gaps: string[] = [];
  if (!checks.title.found) gaps.push("Missing <title> tag");
  if (!checks.meta_description.found) gaps.push("Missing meta description");
  if (checks.h1_count === 0) gaps.push("No H1 heading");
  if (!checks.has_schema) gaps.push("No schema.org structured data");
  if (checks.has_sitemap === false) gaps.push("No sitemap.xml");
  if (checks.has_robots_txt === false) gaps.push("No robots.txt");
  if (checks.title.found && !checks.title_has_city && checks.city !== null) {
    gaps.push(`Title does not mention ${checks.city}`);
  }
  const categoryLabel = checks.category_label ?? humanizeCategory(checks.category);
  if (
    checks.title.found &&
    !checks.title_has_category &&
    categoryLabel !== null
  ) {
    gaps.push(`Title does not mention "${categoryLabel}"`);
  }

  const complete =
    checks.title.found && checks.meta_description.found && checks.h1_count > 0;
  let score = 3;
  if (checks.title_has_city && checks.title_has_category) score += 1;
  if (checks.h1_has_city || checks.h1_has_category) score += 1;
  if (!checks.title.found || checks.h1_count === 0) score -= 2;
  if (!checks.meta_description.found) score -= 1;
  if (!checks.has_schema) score -= 1;
  score = Math.min(5, Math.max(1, score));
  // Guardrail-consistent by construction: 5 requires the full element set.
  if (score === 5 && !complete) score = 4;

  const local =
    checks.city && categoryLabel
      ? `Local target "${describeLocalTarget(resolveLocalTarget(categoryLabel, checks.city))}": title ${
          checks.title_has_city && checks.title_has_category
            ? "targets it"
            : "does not target it"
        }.`
      : "Local target unknown (city or category missing from Places data).";
  return {
    local_fit_score_1_5: score,
    reasoning: `Measured elements — title: ${
      checks.title.value ?? "none"
    }; meta description: ${
      checks.meta_description.found ? "present" : "none"
    }; H1s: ${checks.h1_count}; schema types: ${
      checks.schema_types.join(", ") || "none"
    }; sitemap: ${checks.has_sitemap ?? "unknown"}; robots.txt: ${
      checks.has_robots_txt ?? "unknown"
    }. ${local}`,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface SeoOutput extends SeoChecks {
  summary: SeoSummary;
}

export interface SeoContext {
  /** Stage budget signal (RFL.QUEUE.8) — cancels the AI request. */
  signal?: AbortSignal;
  business: Business;
  site: FetchedSite | null;
  /** Probed by the orchestrator through the SiteFetcher seam. */
  hasSitemap: boolean | null;
  hasRobots: boolean | null;
}

export async function runSeo(ctx: SeoContext): Promise<AgentResult<SeoOutput>> {
  const startedAt = Date.now();
  try {
    if (ctx.site === null) {
      return {
        agent: "seo",
        status: "failed",
        output: null,
        error: "Homepage fetch failed — no HTML to analyze",
        modelUsed: null,
        tokensUsed: 0,
        costCents: 0,
        durationMs: Date.now() - startedAt,
        guardrailPassed: true,
        guardrailNotes: null,
      };
    }

    const checks = runSeoChecks(
      ctx.site.html,
      ctx.business,
      ctx.hasSitemap,
      ctx.hasRobots,
    );
    const invariant = seoChecksInvariant(checks);
    if (!invariant.passed) {
      // A found=true/null-value pair is a code bug — never persist it.
      throw new Error(`SEO extraction invariant failed: ${invariant.notes}`);
    }

    const summary = await generateJsonSummary({
      model: MODEL_HAIKU,
      kind: "narration",
      system: buildSeoSummarySystem(
        resolveLocalTarget(checks.category, checks.city),
      ),
      prompt: buildSeoSummaryPrompt(checks),
      schema: SeoSummarySchema,
      guardrail: makeSeoSummaryGuardrail(checks),
      template: () => buildTemplateSeoSummary(checks),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      agent: "seo",
      status: "completed",
      output: { ...checks, summary: summary.value },
      error: null,
      modelUsed: summary.modelUsed,
      tokensUsed: summary.tokensUsed,
      costCents: summary.costCents,
      costMicrocents: summary.costMicrocents,
      durationMs: Date.now() - startedAt,
      guardrailPassed: summary.guardrailPassed,
      guardrailNotes: summary.guardrailNotes,
    };
  } catch (err) {
    return {
      agent: "seo",
      status: "failed",
      output: null,
      error: err instanceof Error ? err.message : String(err),
      modelUsed: null,
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - startedAt,
      guardrailPassed: true,
      guardrailNotes: null,
    };
  }
}
