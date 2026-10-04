/**
 * Conversion — PRD 6.4 (v1, deterministic parse + Sonnet 4.6 summary).
 *
 * Deterministically detects every contact/booking affordance on the
 * fetched homepage: tel: links, forms + field counts, booking links,
 * chat widgets, viewport meta, schema markup, above-fold CTA candidates.
 * The summary (model or template) evaluates CTA strength citing exact
 * element text — never a general impression.
 */
import type { AgentResult, Business } from "@rapidforge/shared";
import { generateJsonSummary, MODEL_HAIKU } from "../lib/ai";
import type { FetchedSite } from "../lib/site";
import { makeConversionSummaryGuardrail } from "./guardrails/conversion-summary";
import {
  buildConversionSummaryPrompt,
  CONVERSION_SUMMARY_SYSTEM,
  ConversionSummarySchema,
  type ConversionSummary,
} from "./prompts/conversion";

/** "Above the fold" heuristic: the leading slice of the document. */
export const ABOVE_FOLD_HTML_BYTES = 6000;

const PHONE_TEXT_RE = /\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g;

/** Booking providers by href, plus generic booking/scheduling paths. */
const BOOKING_HREF_RE =
  /(calendly\.com|\bcal\.com\/|housecallpro\.com|acuityscheduling\.com|getjobber\.com|setmore\.com|squareup\.com\/appointments)/i;
const BOOKING_PATH_RE =
  /\/(book|booking|schedule|schedule-service|appointments?)(\/|$|\?|#)/i;

const CHAT_RE =
  /(livechat|tawk\.to|crisp\.chat|tidio|intercom|drift\.com|zopim|smartsupp|fb-customerchat|podium\.com)/i;

const CTA_WORDS_RE =
  /\b(call|quote|book|schedule|contact|estimate|request|appointment|get started|free|help now)\b/i;

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ConversionSignals extends Record<string, unknown> {
  has_tel_link: boolean;
  tel_numbers: string[];
  has_visible_phone: boolean;
  visible_phone: string | null;
  form_count: number;
  max_form_fields: number;
  has_form: boolean;
  has_booking: boolean;
  booking_url: string | null;
  has_chat: boolean;
  chat_evidence: string | null;
  has_viewport_meta: boolean;
  has_schema_markup: boolean;
  has_cta_above_fold: boolean;
  cta_candidates: string[];
}

/** Pure deterministic homepage parse — exported for unit tests. */
export function parseConversionSignals(html: string): ConversionSignals {
  const telNumbers = [...html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)].map(
    (m) => m[1]!.trim(),
  );

  const text = stripTags(html);
  const visiblePhones = text.match(PHONE_TEXT_RE) ?? [];

  const formBlocks = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  const fieldCounts = formBlocks.map(
    (block) => (block.match(/<(input|select|textarea)\b/gi) ?? []).length,
  );

  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(
    (m) => m[1]!,
  );
  const bookingUrl =
    hrefs.find((href) => {
      if (BOOKING_HREF_RE.test(href)) return true;
      if (href.startsWith("tel:") || href.startsWith("mailto:")) return false;
      try {
        return BOOKING_PATH_RE.test(new URL(href, "https://x.example").pathname);
      } catch {
        return false;
      }
    }) ?? null;

  const chatMatch = html.match(CHAT_RE);

  const aboveFold = html.slice(0, ABOVE_FOLD_HTML_BYTES);
  const ctaCandidates: string[] = [];
  for (const match of aboveFold.matchAll(
    /<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi,
  )) {
    const label = stripTags(match[2] ?? "");
    if (label.length > 0 && label.length <= 80 && CTA_WORDS_RE.test(label)) {
      ctaCandidates.push(label);
      if (ctaCandidates.length >= 5) break;
    }
  }

  return {
    has_tel_link: telNumbers.length > 0,
    tel_numbers: telNumbers,
    has_visible_phone: visiblePhones.length > 0,
    visible_phone: visiblePhones[0] ?? null,
    form_count: formBlocks.length,
    max_form_fields: fieldCounts.length ? Math.max(...fieldCounts) : 0,
    has_form: formBlocks.length > 0,
    has_booking: bookingUrl !== null,
    booking_url: bookingUrl,
    has_chat: chatMatch !== null,
    chat_evidence: chatMatch?.[1] ?? null,
    has_viewport_meta: /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html),
    has_schema_markup:
      /application\/ld\+json|itemscope|itemtype\s*=\s*["']https?:\/\/schema\.org/i.test(
        html,
      ),
    has_cta_above_fold: ctaCandidates.length > 0,
    cta_candidates: ctaCandidates,
  };
}

export interface ConversionOutput extends ConversionSignals {
  summary: ConversionSummary;
}

/** Deterministic CTA verdict + narrative citing parsed element text. */
export function buildTemplateConversionSummary(
  signals: ConversionSignals,
  html: string,
): ConversionSummary {
  const strength: ConversionSummary["cta_strength"] =
    signals.has_cta_above_fold && (signals.has_tel_link || signals.has_booking)
      ? "strong"
      : signals.has_cta_above_fold ||
          signals.has_form ||
          signals.has_tel_link ||
          signals.has_visible_phone
        ? "weak"
        : "none";

  const haystack = html.replace(/\s+/g, " ").toLowerCase();
  const evidence: ConversionSummary["evidence"] = signals.cta_candidates
    .filter((label) => haystack.includes(label.toLowerCase()))
    .slice(0, 3)
    .map((label) => ({ element: "cta", quote: label }));
  if (
    signals.visible_phone &&
    haystack.includes(signals.visible_phone.toLowerCase())
  ) {
    evidence.push({ element: "phone_text", quote: signals.visible_phone });
  }

  const bits = [
    `${signals.form_count} form(s) found (largest has ${signals.max_form_fields} fields).`,
    `tel: link ${signals.has_tel_link ? "present" : "absent"}; visible phone ${signals.has_visible_phone ? "present" : "absent"}.`,
    `Booking link ${signals.has_booking ? `present (${signals.booking_url})` : "absent"}; chat widget ${signals.has_chat ? `present (${signals.chat_evidence})` : "absent"}.`,
    `${signals.cta_candidates.length} above-fold CTA candidate(s).`,
  ];
  return {
    reasoning: bits.join(" "),
    cta_strength: strength,
    evidence,
    summary_one_liner:
      strength === "strong"
        ? `Strong conversion path: "${signals.cta_candidates[0] ?? "clear CTA"}" plus direct contact options.`
        : strength === "weak"
          ? "Contact is possible but the page does not push a clear next step."
          : "No meaningful way to convert a visitor on this homepage.",
  };
}

export interface ConversionContext {
  /** Stage budget signal (RFL.QUEUE.8) — cancels the AI request. */
  signal?: AbortSignal;
  business: Business;
  site: FetchedSite | null;
}

export async function runConversion(
  ctx: ConversionContext,
): Promise<AgentResult<ConversionOutput>> {
  const startedAt = Date.now();
  try {
    if (ctx.site === null) {
      return {
        agent: "conversion",
        status: "failed",
        output: null,
        error: "Homepage fetch failed — no HTML to parse",
        modelUsed: null,
        tokensUsed: 0,
        costCents: 0,
        durationMs: Date.now() - startedAt,
        guardrailPassed: true,
        guardrailNotes: null,
      };
    }
    const html = ctx.site.html;
    const signals = parseConversionSignals(html);

    const summary = await generateJsonSummary({
      model: MODEL_HAIKU,
      kind: "narration",
      system: CONVERSION_SUMMARY_SYSTEM,
      prompt: buildConversionSummaryPrompt(signals),
      schema: ConversionSummarySchema,
      guardrail: makeConversionSummaryGuardrail(html),
      template: () => buildTemplateConversionSummary(signals, html),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      agent: "conversion",
      status: "completed",
      output: { ...signals, summary: summary.value },
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
      agent: "conversion",
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
