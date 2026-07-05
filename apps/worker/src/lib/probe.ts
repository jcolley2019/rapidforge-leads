/**
 * WebProbe — the Filter agent's URL liveness check (PRD 6.2: worker
 * HEAD-checks real websites; dead/parked → health 10 "Site broken —
 * urgent").
 *
 * Swappable like PlacesClient: the real probe issues HTTP requests; the
 * fixture probe answers from DEAD_FIXTURE_HOSTS so the offline dev flow
 * exercises the dead-site path deterministically. The two are paired with
 * the Places mode — fixture URLs are fake, so probing them for real would
 * mark all 25 businesses dead.
 */
import { DEAD_FIXTURE_HOSTS } from "./places/fixtures";

export interface ProbeResult {
  alive: boolean;
  /** HTTP status when a response arrived; null on network failure. */
  httpStatus: number | null;
  responseMs: number | null;
  /** True when the URL is https and the TLS handshake succeeded. */
  sslValid: boolean;
  /** Human-readable failure note for the issues list. */
  note: string | null;
}

export interface WebProbe {
  readonly mode: "real" | "fixture";
  probe(url: string): Promise<ProbeResult>;
}

export const PROBE_TIMEOUT_MS = 10_000;

export class RealWebProbe implements WebProbe {
  readonly mode = "real" as const;

  async probe(url: string): Promise<ProbeResult> {
    const started = Date.now();
    const isHttps = url.startsWith("https://");
    try {
      let res = await fetchWithTimeout(url, "HEAD");
      // Some servers reject HEAD (405/501) — retry once with GET.
      if (res.status === 405 || res.status === 501) {
        res = await fetchWithTimeout(url, "GET");
      }
      const responseMs = Date.now() - started;
      const alive = res.status < 500;
      return {
        alive,
        httpStatus: res.status,
        responseMs,
        sslValid: isHttps,
        note: alive ? null : `Server error ${res.status}`,
      };
    } catch (err) {
      return {
        alive: false,
        httpStatus: null,
        responseMs: Date.now() - started,
        sslValid: false,
        note: `Unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

async function fetchWithTimeout(url: string, method: "HEAD" | "GET") {
  return fetch(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { "User-Agent": "RapidForge-Audit/1.0" },
  });
}

export class FixtureWebProbe implements WebProbe {
  readonly mode = "fixture" as const;

  async probe(url: string): Promise<ProbeResult> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return {
        alive: false,
        httpStatus: null,
        responseMs: 0,
        sslValid: false,
        note: "Invalid URL",
      };
    }
    if (DEAD_FIXTURE_HOSTS.has(host)) {
      return {
        alive: false,
        httpStatus: null,
        responseMs: 10_000,
        sslValid: false,
        note: "Unreachable: connection timed out (fixture)",
      };
    }
    return {
      alive: true,
      httpStatus: 200,
      responseMs: 320,
      sslValid: url.startsWith("https://"),
      note: null,
    };
  }
}

/** Paired with the Places mode — see module docblock. */
export function createWebProbe(): WebProbe {
  if (process.env.GOOGLE_PLACES_API_KEY) {
    return new RealWebProbe();
  }
  console.log("[probe] mode: fixture — liveness answered from fixture data");
  return new FixtureWebProbe();
}
