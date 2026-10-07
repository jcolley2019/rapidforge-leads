/**
 * Analyst guardrails — PRD 6.11 self-checks as a pure function (CLAUDE.md
 * 6.2). Reject: fewer than 3 improvements; reasoning citing fewer than 3
 * agents by name WITH a measured value (a number in the same sentence —
 * RFL.FIX.3f); a one-line verdict over 20 words; a verdict inconsistent
 * with the deterministic star grade.
 */
import type { GuardrailResult } from "../../lib/ai";
import { CITABLE_AGENTS } from "../money-facts";
import { VERDICT_STAR_RANGE, type AnalystOutput } from "../prompts/analyst";

const MIN_IMPROVEMENTS = 3;
const MIN_AGENTS_CITED = 3;
const MAX_ONE_LINER_WORDS = 20;

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Distinct audit agents named (whole-word, case-insensitive) in the text. */
export function agentsCitedIn(text: string): string[] {
  const lower = text.toLowerCase();
  return CITABLE_AGENTS.filter((agent) =>
    new RegExp(`\\b${agent}\\b`).test(lower),
  );
}

/** Sentence split on . ! ? followed by whitespace ("4.5 stars" stays whole). */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "");
}

/**
 * Agents cited WITH a value (RFL.FIX.3f): named in a sentence that also
 * carries a number. "The health, design and seo results were reviewed."
 * names three agents and cites none. An agent named only in a number-free
 * sentence ("Conversion found no contact form.") is allowed but not counted.
 */
export function agentsCitedWithValueIn(text: string): string[] {
  const cited = new Set<string>();
  for (const sentence of sentencesOf(text)) {
    if (!/\d/.test(sentence)) continue;
    for (const agent of agentsCitedIn(sentence)) cited.add(agent);
  }
  return CITABLE_AGENTS.filter((agent) => cited.has(agent));
}

export function makeAnalystGuardrail(
  starGrade: number | null,
): (value: AnalystOutput) => GuardrailResult {
  return (value) => {
    if (value.top_3_improvements.length < MIN_IMPROVEMENTS) {
      return {
        passed: false,
        notes: `Only ${value.top_3_improvements.length} improvement(s); need ${MIN_IMPROVEMENTS}.`,
      };
    }

    const cited = agentsCitedWithValueIn(value.reasoning);
    if (cited.length < MIN_AGENTS_CITED) {
      const valueless = agentsCitedIn(value.reasoning).filter((a) => !cited.includes(a));
      return {
        passed: false,
        notes: `Reasoning cites ${cited.length} agent(s) with a measured value in the same sentence (${cited.join(", ") || "none"}); need ${MIN_AGENTS_CITED}.${valueless.length > 0 ? ` Named without a value: ${valueless.join(", ")}.` : ""}`,
      };
    }

    const words = countWords(value.one_line_verdict);
    if (words > MAX_ONE_LINER_WORDS) {
      return {
        passed: false,
        notes: `one_line_verdict is ${words} words; max ${MAX_ONE_LINER_WORDS}.`,
      };
    }

    if (starGrade !== null) {
      const [min, max] = VERDICT_STAR_RANGE[value.verdict];
      if (starGrade < min || starGrade > max) {
        return {
          passed: false,
          notes: `Verdict "${value.verdict}" is inconsistent with ${starGrade}★ (allowed ${min}–${max}).`,
        };
      }
    }

    return { passed: true, notes: null };
  };
}
