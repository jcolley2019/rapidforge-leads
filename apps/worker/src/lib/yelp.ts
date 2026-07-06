/**
 * Yelp Fusion seam — STUB, clearly marked v1.5 (PRD 6.9, Sprint 6 decision:
 * Reputation is GOOGLE-FIRST in v1). The seam exists so the Reputation
 * agent's cross-reference/divergence path is wired and testable; the stub
 * returns no data regardless of key presence. The real Fusion client (and
 * BBB/Facebook cross-reference) lands in v1.5.
 */

export interface YelpSignals {
  rating: number | null;
  review_count: number | null;
}

export interface YelpClient {
  readonly mode: "stub";
  /** Null = no Yelp data available (always, in v1). */
  fetchBusinessSignals(
    name: string,
    address: string | null,
  ): Promise<YelpSignals | null>;
}

export class StubYelpClient implements YelpClient {
  readonly mode = "stub" as const;

  async fetchBusinessSignals(): Promise<YelpSignals | null> {
    return null;
  }
}

let cached: YelpClient | null = null;

export function getYelpClient(): YelpClient {
  if (cached === null) {
    if (process.env.YELP_API_KEY) {
      console.log(
        "[yelp] YELP_API_KEY present but the Fusion integration is v1.5 — stub returns no data (Reputation is Google-first in v1)",
      );
    } else {
      console.log("[yelp] mode: stub (Fusion integration is v1.5)");
    }
    cached = new StubYelpClient();
  }
  return cached;
}
