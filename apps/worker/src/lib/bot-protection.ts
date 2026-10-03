/**
 * Bot-protection detection (audit finding 4) — the ONE place that decides
 * whether a response is a WAF block / challenge rather than the real site.
 *
 * Blocked is neither dead nor alive: the site exists, we just could not see
 * it. Probe and the orchestrator's homepage guard both call
 * detectBotProtection(); a hit means "unknown" — no page analysis, no
 * dead-site badge, one low "could not be audited" issue.
 *
 * Signatures are deliberately specific to block/challenge pages. Cloudflare
 * also injects /cdn-cgi/challenge-platform/ scripts into NORMAL pages (bot
 * management JS detections), so that path alone is never a signature.
 */

/** 401/403/429/503 = access refused or throttled, not a broken site. */
export const BLOCKED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429, 503]);

/** How much of the body detection looks at — challenge markers sit up top. */
export const BOT_CHECK_BODY_BYTES = 64_000;

export interface BotCheckInput {
  status: number;
  /** Lowercased header names → values. */
  headers: Record<string, string>;
  /** Response body (or its first BOT_CHECK_BODY_BYTES). */
  body: string;
}

export interface BotSignature {
  id: string;
  vendor: string;
  matches(input: BotCheckInput): boolean;
}

const hasTitle = (body: string, title: RegExp): boolean => {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  return m !== null && title.test(m[1] ?? "");
};

export const BOT_CHALLENGE_SIGNATURES: readonly BotSignature[] = [
  {
    id: "cloudflare-just-a-moment",
    vendor: "Cloudflare",
    matches: ({ body }) => hasTitle(body, /^\s*Just a moment\.{0,3}\s*$/i),
  },
  {
    id: "cloudflare-attention-required",
    vendor: "Cloudflare",
    matches: ({ body }) =>
      /Attention Required!\s*\|\s*Cloudflare/i.test(body),
  },
  {
    id: "cloudflare-challenge-header",
    vendor: "Cloudflare",
    matches: ({ headers }) =>
      Boolean(headers["cf-mitigated"]) ||
      Object.keys(headers).some((h) => h.startsWith("cf-chl")),
  },
  {
    id: "cloudflare-challenge-script",
    vendor: "Cloudflare",
    // Only present on interstitial challenge pages (not on JS-detection pages).
    matches: ({ body }) => /window\._cf_chl_opt|\bcf-chl-widget/i.test(body),
  },
  {
    id: "akamai-access-denied",
    vendor: "Akamai",
    // Akamai reference pages entity-encode the "Reference #18.xxxx" line.
    matches: ({ body }) =>
      hasTitle(body, /^\s*Access Denied\s*$/i) &&
      (/Reference(?:\s|&#32;)*(?:#|&#35;)\s*\d/i.test(body) ||
        /errors\.edgesuite\.net/i.test(body) ||
        /You don't have permission to access/i.test(body)),
  },
  {
    id: "imperva-incapsula",
    vendor: "Imperva",
    matches: ({ body }) =>
      /Incapsula incident ID|_Incapsula_Resource|Request unsuccessful\. Incapsula/i.test(
        body,
      ),
  },
  {
    id: "perimeterx-press-hold",
    vendor: "PerimeterX",
    matches: ({ body }) =>
      /Press\s*(?:&amp;|&)\s*Hold/i.test(body) &&
      /px-captcha|perimeterx|_pxAppId|captcha\.px-cdn/i.test(body),
  },
];

export interface BotDetection {
  /** Signature id, or `http-<status>` for a status-only block. */
  reason: string;
  vendor: string | null;
  /** Human-readable note for the issue detail / audit row. */
  note: string;
}

/**
 * Null = not blocked (the response is the real site — healthy or broken).
 * A signature beats a bare status, so a Cloudflare 403 names Cloudflare.
 */
export function detectBotProtection(input: BotCheckInput): BotDetection | null {
  const scoped = {
    ...input,
    body: input.body.slice(0, BOT_CHECK_BODY_BYTES),
  };
  for (const sig of BOT_CHALLENGE_SIGNATURES) {
    if (sig.matches(scoped)) {
      return {
        reason: sig.id,
        vendor: sig.vendor,
        note: `${sig.vendor} bot protection (HTTP ${input.status})`,
      };
    }
  }
  if (BLOCKED_STATUSES.has(input.status)) {
    return {
      reason: `http-${input.status}`,
      vendor: null,
      note: `HTTP ${input.status} — the site refused or throttled automated access`,
    };
  }
  return null;
}

/** Fetch Headers → the lowercased record detectBotProtection takes. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
