/**
 * Platform detection + freshness extraction — deterministic HTML/header/URL
 * fingerprinting for the Health agent (PRD 6.3). No LLM involvement:
 * a platform is a measurable fact (CLAUDE.md 4.2).
 *
 * Detected keys feed PLATFORM_SCORES in packages/shared/scoring.ts
 * (wix/godaddy = 20 · squarespace = 45 · wordpress = 65 · webflow/custom
 * = 85). Unrecognized stacks are 'custom' — never invented.
 */

export type PlatformKey =
  | "wix"
  | "godaddy"
  | "squarespace"
  | "wordpress"
  | "webflow"
  | "custom";

export interface PlatformEvidence {
  url: string;
  html: string;
  /** Lowercased header map (server, x-powered-by, …). */
  headers: Record<string, string>;
}

interface Fingerprint {
  platform: Exclude<PlatformKey, "custom">;
  /** Hostname substrings — the strongest signal (builder subdomains). */
  hosts: string[];
  /** Case-insensitive HTML substrings. */
  html: string[];
  /** Case-insensitive substring match against server/x-powered-by/x-* headers. */
  headers: string[];
}

/** Ordered — first match wins. Builder platforms before generic CMS. */
const FINGERPRINTS: readonly Fingerprint[] = [
  {
    platform: "wix",
    hosts: ["wixsite.com", "wixstudio.io"],
    html: ["wixstatic.com", "wix.com", "parastorage.com", "x-wix-"],
    headers: ["x-wix-request-id", "wix"],
  },
  {
    platform: "godaddy",
    hosts: ["godaddysites.com"],
    html: ["img.wsimg.com", "website builder by godaddy", "godaddy.com/websites"],
    headers: ["dps/"],
  },
  {
    platform: "squarespace",
    hosts: ["squarespace.com"],
    html: ["static1.squarespace.com", "this is squarespace", "squarespace.com"],
    headers: ["squarespace"],
  },
  {
    platform: "webflow",
    hosts: ["webflow.io"],
    html: ["website-files.com", "data-wf-domain", "data-wf-page", "generator\" content=\"webflow"],
    headers: ["webflow"],
  },
  {
    platform: "wordpress",
    hosts: ["wordpress.com"],
    html: ["/wp-content/", "/wp-includes/", "generator\" content=\"wordpress"],
    headers: ["wordpress", "wp engine"],
  },
];

/** Deterministic platform detection by URL, HTML, and header fingerprints. */
export function detectPlatform(evidence: PlatformEvidence): PlatformKey {
  let host = "";
  try {
    host = new URL(evidence.url).hostname.toLowerCase();
  } catch {
    // keep host empty — HTML/header fingerprints still apply
  }
  const html = evidence.html.toLowerCase();
  const headerBlob = Object.entries(evidence.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
    .toLowerCase();

  for (const fp of FINGERPRINTS) {
    if (fp.hosts.some((h) => host.endsWith(h) || host.includes(`.${h}`))) {
      return fp.platform;
    }
  }
  for (const fp of FINGERPRINTS) {
    if (fp.html.some((needle) => html.includes(needle))) return fp.platform;
    if (fp.headers.some((needle) => headerBlob.includes(needle))) {
      return fp.platform;
    }
  }
  return "custom";
}

/**
 * Copyright year extraction (PRD 6.3). Matches "© 2024", "&copy; 2019",
 * "Copyright 2020–2024", "(c) 2018" … and returns the LATEST plausible
 * year found (ranges credit the end year). Null = not found — unknown,
 * never invented (CLAUDE.md 6.3).
 */
export function extractCopyrightYear(
  html: string,
  currentYear: number,
): number | null {
  const pattern =
    /(?:©|&copy;|&#169;|\(c\)|copyright)[\s:]*(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi;
  let latest: number | null = null;
  for (const match of html.matchAll(pattern)) {
    const year = Number(match[1]);
    if (year < 1990 || year > currentYear + 1) continue; // implausible
    if (latest === null || year > latest) latest = year;
  }
  return latest;
}

/** Freshness signal: Last-Modified header within the past ~year. */
export const LAST_MODIFIED_RECENT_DAYS = 365;

export function hasRecentLastModified(
  headers: Record<string, string>,
  now: Date,
): boolean {
  const raw = headers["last-modified"];
  if (!raw) return false;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return false;
  const ageDays = (now.getTime() - parsed) / 86_400_000;
  return ageDays >= 0 && ageDays <= LAST_MODIFIED_RECENT_DAYS;
}
