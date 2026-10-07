/**
 * PsiClient — the swappable PageSpeed Insights seam (PRD 6.3 / 3.5).
 *
 * Two implementations (same pattern as PlacesClient/WebProbe):
 *   - RealPsiClient:    Google PSI API, selected when PAGESPEED_API_KEY is
 *                       set (free tier, 25k/day — PRD 3.5)
 *   - FixturePsiClient: realistic per-host Lighthouse data for the 25
 *                       fixture businesses, selected when the key is absent
 *
 * The Health agent consumes mobile + desktop runs; the Traffic agent reads
 * CrUX presence from the SAME response (PRD 6.6 — no extra call). Callers
 * log a `usage_events` 'pagespeed_call' row per run.
 */
import { forceFixtures } from "./env";
import { fallbackPsiProfile, PSI_FIXTURES } from "./psi-fixtures";

export type PsiStrategy = "mobile" | "desktop";

/** Extracted Lighthouse categories + Core Web Vitals + CrUX presence. */
export interface PsiMetrics {
  /** Category scores 0–100; null when Lighthouse omitted the category. */
  performance: number | null;
  accessibility: number | null;
  seo: number | null;
  bestPractices: number | null;
  /** Largest Contentful Paint, ms. */
  lcpMs: number | null;
  /** Cumulative Layout Shift. */
  cls: number | null;
  /** Total Blocking Time, ms. */
  tbtMs: number | null;
  /** CrUX field data present = real users are hitting the site (PRD 6.6). */
  hasCruxData: boolean;
}

export interface PsiClient {
  readonly mode: "real" | "fixture";
  /** One PSI run for one strategy. Null = PSI errored/unavailable. */
  run(url: string, strategy: PsiStrategy): Promise<PsiMetrics | null>;
}

/** PSI can take a while on slow sites — generous timeout. */
export const PSI_TIMEOUT_MS = 60_000;
/** RFL.FIX.3i: one retry on 429/5xx after this backoff (mirrors Places). */
export const PSI_RETRY_BACKOFF_MS = 2_000;

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Test seams — production uses global fetch and a real sleep. */
export interface RealPsiClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class RealPsiClient implements PsiClient {
  readonly mode = "real" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly apiKey: string,
    options: RealPsiClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(url: string, strategy: PsiStrategy): Promise<PsiMetrics | null> {
    const qs = new URLSearchParams({ url, strategy, key: this.apiKey });
    for (const category of [
      "PERFORMANCE",
      "ACCESSIBILITY",
      "SEO",
      "BEST_PRACTICES",
    ]) {
      qs.append("category", category);
    }
    try {
      // A 429/5xx is retried once after a 2s backoff (google-client.ts
      // pattern); a second failure, any other status or a timeout → null.
      for (let attempt = 1; ; attempt += 1) {
        const res = await this.fetchImpl(`${PSI_ENDPOINT}?${qs.toString()}`, {
          signal: AbortSignal.timeout(PSI_TIMEOUT_MS),
        });
        if (res.ok) {
          return extractPsiMetrics((await res.json()) as PsiApiResponse);
        }
        if (isRetryableStatus(res.status) && attempt === 1) {
          await res.body?.cancel().catch(() => undefined);
          console.warn(
            `[psi] ${strategy} run for ${url} → HTTP ${res.status} — retrying once in ${PSI_RETRY_BACKOFF_MS}ms`,
          );
          await this.sleep(PSI_RETRY_BACKOFF_MS);
          continue;
        }
        const retried = attempt > 1 ? " (after 1 retry)" : "";
        console.warn(
          `[psi] ${strategy} run for ${url} → HTTP ${res.status}${retried}`,
        );
        return null;
      }
    } catch (err) {
      console.warn(
        `[psi] ${strategy} run for ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

/** The slice of the PSI response we read (v5 runPagespeed). */
interface PsiApiResponse {
  lighthouseResult?: {
    categories?: Record<string, { score?: number | null }>;
    audits?: Record<string, { numericValue?: number }>;
  };
  loadingExperience?: {
    metrics?: Record<string, unknown>;
  };
}

/** Pure extraction — exported for unit tests. */
export function extractPsiMetrics(response: PsiApiResponse): PsiMetrics {
  const categories = response.lighthouseResult?.categories ?? {};
  const audits = response.lighthouseResult?.audits ?? {};
  const score = (key: string): number | null => {
    const raw = categories[key]?.score;
    return typeof raw === "number" ? Math.round(raw * 100) : null;
  };
  const audit = (key: string): number | null => {
    const raw = audits[key]?.numericValue;
    return typeof raw === "number" ? raw : null;
  };
  const cruxMetrics = response.loadingExperience?.metrics ?? {};
  const lcp = audit("largest-contentful-paint");
  const tbt = audit("total-blocking-time");
  return {
    performance: score("performance"),
    accessibility: score("accessibility"),
    seo: score("seo"),
    bestPractices: score("best-practices"),
    lcpMs: lcp === null ? null : Math.round(lcp),
    cls: audit("cumulative-layout-shift"),
    tbtMs: tbt === null ? null : Math.round(tbt),
    hasCruxData: Object.keys(cruxMetrics).length > 0,
  };
}

export class FixturePsiClient implements PsiClient {
  readonly mode = "fixture" as const;

  async run(url: string, strategy: PsiStrategy): Promise<PsiMetrics | null> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const profile =
      PSI_FIXTURES[host] ??
      PSI_FIXTURES[host.replace(/^www\./, "")] ??
      fallbackPsiProfile(host);
    return profile[strategy];
  }
}

/** Env-selected, logged at startup like every other seam. */
export function createPsiClient(): PsiClient {
  const key = process.env.PAGESPEED_API_KEY;
  if (forceFixtures()) {
    console.log("[psi] mode: fixture (RAPIDFORGE_FORCE_FIXTURES)");
    return new FixturePsiClient();
  }
  if (key) {
    console.log("[psi] mode: real (PAGESPEED_API_KEY present)");
    return new RealPsiClient(key);
  }
  console.log(
    "[psi] mode: fixture — PAGESPEED_API_KEY absent; serving fixture Lighthouse data",
  );
  return new FixturePsiClient();
}
