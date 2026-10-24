/**
 * Builder Brief guardrails — PRD 6.12 (CLAUDE.md 6.2). Reject: any leftover
 * placeholder token; a missing required section; a brief over 2000 words.
 */
import type { GuardrailResult } from "../../lib/ai";
import { countWords } from "./analyst";
import { BRIEF_SECTIONS } from "../prompts/builder-brief";
import { placeholdersIn } from "./text";

const MAX_WORDS = 2000;

/** The H2 headings actually present ("## Title" lines), lowercased/trimmed. */
export function h2Headings(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) =>
    m[1]!.replace(/[*_`]/g, "").trim().toLowerCase(),
  );
}

/**
 * A section counts only as its own H2 line (audit finding 10: a sentence
 * containing "assets" used to satisfy the "Assets" section).
 */
export function missingSections(markdown: string): string[] {
  const headings = h2Headings(markdown);
  return BRIEF_SECTIONS.filter(
    (section) =>
      !headings.some(
        (h) => h === section.toLowerCase() || h.startsWith(`${section.toLowerCase()} `),
      ),
  );
}

export function builderBriefGuardrail(markdown: string): GuardrailResult {
  const missing = missingSections(markdown);
  if (missing.length > 0) {
    return {
      passed: false,
      notes: `Missing section(s): ${missing.join(", ")}.`,
    };
  }

  const placeholders = placeholdersIn(markdown);
  if (placeholders.length > 0) {
    return {
      passed: false,
      notes: `Contains placeholder(s): ${placeholders.join(", ")}.`,
    };
  }

  const words = countWords(markdown);
  if (words > MAX_WORDS) {
    return { passed: false, notes: `Brief is ${words} words; max ${MAX_WORDS}.` };
  }

  return { passed: true, notes: null };
}
