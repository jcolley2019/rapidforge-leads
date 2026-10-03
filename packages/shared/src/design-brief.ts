/**
 * Design Brief — the structured JSON contract the demo-site generator reads
 * (audit finding 10 / section (f) step 4; RFL.BRIEF.7). Persisted as
 * audits.design_brief (migration 0007) and embedded in the Builder Brief
 * markdown under "## Design Brief (JSON)".
 *
 * Everything is deterministic except tone_descriptors and services, which
 * one Haiku 4.5 strict-JSON call (or the template fallback) supplies.
 */
import { z } from "zod";

export const DESIGN_BRIEF_LIMITS = {
  toneMin: 3,
  toneMax: 5,
  servicesMin: 1,
  servicesMax: 12,
  quotesMax: 5,
  /** Review text shorter than this is never quoted. */
  quoteMinChars: 40,
  photosMax: 8,
} as const;

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

export const ReviewQuoteSchema = z.object({
  /** Verbatim substring of a places_details.reviews text (guardrail-enforced). */
  text: z.string().min(DESIGN_BRIEF_LIMITS.quoteMinChars),
  rating: z.number().min(1).max(5).nullable(),
  author: z.string().optional(),
});
export type ReviewQuote = z.infer<typeof ReviewQuoteSchema>;

/** One weekday; open/close are "HH:MM" 24h, both null on a closed day. */
export const BriefHoursSchema = z.object({
  day: z.enum(WEEKDAY_NAMES),
  open: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  close: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
});
export type BriefHours = z.infer<typeof BriefHoursSchema>;

export const PrimaryCtaKindSchema = z.enum(["booking", "phone", "form", "other"]);
export type PrimaryCtaKind = z.infer<typeof PrimaryCtaKindSchema>;

export const DesignBriefSchema = z.object({
  business_name: z.string().min(1),
  vertical: z.string().min(1),
  tone_descriptors: z
    .array(z.string().min(1))
    .min(DESIGN_BRIEF_LIMITS.toneMin)
    .max(DESIGN_BRIEF_LIMITS.toneMax),
  services: z
    .array(z.string().min(1))
    .min(DESIGN_BRIEF_LIMITS.servicesMin)
    .max(DESIGN_BRIEF_LIMITS.servicesMax),
  review_quotes: z.array(ReviewQuoteSchema).max(DESIGN_BRIEF_LIMITS.quotesMax),
  /** Worker photo-route URLs (/api/places/photo/:ref), never raw Places URIs. */
  photo_urls: z.array(z.string().min(1)).max(DESIGN_BRIEF_LIMITS.photosMax),
  hours: z.array(BriefHoursSchema).nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  primary_cta: z.object({
    label: z.string().min(1),
    kind: PrimaryCtaKindSchema,
    href: z.string().min(1),
  }),
  current_site_problem: z.string().min(1),
  generated_at: z.string(),
  source: z.object({
    audit_id: z.string(),
    haiku_model: z.string().optional(),
    template_fallback: z.boolean(),
  }),
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;
