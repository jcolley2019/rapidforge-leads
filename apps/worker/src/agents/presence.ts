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
import { generateJsonSummary, MODEL_SONNET } from "../lib/ai";
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

export interface NapComparison extends Record<string, unknown> {
  google_phone: string | null;
  site_phones: string[];
  /** Null = unknown (a side is missing) — never invented. */
  nap_phone_match: boolean | null;
  google_street: string | null;
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
  const napAddressMatch = googleStreet
    ? normalizeAddress(text).includes(normalizeAddress(googleStreet))
    : null;

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

export interface PresenceOutput extends Record<string, unknown> {
  nap: NapComparison;
  social_links: string[];
  /** Not captured by Scout in v1 — stays unknown, never invented. */
  gbp_photo_count: null;
  hours_completeness: "unknown";
  summary: PresenceSummary;
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
      `Street line "${nap.google_street}" ${nap.nap_address_match ? "appears" : "does NOT appear"} on the homepage.`,
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
      model: MODEL_SONNET,
      system: PRESENCE_SUMMARY_SYSTEM,
      prompt: buildPresenceSummaryPrompt({
        business_name: ctx.business.name,
        ...nap,
        social_links: socialLinks,
      }),
      parse: (raw) => PresenceSummarySchema.parse(JSON.parse(raw)),
      guardrail: makePresenceSummaryGuardrail({
        napConsistent: nap.nap_consistent,
      }),
      template: () =>
        buildTemplatePresenceSummary(ctx.business, nap, socialLinks),
    });

    return {
      agent: "presence",
      status: "completed",
      output: {
        nap,
        social_links: socialLinks,
        gbp_photo_count: null,
        hours_completeness: "unknown",
        summary: summary.value,
      },
      error: null,
      modelUsed: summary.modelUsed,
      tokensUsed: summary.tokensUsed,
      costCents: summary.costCents,
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
