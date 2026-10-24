/**
 * Shared text checks for the Analyst and Builder Brief guardrails — kept in a
 * leaf module so neither guardrail imports the other for it (RFL.AI.10.1).
 */

/**
 * Placeholder tokens a finished brief must not contain: bracket fills like
 * [INSERT NAME] / [YOUR ...], curly tokens like {business_name}, and lorem
 * ipsum. Ordinary markdown links ([text](url)) and task boxes ([ ]) do not
 * match, since the bracket patterns require a placeholder keyword inside.
 */
export const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[\s*(insert|your|todo|tbd|business[_ ]?name|company[_ ]?name|city|name|xxx)[^\]]*\]/i,
  /\{\{?\s*[a-z0-9_]+\s*\}?\}/i,
  /lorem ipsum/i,
];

export function placeholdersIn(markdown: string): string[] {
  const hits: string[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = markdown.match(pattern);
    if (match) hits.push(match[0]);
  }
  return hits;
}
