/**
 * Reputation — PRD 6.9 (v1.5, deterministic + Haiku narration / template). GOOGLE-FIRST
 * per the Sprint 6 decision: every number comes from data already held.
 *
 * Deterministic signals (worker-measured, CLAUDE.md 4.2):
 *   - Google rating + review count (Places data on the business row)
 *   - volume band (fixed thresholds; "high" requires >=50 reviews)
 *   - review VELOCITY across audits: each audit snapshots review_count;
 *     when a previous completed audit carries a snapshot, velocity =
 *     (current - previous) / months elapsed. First audit = unknown.
 *   - review recency: UNKNOWN in v1 — Places review timestamps are not
 *     fetched; never invented (CLAUDE.md 6.3).
 *   - Yelp cross-reference/divergence: stubbed behind lib/yelp.ts with a
 *     YELP_API_KEY check, clearly marked v1.5 — divergence stays null.
 *
 * Sonnet writes the verdict narrative; themes come only from provided
 * review text — the Places reviews persisted in businesses.places_details
 * (RFL-06) when present — so guardrails reject any quote that is not
 * verbatim from that text. The deterministic template never invents themes.
 */
import type { AgentResult, Audit, Business } from "@rapidforge/shared";
import { generateJsonSummary, MODEL_HAIKU } from "../lib/ai";
import { getYelpClient } from "../lib/yelp";
import { makeReputationSummaryGuardrail } from "./guardrails/reputation-summary";
import {
  buildReputationSummaryPrompt,
  ratingBandFor,
  REPUTATION_SUMMARY_SYSTEM,
  ReputationSummarySchema,
  type ReputationSummary,
  type ReputationVerdict,
  type VolumeBand,
} from "./prompts/reputation";

/** Volume bands (fixed thresholds — "high" starts at 50, PRD 6.9). */
export const VOLUME_BAND_THRESHOLDS = {
  low: 1,
  moderate: 10,
  high: 50,
  veryHigh: 200,
} as const;

export function volumeBandFor(reviewCount: number | null): VolumeBand {
  const count = reviewCount ?? 0;
  if (count >= VOLUME_BAND_THRESHOLDS.veryHigh) return "very_high";
  if (count >= VOLUME_BAND_THRESHOLDS.high) return "high";
  if (count >= VOLUME_BAND_THRESHOLDS.moderate) return "moderate";
  if (count >= VOLUME_BAND_THRESHOLDS.low) return "low";
  return "none";
}

export { ratingBandFor };

/**
 * Deterministic verdict for the template path (never from the LLM).
 * Sentiment is the rating (RFL.FIX.3f); volume is a confidence qualifier,
 * not a demotion — 5.0★ across 7 reviews is "strong", never "mixed".
 */
export function templateVerdictFor(
  rating: number | null,
  reviewCount: number | null,
): ReputationVerdict {
  if ((reviewCount ?? 0) === 0) return "unknown";
  return ratingBandFor(rating);
}

/** Reputation snapshot persisted with each audit (in score_breakdown). */
export interface ReputationSnapshot {
  review_count_at_audit: number | null;
}

/**
 * Read the previous audit's reputation snapshot (persisted by the Scorer
 * under score_breakdown.v15_agents.reputation). Null = no usable history.
 */
export function readPreviousSnapshot(
  previousAudit: Audit | null,
): { reviewCount: number; completedAt: string } | null {
  if (!previousAudit?.completed_at) return null;
  const breakdown = previousAudit.score_breakdown as {
    v15_agents?: { reputation?: { review_count_at_audit?: unknown } };
  } | null;
  const count = breakdown?.v15_agents?.reputation?.review_count_at_audit;
  if (typeof count !== "number") return null;
  return { reviewCount: count, completedAt: previousAudit.completed_at };
}

const DAYS_PER_MONTH = 30.44;
/** Below this window a velocity number would be noise, not a measurement. */
export const MIN_VELOCITY_WINDOW_MONTHS = 0.25;

export function computeReviewVelocityPerMonth(
  currentCount: number | null,
  previous: { reviewCount: number; completedAt: string } | null,
  now: Date,
): { velocity: number | null; monthsSincePrevious: number | null } {
  if (currentCount === null || previous === null) {
    return { velocity: null, monthsSincePrevious: null };
  }
  const elapsedMs = now.getTime() - Date.parse(previous.completedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { velocity: null, monthsSincePrevious: null };
  }
  const months = elapsedMs / (DAYS_PER_MONTH * 86_400_000);
  if (months < MIN_VELOCITY_WINDOW_MONTHS) {
    return { velocity: null, monthsSincePrevious: Math.round(months * 100) / 100 };
  }
  return {
    velocity: Math.round(((currentCount - previous.reviewCount) / months) * 10) / 10,
    monthsSincePrevious: Math.round(months * 100) / 100,
  };
}

export interface ReputationOutput extends Record<string, unknown> {
  google_rating: number | null;
  review_count: number | null;
  volume_band: VolumeBand;
  /** Reviews gained per month since the previous audit (null = unknown). */
  review_velocity_per_month: number | null;
  months_since_previous_audit: number | null;
  /** Snapshot the NEXT audit's velocity computation reads. */
  review_count_at_audit: number | null;
  /** Always null in v1 — recency data is not held (never invented). */
  last_review_at: null;
  /** Yelp cross-reference — stub v1.5; divergence stays null. */
  yelp_rating: number | null;
  yelp_review_count: number | null;
  rating_divergence: number | null;
  summary: ReputationSummary;
}

/** One review as handed to the model — text capped, nothing invented. */
export interface ReviewTextInput {
  rating: number | null;
  text: string;
  when: string | null;
}

export const MAX_REVIEWS_FOR_THEMES = 5;
export const MAX_REVIEW_CHARS = 400;

/**
 * Review texts from a raw places_details record (pure): highest rating
 * first, then longest, capped to MAX_REVIEWS_FOR_THEMES and
 * MAX_REVIEW_CHARS. Empty when no details / no text.
 */
export function reviewTextsFrom(
  placesDetails: Record<string, unknown> | null | undefined,
): ReviewTextInput[] {
  const reviews = (placesDetails as {
    reviews?: Array<{
      rating?: number;
      text?: { text?: string };
      originalText?: { text?: string };
      relativePublishTimeDescription?: string;
    }>;
  } | null)?.reviews;
  if (!Array.isArray(reviews)) return [];
  return reviews
    .map((r) => ({
      rating: typeof r.rating === "number" ? r.rating : null,
      text: (r.text?.text ?? r.originalText?.text ?? "").trim(),
      when: r.relativePublishTimeDescription ?? null,
    }))
    .filter((r) => r.text.length > 0)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.text.length - a.text.length)
    .slice(0, MAX_REVIEWS_FOR_THEMES)
    .map((r) => ({ ...r, text: r.text.slice(0, MAX_REVIEW_CHARS) }));
}

export interface ReputationContext {
  /** Stage budget signal (RFL.QUEUE.8) — cancels the AI request. */
  signal?: AbortSignal;
  business: Business;
  /** Latest completed audit BEFORE this run — the velocity baseline. */
  previousAudit: Audit | null;
  /** Injected for determinism. */
  now: Date;
}

/** How much the review count lets a reader trust the rating (template prose). */
const VOLUME_CONFIDENCE: Record<VolumeBand, string> = {
  none: "no reviews to support it",
  low: "low confidence — fewer than 10 reviews",
  moderate: "moderate confidence — 10 to 49 reviews",
  high: "high confidence — 50 or more reviews",
  very_high: "very high confidence — 200 or more reviews",
};

/** Exported for unit tests: the deterministic template narrative. */
export function buildTemplateSummary(
  rating: number | null,
  reviewCount: number | null,
  volumeBand: VolumeBand,
  velocity: number | null,
  reviewsConsidered = 0,
): ReputationSummary {
  const verdict = templateVerdictFor(rating, reviewCount);
  const count = reviewCount ?? 0;
  const bits = [
    rating === null
      ? "No Google rating on record."
      : count === 0
        ? `Google rating ${rating} with no reviews yet — nothing to judge.`
        : `Google rating ${rating} across ${count} review${count === 1 ? "" : "s"}: ${verdict} rating, ${VOLUME_CONFIDENCE[volumeBand]} (${volumeBand} volume).`,
    velocity === null
      ? "Review velocity unknown (first audit or no baseline)."
      : `Gaining ${velocity} reviews/month since the previous audit.`,
    reviewsConsidered > 0
      ? `${reviewsConsidered} review text${reviewsConsidered === 1 ? "" : "s"} on file; themes are only extracted by the model path. Yelp cross-reference is v1.5.`
      : "Review text and recency are not collected in v1; Yelp cross-reference is v1.5.",
  ];
  return {
    verdict,
    volume_band: volumeBand,
    themes: [], // the template never themes — quotes come only from the model path (CLAUDE.md 6.3)
    reasoning: bits.join(" "),
  };
}

export async function runReputation(
  ctx: ReputationContext,
): Promise<AgentResult<ReputationOutput>> {
  const startedAt = Date.now();
  try {
    const { business, now } = ctx;
    const rating = business.google_rating;
    const reviewCount = business.review_count;
    const volumeBand = volumeBandFor(reviewCount);
    const previous = readPreviousSnapshot(ctx.previousAudit);
    const { velocity, monthsSincePrevious } = computeReviewVelocityPerMonth(
      reviewCount,
      previous,
      now,
    );

    // v1.5 seam: stub always answers null; divergence therefore unknown.
    const yelp = await getYelpClient().fetchBusinessSignals(
      business.name,
      business.address,
    );
    const yelpRating = yelp?.rating ?? null;
    const ratingDivergence =
      rating !== null && yelpRating !== null
        ? Math.round((rating - yelpRating) * 10) / 10
        : null;

    // RFL-06: Places review text (when Filter persisted details) feeds the
    // existing Sonnet theme extraction; quotes must be verbatim from it.
    const reviews = reviewTextsFrom(business.places_details);
    const signals = {
      google_rating: rating,
      review_count: reviewCount,
      volume_band: volumeBand,
      review_velocity_per_month: velocity,
      months_since_previous_audit: monthsSincePrevious,
      last_review_at: null,
      yelp_available: yelp !== null,
      review_text_available: reviews.length > 0,
      ...(reviews.length > 0 ? { reviews } : {}),
    };

    const summary = await generateJsonSummary({
      model: MODEL_HAIKU,
      kind: "narration",
      agent: "reputation",
      system: REPUTATION_SUMMARY_SYSTEM,
      prompt: buildReputationSummaryPrompt(signals),
      schema: ReputationSummarySchema,
      guardrail: makeReputationSummaryGuardrail(
        volumeBand,
        reviews.map((r) => r.text),
        rating,
      ),
      template: () =>
        buildTemplateSummary(rating, reviewCount, volumeBand, velocity, reviews.length),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    return {
      agent: "reputation",
      status: "completed",
      output: {
        google_rating: rating,
        review_count: reviewCount,
        volume_band: volumeBand,
        review_velocity_per_month: velocity,
        months_since_previous_audit: monthsSincePrevious,
        review_count_at_audit: reviewCount,
        last_review_at: null,
        yelp_rating: yelpRating,
        yelp_review_count: yelp?.review_count ?? null,
        rating_divergence: ratingDivergence,
        reviews_considered: reviews.length,
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
      agent: "reputation",
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
