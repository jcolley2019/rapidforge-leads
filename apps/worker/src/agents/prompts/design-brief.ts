/**
 * Design Brief judgment prompt — the ONE model call in the agent (Haiku 4.5,
 * strict JSON): tone descriptors + services list from the homepage excerpt,
 * review text and category. Everything else in the brief is deterministic
 * (CLAUDE.md 4.2 / 6.3): the model never sees or sets scores, hours, photos,
 * phone, address or the CTA.
 */
import { z } from "zod";
import { DESIGN_BRIEF_LIMITS } from "@rapidforge/shared";

export const DesignBriefJudgmentSchema = z.object({
  tone_descriptors: z
    .array(z.string().min(1).max(40))
    .min(DESIGN_BRIEF_LIMITS.toneMin)
    .max(DESIGN_BRIEF_LIMITS.toneMax),
  services: z
    .array(z.string().min(1).max(80))
    .min(DESIGN_BRIEF_LIMITS.servicesMin)
    .max(DESIGN_BRIEF_LIMITS.servicesMax),
});
export type DesignBriefJudgment = z.infer<typeof DesignBriefJudgmentSchema>;

export const DESIGN_BRIEF_JUDGMENT_SYSTEM = `You are a brand strategist preparing inputs for a website generator that will build a new site for a local business. You receive the business category, a plain-text excerpt of its current homepage, its page headings, and verbatim customer review text.

Reply with STRICT JSON only — one object, no prose, no markdown fences:
{ "tone_descriptors": [3 to 5 short adjectives or two-word phrases describing the brand voice the new site should carry, e.g. "warm", "no-nonsense", "family-run", "premium"],
  "services": [1 to 12 concrete services this business sells, each 2–6 words, as a customer would search for them] }

Rules: ground every service in the excerpt, headings or reviews — never invent a service the material does not support; if the material is thin, list fewer services rather than guessing. Tone must fit the category and the evidence. No duplicates. No scores, no claims about quality, no marketing copy.`;

export interface DesignBriefJudgmentInput {
  category: string;
  homepage_excerpt: string | null;
  headings: string[];
  review_texts: string[];
}

export function buildDesignBriefJudgmentPrompt(input: DesignBriefJudgmentInput): string {
  return JSON.stringify(input, null, 2);
}
