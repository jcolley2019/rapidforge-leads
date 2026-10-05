/**
 * Design Brief — structured JSON for the demo-site generator (audit finding
 * 10 / section (f) steps 4–6; RFL.BRIEF.7). Deterministic assembler over the
 * audit row + businesses.places_details (RFL-06) for everything except two
 * judgment fields (tone_descriptors, services), which come from ONE Haiku 4.5
 * strict-JSON call via lib/ai.ts with a deterministic template fallback.
 *
 * On-demand (POST /api/businesses/:id/design-brief) and embedded in the
 * Builder Brief markdown. Guardrails: quotes verbatim, judgment fields
 * non-empty, whole brief parses — or the agent fails and writes nothing.
 */
import {
  DESIGN_BRIEF_LIMITS,
  DesignBriefSchema,
  WEEKDAY_NAMES,
  type AgentResult,
  type Audit,
  type BriefHours,
  type Business,
  type DesignBrief,
  type ReviewQuote,
} from "@rapidforge/shared";
import {
  generateJsonSummary,
  MODEL_HAIKU,
} from "../lib/ai";
import { designBriefGuardrail } from "./guardrails/design-brief";
import {
  buildDesignBriefJudgmentPrompt,
  DESIGN_BRIEF_JUDGMENT_SYSTEM,
  DesignBriefJudgmentSchema,
  type DesignBriefJudgment,
} from "./prompts/design-brief";

/** Worker route that proxies a Places photo (RFL-06); relative to the worker. */
export const PHOTO_ROUTE_PREFIX = "/api/places/photo/";

// ---------------------------------------------------------------------------
// places_details / audit readers (defensive — jsonb is untyped)
// ---------------------------------------------------------------------------

interface PlacesDetailsSlice {
  types?: string[];
  regularOpeningHours?: {
    periods?: Array<{
      open?: { day?: number; hour?: number; minute?: number };
      close?: { day?: number; hour?: number; minute?: number };
    }>;
    weekdayDescriptions?: string[];
  };
  photos?: Array<{ name?: string }>;
  reviews?: Array<{
    rating?: number;
    text?: { text?: string };
    originalText?: { text?: string };
    authorAttribution?: { displayName?: string };
  }>;
}

function detailsOf(business: Business): PlacesDetailsSlice {
  return (business.places_details ?? {}) as PlacesDetailsSlice;
}

/** Every review text held for the business — the verbatim-quote haystack. */
export function reviewTextsOf(business: Business): string[] {
  return (detailsOf(business).reviews ?? [])
    .map((r) => (r.text?.text ?? r.originalText?.text ?? "").trim())
    .filter((t) => t.length > 0);
}

interface V15Agents {
  seo?: { h1s?: string[] };
  conversion?: {
    cta_candidates?: string[];
    booking_url?: string | null;
    visible_phone?: string | null;
    has_tel_link?: boolean;
    has_form?: boolean;
  };
}

function v15Of(audit: Audit): V15Agents {
  return ((audit.score_breakdown as { v15_agents?: V15Agents } | null)?.v15_agents ??
    {}) as V15Agents;
}

// ---------------------------------------------------------------------------
// Deterministic pieces — exported for unit tests
// ---------------------------------------------------------------------------

/** Top quotes: rating desc, then text length desc; skip short reviews. */
export function pickReviewQuotes(business: Business): ReviewQuote[] {
  return (detailsOf(business).reviews ?? [])
    .map((r) => ({
      text: (r.text?.text ?? r.originalText?.text ?? "").trim(),
      rating: typeof r.rating === "number" ? r.rating : null,
      author: r.authorAttribution?.displayName,
    }))
    .filter((q) => q.text.length >= DESIGN_BRIEF_LIMITS.quoteMinChars)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.text.length - a.text.length)
    .slice(0, DESIGN_BRIEF_LIMITS.quotesMax)
    .map((q) => (q.author ? q : { text: q.text, rating: q.rating }));
}

/** Worker photo-route URLs for the stored photo refs (never raw Places URIs). */
export function photoUrlsOf(business: Business): string[] {
  return (detailsOf(business).photos ?? [])
    .map((p) => p.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .slice(0, DESIGN_BRIEF_LIMITS.photosMax)
    .map((n) => `${PHOTO_ROUTE_PREFIX}${encodeURIComponent(n)}?maxWidthPx=1600`);
}

function hhmm(hour: number | undefined, minute: number | undefined): string {
  const h = String(hour ?? 0).padStart(2, "0");
  const m = String(minute ?? 0).padStart(2, "0");
  return `${h}:${m}`;
}

/** "7:00 AM" / "12:30 PM" / "Closed" → "HH:MM" or null. */
function parseClock(text: string): string | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i.exec(text.replace(/ | /g, " "));
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3]!.toUpperCase() === "PM") hour += 12;
  return hhmm(hour, Number(m[2] ?? 0));
}

/**
 * Places regularOpeningHours → one entry per weekday, Sunday first.
 * Prefers `periods` (structured); falls back to parsing
 * weekdayDescriptions ("Monday: 7:00 AM – 6:00 PM", "Sunday: Closed").
 * Null when the details hold no hours at all.
 */
export function normalizeHours(
  placesDetails: Record<string, unknown> | null | undefined,
): BriefHours[] | null {
  const hours = (placesDetails as PlacesDetailsSlice | null)?.regularOpeningHours;
  if (!hours) return null;
  const byDay = new Map<number, { open: string | null; close: string | null }>();

  const periods = hours.periods ?? [];
  for (const p of periods) {
    const day = p.open?.day;
    if (typeof day !== "number" || day < 0 || day > 6) continue;
    if (byDay.has(day)) continue; // first period of a split shift wins
    byDay.set(day, {
      open: hhmm(p.open?.hour, p.open?.minute),
      close: p.close ? hhmm(p.close.hour, p.close.minute) : null,
    });
  }

  if (byDay.size === 0) {
    for (const line of hours.weekdayDescriptions ?? []) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const dayName = line.slice(0, colon).trim();
      const rest = line.slice(colon + 1).trim();
      const day = WEEKDAY_NAMES.findIndex((d) => d.toLowerCase() === dayName.toLowerCase());
      if (day < 0) continue;
      const times = rest.split(/\s[–—-]\s|–|—/).map((s) => s.trim());
      const open = times[0] ? parseClock(times[0]) : null;
      const close = times[1] ? parseClock(times[1]) : null;
      byDay.set(day, { open, close });
    }
  }

  if (byDay.size === 0) return null;
  return WEEKDAY_NAMES.map((day, i) => {
    const entry = byDay.get(i);
    return { day, open: entry?.open ?? null, close: entry?.close ?? null };
  });
}

/** booking_url → tel: → cta_candidates[0] → form (PRD 6.4 CTA order). */
export function pickPrimaryCta(business: Business, audit: Audit): DesignBrief["primary_cta"] {
  const conv = v15Of(audit).conversion ?? {};
  if (conv.booking_url) {
    return { label: "Book online", kind: "booking", href: conv.booking_url };
  }
  const phone = business.phone ?? conv.visible_phone ?? null;
  if (phone) {
    return {
      label: `Call ${phone}`,
      kind: "phone",
      href: `tel:${phone.replace(/[^\d+]/g, "")}`,
    };
  }
  const cta = conv.cta_candidates?.find((c) => c.trim().length > 0);
  if (cta) {
    return { label: cta.trim().slice(0, 60), kind: "other", href: business.website_url ?? "#" };
  }
  return {
    label: "Request a quote",
    kind: "form",
    href: business.website_url ? `${business.website_url.replace(/\/$/, "")}/#contact` : "#contact",
  };
}

/** analyst_output.one_line_verdict → issues[0].label → a generic line. */
export function pickSiteProblem(audit: Audit): string {
  const verdict = (audit.analyst_output as { one_line_verdict?: string } | null)
    ?.one_line_verdict;
  if (verdict && verdict.trim()) return verdict.trim();
  const first = audit.issues?.[0];
  if (first) return first.detail ? `${first.label} — ${first.detail}` : first.label;
  return "Current site has no measurable conversion path";
}

/** Vertical: Places category → first Places type → generic. */
export function pickVertical(business: Business): string {
  return business.category ?? detailsOf(business).types?.[0] ?? "local_service";
}

/** Category token → brand-voice adjectives for the template fallback. */
export const TONE_BY_CATEGORY: ReadonlyArray<[match: RegExp, tones: string[]]> = [
  [/plumb|drain|sewer|rooter/, ["dependable", "straight-talking", "fast-response"]],
  [/hvac|heating|cooling|\bair\b|air_cond/, ["reliable", "comfort-focused", "professional"]],
  [/electric/, ["safety-first", "precise", "licensed"]],
  [/roof/, ["sturdy", "trustworthy", "weather-ready"]],
  [/hair|salon|barber|beauty|nail|spa|wax/, ["welcoming", "stylish", "personal"]],
  [/dent/, ["gentle", "modern", "family-friendly"]],
  [/gym|fitness|yoga|pilates|training/, ["energetic", "motivating", "community"]],
  [/restaurant|cafe|pizza|grill|bakery|food/, ["inviting", "fresh", "local"]],
  [/auto|tire|mechanic|car_repair|oil/, ["honest", "no-nonsense", "experienced"]],
  [/clean|maid/, ["spotless", "trustworthy", "thorough"]],
  [/landscap|lawn|tree/, ["hands-on", "seasonal", "neighborly"]],
];

export function templateTone(vertical: string): string[] {
  const key = vertical.toLowerCase();
  const hit = TONE_BY_CATEGORY.find(([re]) => re.test(key));
  return hit ? [...hit[1]] : ["professional", "local", "trustworthy"];
}

/** Template services: SEO agent's H1s (cleaned, deduped) → humanized category. */
export function templateServices(business: Business, audit: Audit): string[] {
  const h1s = (v15Of(audit).seo?.h1s ?? [])
    .map((h) => h.replace(/\s+/g, " ").trim())
    .filter((h) => h.length >= 3 && h.length <= 60);
  const unique = [...new Set(h1s)].slice(0, DESIGN_BRIEF_LIMITS.servicesMax);
  if (unique.length > 0) return unique;
  const humanized = pickVertical(business).replace(/_/g, " ");
  return [`${humanized.charAt(0).toUpperCase()}${humanized.slice(1)} services`];
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

export interface DesignBriefContext {
  business: Business;
  audit: Audit;
  /** Same homepage excerpt the Builder Brief prompt uses (route fetches it). */
  siteHtmlExcerpt: string | null;
  /** Injected for determinism. */
  now?: Date;
}

export interface DesignBriefBuild {
  brief: DesignBrief;
  modelUsed: string | null;
  tokensUsed: number;
  costCents: number | null;
  costMicrocents: number | null;
  guardrailPassed: boolean;
  guardrailNotes: string | null;
}

/**
 * Build the brief. Throws when the assembled brief fails DesignBriefSchema
 * or the verbatim-quote guardrail — callers must not persist on throw.
 */
export async function buildDesignBrief(ctx: DesignBriefContext): Promise<DesignBriefBuild> {
  const { business, audit } = ctx;
  const vertical = pickVertical(business);
  const reviewTexts = reviewTextsOf(business);
  const headings = v15Of(audit).seo?.h1s ?? [];

  const judgment = await generateJsonSummary<DesignBriefJudgment>({
    model: MODEL_HAIKU,
    system: DESIGN_BRIEF_JUDGMENT_SYSTEM,
    prompt: buildDesignBriefJudgmentPrompt({
      category: vertical,
      homepage_excerpt: ctx.siteHtmlExcerpt,
      headings,
      review_texts: reviewTexts.slice(0, 5).map((t) => t.slice(0, 400)),
    }),
    maxTokens: 600,
    schema: DesignBriefJudgmentSchema,
    guardrail: (value) =>
      value.tone_descriptors.length > 0 && value.services.length > 0
        ? { passed: true, notes: null }
        : { passed: false, notes: "empty tone_descriptors or services" },
    template: () => ({
      tone_descriptors: templateTone(vertical),
      services: templateServices(business, audit),
    }),
  });

  const brief: DesignBrief = {
    business_name: business.name,
    vertical,
    tone_descriptors: judgment.value.tone_descriptors,
    services: judgment.value.services,
    review_quotes: pickReviewQuotes(business),
    photo_urls: photoUrlsOf(business),
    hours: normalizeHours(business.places_details),
    phone: business.phone,
    address: business.address,
    primary_cta: pickPrimaryCta(business, audit),
    current_site_problem: pickSiteProblem(audit),
    generated_at: (ctx.now ?? new Date()).toISOString(),
    source: {
      audit_id: audit.id,
      ...(judgment.modelUsed ? { haiku_model: judgment.modelUsed } : {}),
      template_fallback: judgment.modelUsed === null,
    },
  };

  const verdict = designBriefGuardrail(brief, reviewTexts);
  if (!verdict.passed) {
    throw new Error(`Design brief guardrail failed: ${verdict.notes}`);
  }
  // Belt and braces: the persisted object is exactly the schema.
  const parsed = DesignBriefSchema.parse(brief);

  return {
    brief: parsed,
    modelUsed: judgment.modelUsed,
    tokensUsed: judgment.tokensUsed,
    costCents: judgment.costCents,
    costMicrocents: judgment.costMicrocents,
    guardrailPassed: judgment.guardrailPassed,
    guardrailNotes: judgment.guardrailNotes,
  };
}

/** Agent wrapper for runOnDemandAgent — output IS the brief. */
export async function runDesignBrief(
  ctx: DesignBriefContext,
): Promise<AgentResult<DesignBrief & Record<string, unknown>>> {
  const startedAt = Date.now();
  try {
    const built = await buildDesignBrief(ctx);
    return {
      agent: "design-brief",
      status: "completed",
      output: built.brief,
      error: null,
      modelUsed: built.modelUsed,
      tokensUsed: built.tokensUsed,
      costCents: built.costCents,
      costMicrocents: built.costMicrocents,
      durationMs: Date.now() - startedAt,
      guardrailPassed: built.guardrailPassed,
      guardrailNotes: built.guardrailNotes,
    };
  } catch (err) {
    return {
      agent: "design-brief",
      status: "failed",
      output: null,
      error: err instanceof Error ? err.message : String(err),
      modelUsed: null,
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - startedAt,
      guardrailPassed: false,
      guardrailNotes: null,
    };
  }
}

/** The fenced block the Builder Brief embeds under "## Design Brief (JSON)". */
export const DESIGN_BRIEF_SECTION = "Design Brief (JSON)";

export function embedDesignBrief(markdown: string, brief: DesignBrief): string {
  const block = `## ${DESIGN_BRIEF_SECTION}\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\`\n`;
  return `${markdown.replace(/\s+$/, "")}\n\n${block}`;
}
