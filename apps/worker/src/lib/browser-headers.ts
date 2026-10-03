/**
 * Request headers for every site-facing fetch (probe + homepage + path
 * checks). A bot-looking UA gets challenged by many WAFs (audit finding 4),
 * so we present as current desktop Chrome on Windows.
 *
 * RAPIDFORGE_LEGACY_UA=true restores the old self-identifying UA — for
 * debugging how a site treats an honest crawler, never for normal runs.
 */

/** Chrome stable on Windows (reduced UA form: major.0.0.0). Bump yearly. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

export const LEGACY_AUDIT_USER_AGENT = "RapidForge-Audit/1.0";

export function siteRequestHeaders(): Record<string, string> {
  const userAgent =
    process.env.RAPIDFORGE_LEGACY_UA === "true"
      ? LEGACY_AUDIT_USER_AGENT
      : BROWSER_USER_AGENT;
  return {
    "User-Agent": userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
}
