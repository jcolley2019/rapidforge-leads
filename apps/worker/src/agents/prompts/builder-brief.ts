/**
 * Builder Brief prompt + contract — PRD 6.12 (Fable 5, MARKDOWN output).
 *
 * The one agent whose output is paste-ready markdown, not strict JSON
 * (CLAUDE.md 6.1). A developer (or Claude Code) can paste the brief and
 * scaffold a modern site that addresses every measured gap. On-demand only.
 */
import type { AuditFacts } from "../money-facts";
import { factsToPromptJson } from "../money-facts";
import type { CascadingVars } from "./config-vars";

/** Required H2 sections, in order (PRD 6.12). The guardrail checks each. */
export const BRIEF_SECTIONS = [
  "Project overview",
  "Business details",
  "Target audience",
  "Pages to build",
  "Design direction",
  "SEO requirements",
  "AEO requirements",
  "Conversion requirements",
  "Performance requirements",
  "Content to migrate",
  "Assets",
  "Deploy instructions",
] as const;

/** A fresh local competitor (pulled at brief time from the same search). */
export interface CompetitorSummary {
  name: string;
  google_rating: number | null;
  review_count: number | null;
  website_url: string | null;
}

/** Best-effort city from a Places address ("St, City, ST zip"). */
export function parseCity(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim());
  if (parts.length >= 3) return parts[parts.length - 2] || null;
  if (parts.length === 2) return parts[0] || null;
  return null;
}

/** Target keywords for the rebuild — {city} + {category} (PRD 6.10/6.12). */
export function deriveKeywords(facts: AuditFacts): string[] {
  const category = facts.business.category ?? "local service";
  const city = parseCity(facts.business.address);
  const kws = [
    city ? `${category} ${city}` : `${category} near me`,
    city ? `best ${category} in ${city}` : `best local ${category}`,
    city ? `${city} ${category} company` : `${category} company`,
    `${category} near me`,
  ];
  return [...new Set(kws)];
}

export const BUILDER_BRIEF_SYSTEM = `You are a senior web strategist writing a build brief that a developer (or Claude Code) will paste in and use to scaffold a brand-new website for a local business.

Output PASTE-READY MARKDOWN ONLY — no JSON, no code fences around the whole reply, no preamble. Write for a builder: concrete, specific, ready to act on. Use the MEASURED audit data — never invent metrics.

Client stack: Vite + React + Tailwind + shadcn/ui (a fast static marketing site).

You MUST output ALL TWELVE of the H2 sections below, verbatim and in this exact order. Never merge, rename, skip, reorder, or combine them — every one must appear under its own \`## \` header with real content (no placeholders, no "[INSERT ...]", no "{business_name}" tokens, no lorem ipsum). Even a short section must still appear under its header. The twelve headers are:

## Project overview
## Business details
## Target audience
## Pages to build
(list each page with an H1, its sections, and its primary CTA)
## Design direction
(palette, typography, vibe, 2-3 reference sites)
## SEO requirements
(per-page title/meta, LocalBusiness + Service + FAQPage schema, canonicals, alt text, internal linking)
## AEO requirements
(FAQ as direct Q-and-A pairs, entity definitions, structured data for AI citations)
## Conversion requirements
(sticky click-to-call header, booking embed, <=3-field form, trust bar, review carousel)
## Performance requirements
(Lighthouse mobile > 90, LCP < 2.5s, CLS < 0.1, WebP, lazy loading)
## Content to migrate
(what to keep from the current site, with rewrite notes)
## Assets
(hero image prompt, icons)
## Deploy instructions

Before you finish, re-read your output and confirm all twelve \`## \` headers above are present, in order — if any is missing, add it. Keep the whole brief under 2000 words: be concise within each section rather than dropping any section.`;

export function buildBuilderBriefPrompt(
  facts: AuditFacts,
  vars: CascadingVars,
  competitors: CompetitorSummary[],
  keywords: string[],
  siteHtmlExcerpt: string | null,
): string {
  const competitorLines =
    competitors.length > 0
      ? competitors
          .map(
            (c) =>
              `- ${c.name} — ${c.google_rating ?? "?"}★, ${c.review_count ?? 0} reviews${c.website_url ? `, ${c.website_url}` : ", no website"}`,
          )
          .join("\n")
      : "- (no fresh competitors available)";

  return [
    `Business: ${facts.business.name}`,
    `Industry: ${facts.business.category ?? vars.target_industry}`,
    `Location: ${facts.business.address ?? vars.user_location}`,
    `Your offer to them: ${vars.your_offer}`,
    `Ideal website traits: ${vars.ideal_website_traits}`,
    `Target keywords: ${keywords.join(", ")}`,
    "",
    "Top local competitors (pulled fresh):",
    competitorLines,
    "",
    "Existing homepage content excerpt (may be empty):",
    siteHtmlExcerpt ? siteHtmlExcerpt.slice(0, 1500) : "(none captured)",
    "",
    "Measured audit data (JSON):",
    factsToPromptJson(facts),
  ].join("\n");
}
