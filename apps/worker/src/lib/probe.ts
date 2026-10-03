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
 *
 * Three outcomes (audit finding 4): "yes" (real site answered), "no"
 * (genuine 500/502/504 or connection failure → dead-site route), and
 * "unknown" (401/403/429/503 or a bot-challenge page → blocked, never
 * audited, never "Site broken — urgent"). The probe GETs and reads the first
 * BOT_CHECK_BODY_BYTES so a 200 challenge page is caught too.
 */
import {
  BOT_CHECK_BODY_BYTES,
  detectBotProtection,
  headersToRecord,
} from "./bot-protection";
import { siteRequestHeaders } from "./browser-headers";
import { forceFixtures } from "./env";
import { DEAD_FIXTURE_HOSTS } from "./places/fixtures";

export type ProbeAlive = "yes" | "no" | "unknown";

export interface ProbeResult {
  alive: ProbeAlive;
  /** HTTP status when a response arrived; null on network failure. */
  httpStatus: number | null;
  responseMs: number | null;
  /** True when the URL is https and the TLS handshake succeeded. */
  sslValid: boolean;
  /** Human-readable failure / block note for the issues list. */
  note: string | null;
  /** detectBotProtection reason when alive is "unknown", else null. */
  blockedBy: string | null;
}

export interface WebProbe {
  readonly mode: "real" | "fixture";
  probe(url: string): Promise<ProbeResult>;
}

export const PROBE_TIMEOUT_MS = 10_000;

export class RealWebProbe implements WebProbe {
  readonly mode = "real" as const;
  private readonly fetchImpl: typeof fetch;

  /** fetch is injectable for tests only. */
  constructor(options: { fetch?: typeof fetch } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async probe(url: string): Promise<ProbeResult> {
    const started = Date.now();
    const isHttps = url.startsWith("https://");
    try {
      // GET, not HEAD: challenge pages are only recognisable by their body.
      const res = await this.fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: siteRequestHeaders(),
      });
      const body = await readBodyPrefix(res, BOT_CHECK_BODY_BYTES);
      const responseMs = Date.now() - started;
      const blocked = detectBotProtection({
        status: res.status,
        headers: headersToRecord(res.headers),
        body,
      });
      if (blocked) {
        return {
          alive: "unknown",
          httpStatus: res.status,
          responseMs,
          sslValid: isHttps,
          note: blocked.note,
          blockedBy: blocked.reason,
        };
      }
      const alive = res.status < 500;
      return {
        alive: alive ? "yes" : "no",
        httpStatus: res.status,
        responseMs,
        sslValid: isHttps,
        note: alive ? null : `Server error ${res.status}`,
        blockedBy: null,
      };
    } catch (err) {
      return {
        alive: "no",
        httpStatus: null,
        responseMs: Date.now() - started,
        sslValid: false,
        note: `Unreachable: ${err instanceof Error ? err.message : String(err)}`,
        blockedBy: null,
      };
    }
  }
}

/**
 * Read at most maxBytes of the body as text, then release the stream. A
 * body that errors or stalls mid-read keeps what arrived — the status line
 * already proved the server answered, so this never turns a site "dead".
 */
async function readBodyPrefix(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // keep the partial body
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, maxBytes);
}

export class FixtureWebProbe implements WebProbe {
  readonly mode = "fixture" as const;

  async probe(url: string): Promise<ProbeResult> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return {
        alive: "no",
        httpStatus: null,
        responseMs: 0,
        sslValid: false,
        note: "Invalid URL",
        blockedBy: null,
      };
    }
    if (DEAD_FIXTURE_HOSTS.has(host)) {
      return {
        alive: "no",
        httpStatus: null,
        responseMs: 10_000,
        sslValid: false,
        note: "Unreachable: connection timed out (fixture)",
        blockedBy: null,
      };
    }
    return {
      alive: "yes",
      httpStatus: 200,
      responseMs: 320,
      sslValid: url.startsWith("https://"),
      note: null,
      blockedBy: null,
    };
  }
}

/** Paired with the Places mode — see module docblock. */
export function createWebProbe(): WebProbe {
  if (forceFixtures()) {
    console.log("[probe] mode: fixture (RAPIDFORGE_FORCE_FIXTURES)");
    return new FixtureWebProbe();
  }
  if (process.env.GOOGLE_PLACES_API_KEY) {
    return new RealWebProbe();
  }
  console.log("[probe] mode: fixture — liveness answered from fixture data");
  return new FixtureWebProbe();
}
