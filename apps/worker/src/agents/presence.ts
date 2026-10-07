/**
 * Presence — PRD 6.5 (v1, deterministic + Sonnet 4.6 summary).
 *
 * NAP comparison (name/address/phone) between the stored Places data and
 * the fetched homepage: deterministic normalize + compare. GBP photo
 * count / hours completeness are not captured by Scout in v1 — they stay
 * null/"unknown", never invented (CLAUDE.md 6.3). The summary (model or
 * template) narrates; a Sonnet call may only adjudicate near-misses.
 */
import type { AgentResult, Business } from "@rapidforge/shared";
import { generateJsonSummary, MODEL_HAIKU } from "../lib/ai";
import type { FetchedSite } from "../lib/site";
import { makePresenceSummaryGuardrail } from "./guardrails/presence-summary";
import {
  buildPresenceSummaryPrompt,
  PRESENCE_SUMMARY_SYSTEM,
  PresenceSummarySchema,
  type PresenceSummary,
} from "./prompts/presence";
import { stripTags } from "./conversion";

// ---------------------------------------------------------------------------
// Deterministic NAP normalization + comparison — exported for unit tests
// ---------------------------------------------------------------------------

/** US phone → bare 10 digits; null when it isn't a usable US number. */
export function normalizePhoneDigits(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

const ADDRESS_ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bstreet\b/g, "st"],
  [/\bavenue\b/g, "ave"],
  [/\broad\b/g, "rd"],
  [/\bboulevard\b/g, "blvd"],
  [/\bdrive\b/g, "dr"],
  [/\blane\b/g, "ln"],
  [/\bcourt\b/g, "ct"],
  [/\bplace\b/g, "pl"],
  [/\bhighway\b/g, "hwy"],
  [/\bsuite\b/g, "ste"],
  [/\bnorth\b/g, "n"],
  [/\bsouth\b/g, "s"],
  [/\beast\b/g, "e"],
  [/\bwest\b/g, "w"],
];

/** Lowercase, strip punctuation, collapse abbreviations to short form. */
export function normalizeAddress(raw: string): string {
  let out = raw.toLowerCase().replace(/[.,#]/g, " ");
  for (const [pattern, short] of ADDRESS_ABBREVIATIONS) {
    out = out.replace(pattern, short);
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A street address (house number + street suffix) in normalized page text
 * (RFL.FIX.3c). Only its presence matters: it turns "Google's street is not
 * on the page" into a real mismatch instead of an absence.
 */
const STREET_ADDRESS_RE =
  /\b\d{2,6}\s+[A-Za-z0-9. ]{2,40}\b(st|ave|rd|dr|blvd|ln|ct|pl|hwy|way)\b/i;

export interface NapComparison extends Record<string, unknown> {
  google_phone: string | null;
  site_phones: string[];
  /** Null = unknown (a side is missing) — never invented. */
  nap_phone_match: boolean | null;
  google_street: string | null;
  /**
   * true = Google's street line is on the homepage; false = a DIFFERENT
   * street address is; null = the homepage shows no street address (or
   * Google has none) — absence is not a mismatch (RFL.FIX.3c).
   */
  nap_address_match: boolean | null;
  /** True only when phone AND address both verifiably match. */
  nap_consistent: boolean | null;
}

/** Pure NAP compare between the Places record and the homepage HTML. */
export function compareNap(business: Business, html: string): NapComparison {
  const text = stripTags(html);

  const sitePhoneSet = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const digits = normalizePhoneDigits(match[1]!);
    if (digits) sitePhoneSet.add(digits);
  }
  for (const match of text.matchAll(
    /\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g,
  )) {
    const digits = normalizePhoneDigits(match[0]);
    if (digits) sitePhoneSet.add(digits);
  }
  const sitePhones = [...sitePhoneSet];

  const googlePhone = business.phone ? normalizePhoneDigits(business.phone) : null;
  const napPhoneMatch =
    googlePhone === null || sitePhones.length === 0
      ? null
      : sitePhones.includes(googlePhone);

  const googleStreet = business.address
    ? (business.address.split(",")[0] ?? "").trim() || null
    : null;
  let napAddressMatch: boolean | null = null;
  if (googleStreet) {
    const siteText = normalizeAddress(text);
    if (siteText.includes(normalizeAddress(googleStreet))) napAddressMatch = true;
    else if (STREET_ADDRESS_RE.test(siteText)) napAddressMatch = false;
  }

  let napConsistent: boolean | null;
  if (napPhoneMatch === false || napAddressMatch === false) {
    napConsistent = false;
  } else if (napPhoneMatch === true && napAddressMatch === true) {
    napConsistent = true;
  } else {
    napConsistent = null; // partial/unknown — not claimed either way
  }

  return {
    google_phone: googlePhone,
    site_phones: sitePhones,
    nap_phone_match: napPhoneMatch,
    google_street: googleStreet,
    nap_address_match: napAddressMatch,
    nap_consistent: napConsistent,
  };
}

const SOCIAL_RE =
  /https?:\/\/(?:www\.)?(facebook|instagram|yelp|linkedin|tiktok|youtube|twitter|x)\.com\/[^"']*|https?:\/\/linktr\.ee\/[^"']*/gi;

/** Social profiles linked from the homepage, deduped by platform. */
export function findSocialLinks(html: string): string[] {
  const found = new Map<string, string>();
  for (const match of html.matchAll(SOCIAL_RE)) {
    const url = match[0]!;
    const platform = match[1] ?? "linktree";
    if (!found.has(platform)) found.set(platform, url);
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------

export type HoursCompleteness = "complete" | "partial" | "missing" | "unknown";

export interface PresenceOutput extends Record<string, unknown> {
  nap: NapComparison;
  social_links: string[];
  /** Places photo count from places_details; null when no details held. */
  gbp_photo_count: number | null;
  /** From places_details.regularOpeningHours (RFL-06); unknown without details. */
  hours_completeness: HoursCompleteness;
  summary: PresenceSummary;
}

/** The slice of places_details Presence reads (raw Places (New) shape). */
interface PlacesDetailsSlice {
  regularOpeningHours?: {
    weekdayDescriptions?: string[];
    periods?: Array<{ open?: { day?: number } }>;
  };
  photos?: unknown[];
}

/**
 * GBP hours completeness from a raw Place Details record (pure):
 *   unknown  — no details record held (never fetched)
 *   missing  — details held, no regularOpeningHours
 *   partial  — fewer than 7 weekdays described / covered
 *   complete — all 7 weekdays present (a "Closed" day still counts)
 */
export function hoursCompletenessFrom(
  placesDetails: Record<string, unknown> | null | undefined,
): HoursCompleteness {
  if (!placesDetails) return "unknown";
  const hours = (placesDetails as PlacesDetailsSlice).regularOpeningHours;
  if (!hours) return "missing";
  const described = (hours.weekdayDescriptions ?? []).filter(
    (d) => typeof d === "string" && d.trim().length > 0,
  ).length;
  const coveredDays = new Set(
    (hours.periods ?? [])
      .map((p) => p.open?.day)
      .filter((d): d is number => typeof d === "number"),
  ).size;
  const days = Math.max(described, coveredDays);
  if (days >= 7) return "complete";
  if (days > 0) return "partial";
  return "missing";
}

/** Places photo count from a raw details record; null when none held. */
export function gbpPhotoCountFrom(
  placesDetails: Record<string, unknown> | null | undefined,
): number | null {
  if (!placesDetails) return null;
  const photos = (placesDetails as PlacesDetailsSlice).photos;
  return Array.isArray(photos) ? photos.length : 0;
}

export function buildTemplatePresenceSummary(
  business: Business,
  nap: NapComparison,
  socialLinks: string[],
): PresenceSummary {
  const assessment: PresenceSummary["nap_assessment"] =
    nap.nap_consistent === true
      ? "consistent"
      : nap.nap_consistent === false
        ? "mismatch"
        : "unknown";

  const sentences: string[] = [];
  if (nap.google_phone && nap.site_phones.length > 0) {
    sentences.push(
      `Google lists phone ${nap.google_phone}; the site shows ${nap.site_phones.join(", ")} — ${nap.nap_phone_match ? "match" : "MISMATCH"}.`,
    );
  } else {
    sentences.push(
      `Phone comparison is unknown: Google ${nap.google_phone ? "has" : "has no"} phone, site shows ${nap.site_phones.length} number(s).`,
    );
  }
  if (nap.google_street) {
    sentences.push(
      nap.nap_address_match === true
        ? `Street line "${nap.google_street}" appears on the homepage.`
        : nap.nap_address_match === false
          ? `Street line "${nap.google_street}" does NOT appear; the homepage shows a different street address.`
          : `The homepage shows no street address to compare with "${nap.google_street}".`,
    );
  } else {
    sentences.push("Google listing has no address to compare.");
  }
  sentences.push(
    socialLinks.length > 0
      ? `${socialLinks.length} social profile link(s) found on the site.`
      : "No social profile links found on the site.",
  );

  return {
    reasoning: sentences.join(" "),
    nap_assessment: assessment,
    compared: {
      google_phone: nap.google_phone,
      site_phone: nap.site_phones[0] ?? null,
      google_address: nap.google_street,
      address_found_on_site: nap.nap_address_match,
    },
    summary_one_liner:
      assessment === "consistent"
        ? "Listing and website agree — NAP is consistent."
        : assessment === "mismatch"
          ? `Listing/website disagree — ${business.name} risks losing local-search trust.`
          : "NAP consistency could not be fully verified.",
  };
}

export interface PresenceContext {
  /** Stage budget signal (RFL.QUEUE.8) — cancels the AI request. */
  signal?: AbortSignal;
  business: Business;
  site: FetchedSite | null;
}

export async function runPresence(
  ctx: PresenceContext,
): Promise<AgentResult<PresenceOutput>> {
  const startedAt = Date.now();
  try {
    if (ctx.site === null) {
      return {
        agent: "presence",
        status: "failed",
        output: null,
        error: "Homepage fetch failed — NAP comparison impossible",
        modelUsed: null,
        tokensUsed: 0,
        costCents: 0,
        durationMs: Date.now() - startedAt,
        guardrailPassed: true,
        guardrailNotes: null,
      };
    }
    const nap = compareNap(ctx.business, ctx.site.html);
    const socialLinks = findSocialLinks(ctx.site.html);

    const summary = await generateJsonSummary({
      model: MODEL_HAIKU,
      kind: "narration",
      agent: "presence",
      system: PRESENCE_SUMMARY_SYSTEM,
      prompt: buildPresenceSummaryPrompt({
        business_name: ctx.business.name,
        ...nap,
        social_links: socialLinks,
      }),
      schema: PresenceSummarySchema,
      guardrail: makePresenceSummaryGuardrail({
        napConsistent: nap.nap_consistent,
      }),
      template: () =>
        buildTemplatePresenceSummary(ctx.business, nap, socialLinks),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      agent: "presence",
      status: "completed",
      output: {
        nap,
        social_links: socialLinks,
        gbp_photo_count: gbpPhotoCountFrom(ctx.business.places_details),
        hours_completeness: hoursCompletenessFrom(ctx.business.places_details),
        summary: summary.value,
      },
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
      agent: "presence",
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
