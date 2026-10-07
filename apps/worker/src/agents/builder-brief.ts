/**
 * Builder Brief — PRD 6.12 (v1.5, MARKDOWN). Runs on **Opus 4.8** (Sprint 8),
 * at effort "low" for cost.
 *
 * A paste-ready rebuild brief a developer (or Claude Code) can scaffold from,
 * built over the measured audit + fresh local competitors + target keywords.
 * On-demand only (PRD 3.3) via the lead drawer. A hard AI failure or a
 * twice-failed guardrail falls back to a complete deterministic template.
 */
import type { AgentResult, Audit, Business, WorkspaceConfig } from "@rapidforge/shared";
import { cityFromPlacesAddress } from "../lib/address";
import { centsFromMicrocents, generateMarkdown, MODEL_OPUS, sumMicrocents } from "../lib/ai";
import { buildDesignBrief, embedDesignBrief } from "./design-brief";
import { builderBriefGuardrail, h2Headings } from "./guardrails/builder-brief";
import { countWords } from "./guardrails/analyst";
import { buildAuditFacts, type AuditFacts } from "./money-facts";
import { resolveConfigVars, type CascadingVars } from "./prompts/config-vars";
import {
  BRIEF_SECTIONS,
  buildBuilderBriefPrompt,
  BUILDER_BRIEF_SYSTEM,
  deriveKeywords,
  type CompetitorSummary,
} from "./prompts/builder-brief";

/** Opus effort — "low" keeps cost down; the strengthened prompt carries the
 * section structure. Raise later if section completeness ever regresses. */
const BRIEF_EFFORT = "low" as const;

export interface BuilderBriefOutput extends Record<string, unknown> {
  markdown: string;
  word_count: number;
  sections: string[];
}

export interface BuilderBriefContext {
  business: Business;
  audit: Audit;
  config: WorkspaceConfig | null;
  /** Fresh local competitors (route pulls them from the same search). */
  competitors: CompetitorSummary[];
  /** Excerpt of the current homepage (route fetches it), or null. */
  siteHtmlExcerpt: string | null;
  /** Budget signal when run inside a job (RFL.QUEUE.8); absent on demand. */
  signal?: AbortSignal;
}

/** Deterministic, placeholder-free, all-sections brief (< 2000 words). */
export function buildTemplateBrief(
  facts: AuditFacts,
  vars: CascadingVars,
  competitors: CompetitorSummary[],
  keywords: string[],
  siteHtmlExcerpt: string | null,
): string {
  const b = facts.business;
  const name = b.name;
  const category = b.category ?? vars.target_industry;
  const city = cityFromPlacesAddress(b.address) ?? vars.user_location;
  const health = facts.scores.health_score ?? "an unaudited";
  const star = facts.scores.star_grade;
  const platform = facts.health.platform;
  const reviews = b.review_count ?? 0;
  const rating = b.google_rating ?? "no";
  const kw = keywords.join(", ");
  const topIssues = facts.issues
    .slice(0, 4)
    .map((i) => `- ${i.label}${i.detail ? ` — ${i.detail}` : ""}`)
    .join("\n");
  const competitorLines =
    competitors.length > 0
      ? competitors
          .map(
            (c) =>
              `- ${c.name} (${c.google_rating ?? "?"}★, ${c.review_count ?? 0} reviews)`,
          )
          .join("\n")
      : "- No direct competitors were captured in this search.";

  return `# Website rebuild brief — ${name}

## Project overview
Rebuild ${name}'s website as a fast, modern, mobile-first site for a ${category} serving ${city}. The current site scores ${health}/100${star ? ` (${star}-star)` : ""}${platform ? ` and is built on ${platform}` : ""}, which leaves calls and bookings on the table. Deliver a Vite + React + Tailwind + shadcn/ui marketing site that loads fast on phones and turns visits into phone calls and booked jobs.

## Business details
- Name: ${name}
- Industry: ${category}
- Location: ${city}
- Phone: ${b.phone ?? "collect from the owner"}
- Google reputation: ${rating}-star across ${reviews} reviews
- Current website: ${b.website_url ?? "none"}${platform ? ` (${platform})` : ""}
- Measured gaps to fix:
${topIssues || "- General modernization and mobile speed."}

## Target audience
Local ${city} residents and businesses searching on their phones for a ${category}, often with an urgent need. They decide fast on trust signals (reviews, licensing, years in business), page speed, and how easy it is to call or book in one tap.

## Pages to build
- Home — H1 "${category} in ${city} you can count on"; sections: hero with click-to-call, services overview, trust bar, reviews, service area, FAQ; primary CTA "Call now".
- Services — H1 "Our ${category} services"; one block per service with a short outcome-focused description; CTA "Request service".
- About — H1 "Why ${city} chooses ${name}"; story, licensing, guarantees; CTA "Get a quote".
- Reviews — H1 "What our customers say"; carousel of Google reviews; CTA "Call now".
- Contact / Book — H1 "Book ${name}"; a form of three fields or fewer plus a sticky click-to-call; CTA "Send request".
- Service-area landing pages — one per nearby town for local SEO; CTA "Call now".

## Design direction
Palette: clean, high-contrast, trustworthy — deep blue primary, warm accent, plenty of white space. Typography: a modern sans such as Inter for UI and headings. Vibe: fast, credible, uncluttered, local-first. Reference sites: Stripe (clarity), Linear (typography and spacing), and the strongest local competitor below.

## SEO requirements
Per-page unique titles and meta descriptions targeting ${kw}. Add LocalBusiness, Service, and FAQPage structured data. Set canonical URLs, write descriptive image alt text, and cross-link services to the service-area pages. Register a sitemap and submit it to Google Search Console.

## AEO requirements
Add an FAQ section written as direct question-and-answer pairs (hours, service area, pricing ranges, emergency availability, licensing). Define the business entity clearly (who, what, where) so AI assistants can quote it. Mirror the FAQ content in FAQPage structured data for AI citations.

## Conversion requirements
Sticky click-to-call header showing ${b.phone ?? "the business phone"} on every page. A booking embed or request form with three fields or fewer. A trust bar (years in business, license number, ${rating}-star rating). A review carousel pulling the ${reviews} Google reviews.

## Performance requirements
Lighthouse mobile above 90, Largest Contentful Paint under 2.5s, Cumulative Layout Shift under 0.1. Serve WebP images, lazy-load below-the-fold media, ship minimal JavaScript, and preconnect fonts.

## Content to migrate
${siteHtmlExcerpt ? "Keep the core service descriptions, service area, and contact details from the current site, rewritten for clarity and the target keywords." : "The current site has little usable content — write fresh, specific copy for every section."} Drop any dated year references, stock filler, and low-quality imagery.

## Assets
Hero image prompt: "a professional ${category} at work in ${city}, natural daylight, friendly and competent, high resolution". Icons: a single consistent line-icon set (lucide-react). Logo: reuse the existing mark if clean, otherwise set a wordmark in the heading typeface.

## Deploy instructions
Scaffold with Vite, build the static site, and deploy to Vercel. Point the domain, enforce HTTPS, submit the sitemap to Google Search Console, and link the site from the Google Business Profile.

## Local competitors (pulled fresh)
${competitorLines}
`;
}

export async function runBuilderBrief(
  ctx: BuilderBriefContext,
): Promise<AgentResult<BuilderBriefOutput>> {
  const startedAt = Date.now();
  try {
    const facts = buildAuditFacts(ctx.business, ctx.audit);
    const vars: CascadingVars = resolveConfigVars(ctx.config);
    const keywords = deriveKeywords(facts);

    const outcome = await generateMarkdown({
      model: MODEL_OPUS,
      effort: BRIEF_EFFORT,
      system: BUILDER_BRIEF_SYSTEM,
      prompt: buildBuilderBriefPrompt(
        facts,
        vars,
        ctx.competitors,
        keywords,
        ctx.siteHtmlExcerpt,
      ),
      maxTokens: 4000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      guardrail: builderBriefGuardrail,
      template: () =>
        buildTemplateBrief(
          facts,
          vars,
          ctx.competitors,
          keywords,
          ctx.siteHtmlExcerpt,
        ),
    });

    // RFL.BRIEF.7: the structured Design Brief rides along as a fenced JSON
    // block so the generator reads fields while the markdown stays the human
    // view. Its failure never fails the Builder Brief — the block is omitted.
    let markdown = outcome.value;
    let designBriefMicrocents: number | null = 0;
    let designBriefTokens = 0;
    let designBriefNote: string | null = null;
    try {
      const design = await buildDesignBrief({
        business: ctx.business,
        audit: ctx.audit,
        siteHtmlExcerpt: ctx.siteHtmlExcerpt,
      });
      markdown = embedDesignBrief(markdown, design.brief);
      designBriefMicrocents = design.costMicrocents;
      designBriefTokens = design.tokensUsed;
    } catch (err) {
      designBriefNote = `Design Brief JSON omitted: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[builder-brief] ${designBriefNote}`);
    }
    const headings = h2Headings(markdown);
    const sections = BRIEF_SECTIONS.filter((s) =>
      headings.some((h) => h === s.toLowerCase() || h.startsWith(`${s.toLowerCase()} `)),
    );

    const costMicrocents = sumMicrocents([outcome.costMicrocents, designBriefMicrocents]);
    return {
      agent: "builder-brief",
      status: "completed",
      output: {
        markdown,
        word_count: countWords(markdown),
        sections,
      },
      error: null,
      modelUsed: outcome.modelUsed,
      tokensUsed: outcome.tokensUsed + designBriefTokens,
      costCents: centsFromMicrocents(costMicrocents),
      costMicrocents,
      durationMs: Date.now() - startedAt,
      guardrailPassed: outcome.guardrailPassed,
      guardrailNotes:
        [outcome.guardrailNotes, designBriefNote].filter(Boolean).join(" | ") || null,
    };
  } catch (err) {
    return {
      agent: "builder-brief",
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
