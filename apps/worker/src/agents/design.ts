/**
 * Design — PRD 6.8 (v1.5, Sonnet 4.6 VISION).
 *
 * Live path: both homepage screenshots (desktop 1440px + mobile 390px) go
 * to claude-sonnet-4-6 as image parts via lib/ai.ts; the strict-JSON
 * critique is guardrailed (vague notes, year/score consistency, missing
 * critical issues) with one re-run then persist-flagged (CLAUDE.md 6.2).
 *
 * Template path (fixture mode / no key / no screenshots): a DETERMINISTIC
 * modernity heuristic over measured markup signals — builder platform,
 * copyright staleness, viewport meta, legacy table markup — with notes that
 * cite those measurements or the literal "inference" (CLAUDE.md 6.3).
 *
 * Either way the modernity number is a MEASUREMENT INPUT: it replaces the
 * stub 50 in the Health design weight; scoring math stays in
 * shared/scoring.ts (CLAUDE.md 4.2).
 */
import type { AgentResult, Business } from "@rapidforge/shared";
import {
  generateJsonSummary,
  MODEL_SONNET,
  type AiImage,
  type GuardrailResult,
  type SummaryOutcome,
} from "../lib/ai";
import {
  detectPlatform,
  extractCopyrightYear,
  hasLegacyMarkup,
  type PlatformKey,
} from "../lib/platform";
import type { ScreenshotSet } from "../lib/screenshots";
import type { FetchedSite } from "../lib/site";
import { designCritiqueGuardrail } from "./guardrails/design-critique";
import {
  buildDesignPrompt,
  DESIGN_CRITIQUE_SYSTEM,
  DesignCritiqueSchema,
  type DesignCritique,
} from "./prompts/design";

/** Output budget: five dimension notes + reasoning + issues, strict JSON. */
const DESIGN_MAX_TOKENS = 1600;
/** Sonnet 5.5 adaptive-thinking effort — visual judgment at the cheap end (audit §e). */
export const DESIGN_EFFORT = "low" as const;

export interface DesignOutput extends Record<string, unknown> {
  modernity_0_100: number;
  feels_like_year: number;
  dimensions: DesignCritique["dimensions"];
  reasoning: string;
  critical_issues: DesignCritique["critical_issues"];
  /** True when the critique came from the vision model over real images. */
  used_vision: boolean;
}

export interface DesignContext {
  /** Stage budget signal (RFL.QUEUE.8) — cancels the AI request. */
  signal?: AbortSignal;
  business: Business;
  site: FetchedSite | null;
  screenshots: ScreenshotSet | null;
  /** Injected for determinism (copyright staleness in the template path). */
  now: Date;
}

// ---------------------------------------------------------------------------
// Deterministic template heuristic
// ---------------------------------------------------------------------------

export interface TemplateDesignSignals {
  platform: PlatformKey;
  copyrightYear: number | null;
  copyrightAge: number | null;
  hasViewportMeta: boolean;
  hasLegacyMarkup: boolean;
}

export function readTemplateSignals(
  site: FetchedSite | null,
  url: string,
  now: Date,
): TemplateDesignSignals {
  if (site === null) {
    return {
      platform: "custom",
      copyrightYear: null,
      copyrightAge: null,
      hasViewportMeta: true, // unknown — never invent a problem (CLAUDE.md 6.3)
      hasLegacyMarkup: false,
    };
  }
  const currentYear = now.getFullYear();
  const copyrightYear = extractCopyrightYear(site.html, currentYear);
  return {
    platform: detectPlatform({ url, html: site.html, headers: site.headers }),
    copyrightYear,
    copyrightAge: copyrightYear === null ? null : currentYear - copyrightYear,
    hasViewportMeta: /<meta[^>]+name\s*=\s*["']viewport["']/i.test(site.html),
    hasLegacyMarkup: hasLegacyMarkup(site.html),
  };
}

// RFL.FIX.3d: hasLegacyMarkup lives in lib/platform.ts (Health and the
// Scorer read it too); re-exported so existing importers keep working.
export { hasLegacyMarkup };

const PLATFORM_DEDUCTIONS: Partial<Record<PlatformKey, number>> = {
  wix: 12,
  godaddy: 12,
  wordpress: 8,
  squarespace: 5,
};

/** Deterministic modernity (5–95): baseline 75 minus measured deductions. */
export function computeTemplateModernity(signals: TemplateDesignSignals): number {
  let score = 75;
  score -= PLATFORM_DEDUCTIONS[signals.platform] ?? 0;
  if (signals.copyrightAge !== null) {
    if (signals.copyrightAge >= 10) score -= 30;
    else if (signals.copyrightAge >= 5) score -= 18;
    else if (signals.copyrightAge >= 2) score -= 6;
  }
  if (!signals.hasViewportMeta) score -= 20;
  if (signals.hasLegacyMarkup) score -= 12;
  return Math.min(95, Math.max(5, score));
}

function feelsLikeYearFor(modernity: number, currentYear: number): number {
  if (modernity >= 70) return currentYear;
  if (modernity >= 55) return 2019;
  if (modernity >= 40) return 2015;
  if (modernity >= 25) return 2010;
  return 2006;
}

/**
 * Template notes must themselves clear the >=15-word guardrail: a fixed
 * frame around the measured facts guarantees it. The leading
 * `inference:` marker (RFL.FIX.3g) lets readers — and the drawer — tell a
 * markup-derived estimate from a real vision critique.
 */
export const TEMPLATE_NOTE_PREFIX = "inference:";
function templateNote(facts: string): string {
  return `${TEMPLATE_NOTE_PREFIX} visual inspection unavailable in template mode; estimated from measured markup signals only: ${facts} Deterministic assessment pending a real vision critique.`;
}

export function buildTemplateDesignCritique(
  signals: TemplateDesignSignals,
  now: Date,
): DesignCritique {
  const modernity = computeTemplateModernity(signals);
  const platformFact =
    signals.platform === "custom"
      ? "no site-builder fingerprints were detected in the page source."
      : `${signals.platform} builder fingerprints were detected in the page source.`;
  const copyrightFact =
    signals.copyrightYear === null
      ? "no copyright year was found in the footer."
      : `the footer copyright year is ${signals.copyrightYear}.`;
  const viewportFact = signals.hasViewportMeta
    ? "a responsive viewport meta tag is present."
    : "no responsive viewport meta tag exists in the document head.";
  const legacyFact = signals.hasLegacyMarkup
    ? "legacy pre-CSS markup (font/bgcolor/align/center attributes, table layout, or a Dreamweaver/FrontPage template) is present."
    : "no legacy table/font layout markup was detected.";

  const critical_issues: DesignCritique["critical_issues"] = [];
  if (signals.copyrightAge !== null && signals.copyrightAge >= 2) {
    critical_issues.push({
      issue: `Footer copyright year is ${signals.copyrightYear} — signals an unmaintained design`,
      evidence: `Copyright ${signals.copyrightYear} found in the footer markup (measured, not visual)`,
    });
  }
  if (!signals.hasViewportMeta) {
    critical_issues.push({
      issue: "Layout is not mobile-responsive",
      evidence: "No viewport meta tag in the document head (measured, not visual)",
    });
  }
  if (PLATFORM_DEDUCTIONS[signals.platform] !== undefined) {
    critical_issues.push({
      issue: `Stock ${signals.platform} template appearance is likely`,
      evidence: `${signals.platform} platform fingerprints in the page source (measured, not visual)`,
    });
  }
  if (signals.hasLegacyMarkup) {
    critical_issues.push({
      issue: "Page is built with legacy pre-CSS markup",
      evidence: "font/bgcolor/align/center attributes, table layout, or a Dreamweaver/FrontPage template in the page source (measured, not visual)",
    });
  }

  const dimensionScore = modernity;
  const dimension = (facts: string) => ({
    score_0_100: dimensionScore,
    notes: templateNote(facts),
  });
  return {
    modernity_0_100: modernity,
    dimensions: {
      typography: dimension(
        `${platformFact} Typeface choices could not be inspected without rendering.`,
      ),
      color: dimension(
        "color palette could not be inspected without rendering the page.",
      ),
      imagery: dimension(
        "photography and imagery could not be inspected without rendering the page.",
      ),
      layout: dimension(`${legacyFact} ${copyrightFact}`),
      mobile: dimension(viewportFact),
    },
    feels_like_year: feelsLikeYearFor(modernity, now.getFullYear()),
    reasoning: `Deterministic template critique from measured signals: ${platformFact} ${copyrightFact} ${viewportFact} ${legacyFact}`,
    critical_issues,
  };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** Template-only outcome for when there is nothing to show the model. */
function templateOutcome(
  template: () => DesignCritique,
  guardrail: (value: DesignCritique) => GuardrailResult,
): SummaryOutcome<DesignCritique> {
  const value = template();
  const verdict = guardrail(value);
  return {
    value,
    modelUsed: null,
    tokensUsed: 0,
    costMicrocents: 0,
    costCents: 0,
    guardrailPassed: verdict.passed,
    guardrailNotes: verdict.notes,
  };
}

export async function runDesign(
  ctx: DesignContext,
): Promise<AgentResult<DesignOutput>> {
  const startedAt = Date.now();
  try {
    const url = ctx.business.website_url ?? "";
    const signals = readTemplateSignals(ctx.site, url, ctx.now);
    const template = () => buildTemplateDesignCritique(signals, ctx.now);

    const images: AiImage[] | null = ctx.screenshots
      ? [
          {
            mediaType: "image/jpeg",
            dataBase64: ctx.screenshots.desktop.toString("base64"),
          },
          {
            mediaType: "image/jpeg",
            dataBase64: ctx.screenshots.mobile.toString("base64"),
          },
        ]
      : null;

    // No screenshots → nothing for the vision model to see; never send the
    // vision prompt without its images.
    const summary = images
      ? await generateJsonSummary({
          model: MODEL_SONNET,
          effort: DESIGN_EFFORT,
          system: DESIGN_CRITIQUE_SYSTEM,
          prompt: buildDesignPrompt(url),
          images,
          maxTokens: DESIGN_MAX_TOKENS,
          schema: DesignCritiqueSchema,
          guardrail: designCritiqueGuardrail,
          template,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      : templateOutcome(template, designCritiqueGuardrail);

    const critique = summary.value;
    return {
      agent: "design",
      status: "completed",
      output: {
        modernity_0_100: critique.modernity_0_100,
        feels_like_year: critique.feels_like_year,
        dimensions: critique.dimensions,
        reasoning: critique.reasoning,
        critical_issues: critique.critical_issues,
        used_vision: summary.modelUsed !== null,
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
      agent: "design",
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
