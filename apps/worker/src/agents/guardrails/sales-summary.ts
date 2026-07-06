/**
 * Sales Summary guardrails — PRD 6.13 self-checks (CLAUDE.md 6.2). Reject: a
 * non-specific earned_observation; a talk track over 150 words; any banned
 * buzzword anywhere; fewer than 2 objections.
 */
import type { GuardrailResult } from "../../lib/ai";
import { countWords } from "./analyst";
import {
  BANNED_WORDS,
  type SalesSummaryOutput,
} from "../prompts/sales-summary";

const MAX_TALK_TRACK_WORDS = 150;
const MIN_OBJECTIONS = 2;

/**
 * A specific observation carries a concrete measured anchor — a digit or a
 * measurement/platform term — not a vague "your site could be better".
 */
const SPECIFIC_HINTS = [
  "mobile",
  "load",
  "speed",
  "second",
  "score",
  "rating",
  "review",
  "title",
  "meta",
  "http",
  "ssl",
  "copyright",
  "phone",
  "call",
  "form",
  "booking",
  "wix",
  "squarespace",
  "godaddy",
  "weebly",
  "design",
  "modern",
  "/100",
  "/5",
];

export function isSpecificObservation(text: string): boolean {
  const lower = text.toLowerCase();
  return /\d/.test(lower) || SPECIFIC_HINTS.some((h) => lower.includes(h));
}

export function bannedWordsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_WORDS.filter((w) => lower.includes(w));
}

export function salesSummaryGuardrail(
  value: SalesSummaryOutput,
): GuardrailResult {
  if (!isSpecificObservation(value.earned_observation)) {
    return {
      passed: false,
      notes: "earned_observation is not specific (no measured detail cited).",
    };
  }

  const words = countWords(value.full_talk_track);
  if (words > MAX_TALK_TRACK_WORDS) {
    return {
      passed: false,
      notes: `full_talk_track is ${words} words; max ${MAX_TALK_TRACK_WORDS}.`,
    };
  }

  // Banned words anywhere in the spoken output.
  const haystack = [
    value.opener,
    value.earned_observation,
    value.pain_hypothesis,
    value.offer,
    value.soft_close,
    value.full_talk_track,
    ...value.anticipated_objections.flatMap((o) => [o.objection, o.response]),
  ].join(" ");
  const banned = bannedWordsIn(haystack);
  if (banned.length > 0) {
    return {
      passed: false,
      notes: `Uses banned word(s): ${banned.join(", ")}.`,
    };
  }

  if (value.anticipated_objections.length < MIN_OBJECTIONS) {
    return {
      passed: false,
      notes: `Only ${value.anticipated_objections.length} objection(s); need ${MIN_OBJECTIONS}.`,
    };
  }

  return { passed: true, notes: null };
}
