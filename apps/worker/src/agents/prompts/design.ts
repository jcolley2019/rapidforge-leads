/**
 * Design agent prompt contract (PRD 6.8, Sonnet vision). The model receives
 * BOTH homepage screenshots (desktop 1440px + mobile 390px) as image parts
 * and interprets what it sees — the modernity number it returns is a
 * measurement input that replaces the stub 50 in the Health design weight;
 * Health/star/Sellability math stays deterministic in shared/scoring.ts.
 */
import { z } from "zod";

export const DESIGN_CRITIQUE_SYSTEM = `You are a senior visual designer evaluating small business websites. You are given two homepage screenshots: desktop (1440px wide) then mobile (390px wide). Evaluate typography, color, imagery, layout, mobile experience, and overall modern feel. Be SPECIFIC — "Looks unprofessional" is unacceptable; "hero uses Comic Sans in #FF00FF on a clipart background" is acceptable. Every note and every piece of evidence must reference actual visible elements from the screenshots. Honest, not cruel. Strict JSON only: reply with a single JSON object and nothing else.`;

export const DESIGN_DIMENSIONS = [
  "typography",
  "color",
  "imagery",
  "layout",
  "mobile",
] as const;
export type DesignDimension = (typeof DESIGN_DIMENSIONS)[number];

const DimensionCritiqueSchema = z.object({
  score_0_100: z.number().int().min(0).max(100),
  /** Specific, visual, ≥15 words (guardrail-enforced). */
  notes: z.string(),
});
export type DimensionCritique = z.infer<typeof DimensionCritiqueSchema>;

export const DesignCritiqueSchema = z.object({
  modernity_0_100: z.number().int().min(0).max(100),
  dimensions: z.object({
    typography: DimensionCritiqueSchema,
    color: DimensionCritiqueSchema,
    imagery: DimensionCritiqueSchema,
    layout: DimensionCritiqueSchema,
    mobile: DimensionCritiqueSchema,
  }),
  /** "This site looks like it was built in …". */
  feels_like_year: z.number().int().min(1995).max(2035),
  reasoning: z.string(),
  critical_issues: z.array(
    z.object({
      issue: z.string(),
      /** Specific visual evidence ("the hero photo is stretched to 140%…"). */
      evidence: z.string(),
    }),
  ),
});
export type DesignCritique = z.infer<typeof DesignCritiqueSchema>;

export function buildDesignPrompt(url: string): string {
  return `Website: ${url}
Image 1 is the desktop screenshot (1440px). Image 2 is the mobile screenshot (390px).

Return: { "modernity_0_100": int,
  "dimensions": { "typography"|"color"|"imagery"|"layout"|"mobile":
    {"score_0_100": int, "notes": string (specific, >=15 words, cite visible elements)} },
  "feels_like_year": int,
  "reasoning": string,
  "critical_issues": [{"issue": string, "evidence": string (specific visual evidence)}] }

Rules: if modernity_0_100 is below 70, critical_issues must name at least one
concrete problem. feels_like_year must be consistent with the modernity score.`;
}
