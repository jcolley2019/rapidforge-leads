/**
 * SiteFetcher — the swappable homepage-HTML seam (Sprint 3).
 *
 * Health/Conversion/Presence all read the SAME fetched homepage, so the
 * orchestrator fetches once per business and hands the result to each
 * agent (deterministic before AI — the HTML is the shared fact base).
 *
 * Pairing rule (same as WebProbe): fixture Places URLs are fake, so the
 * fixture fetcher is selected whenever GOOGLE_PLACES_API_KEY is absent.
 * With real Places data the real fetcher does an actual GET.
 */
import { fallbackSiteFixture, SITE_FIXTURES } from "./site-fixtures";

export interface FetchedSite {
  html: string;
  httpStatus: number;
  responseMs: number;
  /** URL after redirects — https here means HTTPS is enforced end-to-end. */
  finalUrl: string;
  /** True when the final connection was https and the handshake succeeded. */
  sslValid: boolean;
  /** Lowercased header names → values (server, last-modified, …). */
  headers: Record<string, string>;
}

export interface SiteFetcher {
  readonly mode: "real" | "fixture";
  /** Fetch the homepage. Null = request failed (agents treat as unknown). */
  fetchHomepage(url: string): Promise<FetchedSite | null>;
}

export const SITE_FETCH_TIMEOUT_MS = 15_000;

/** Cap stored HTML — parsing only needs the document, not megabytes. */
export const MAX_HTML_BYTES = 500_000;

export class RealSiteFetcher implements SiteFetcher {
  readonly mode = "real" as const;

  async fetchHomepage(url: string): Promise<FetchedSite | null> {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(SITE_FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "RapidForge-Audit/1.0" },
      });
      const responseMs = Date.now() - started;
      const html = (await res.text()).slice(0, MAX_HTML_BYTES);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        html,
        httpStatus: res.status,
        responseMs,
        finalUrl: res.url || url,
        sslValid: (res.url || url).startsWith("https://"),
        headers,
      };
    } catch (err) {
      console.warn(
        `[site] fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

export class FixtureSiteFetcher implements SiteFetcher {
  readonly mode = "fixture" as const;

  async fetchHomepage(url: string): Promise<FetchedSite | null> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const fixture =
      SITE_FIXTURES[host] ??
      SITE_FIXTURES[host.replace(/^www\./, "")] ??
      fallbackSiteFixture(host);
    return {
      html: fixture.html,
      httpStatus: fixture.httpStatus,
      responseMs: fixture.responseMs,
      finalUrl: url,
      sslValid: url.startsWith("https://"),
      headers: fixture.headers,
    };
  }
}

/** Paired with the Places mode — see module docblock. */
export function createSiteFetcher(): SiteFetcher {
  if (process.env.GOOGLE_PLACES_API_KEY) {
    return new RealSiteFetcher();
  }
  console.log(
    "[site] mode: fixture — homepage HTML served from fixture documents",
  );
  return new FixtureSiteFetcher();
}
