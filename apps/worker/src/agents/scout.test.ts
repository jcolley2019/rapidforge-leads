import { describe, expect, it } from "vitest";
import { FixturePlacesClient } from "../lib/places/fixture-client";
import { FIXTURE_BUSINESSES } from "../lib/places/fixtures";
import type { PlaceRecord } from "../lib/places/types";
import { MemoryStore } from "../store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "../store/types";
import {
  classifyWebsiteKind,
  isKnownChainName,
  multiLocationPlaceIds,
  normalizeBusinessName,
  runScout,
} from "./scout";

// ---------------------------------------------------------------------------
// website_kind classification (PRD 6.1)
// ---------------------------------------------------------------------------

describe("classifyWebsiteKind", () => {
  it("classifies missing URLs as none", () => {
    expect(classifyWebsiteKind(null)).toBe("none");
    expect(classifyWebsiteKind("")).toBe("none");
    expect(classifyWebsiteKind("   ")).toBe("none");
  });

  it("classifies social/aggregator hosts as social_only", () => {
    expect(classifyWebsiteKind("https://www.facebook.com/somebiz")).toBe("social_only");
    expect(classifyWebsiteKind("https://m.facebook.com/somebiz")).toBe("social_only");
    expect(classifyWebsiteKind("https://fb.com/somebiz")).toBe("social_only");
    expect(classifyWebsiteKind("https://www.instagram.com/somebiz")).toBe("social_only");
    expect(classifyWebsiteKind("https://www.yelp.com/biz/somebiz")).toBe("social_only");
    expect(classifyWebsiteKind("https://linktr.ee/somebiz")).toBe("social_only");
    expect(classifyWebsiteKind("https://x.com/somebiz")).toBe("social_only");
  });

  it("classifies everything else as real", () => {
    expect(classifyWebsiteKind("https://snakeriverplumbing.com")).toBe("real");
    expect(classifyWebsiteKind("https://biz.wixsite.com/home")).toBe("real");
    // 'facebook.com.evil.example' must NOT match the suffix rule
    expect(classifyWebsiteKind("https://facebook.com.evil.example")).toBe("real");
  });

  it("classifies unparseable URLs as unknown", () => {
    expect(classifyWebsiteKind("not a url")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// is_chain heuristic (PRD 6.1)
// ---------------------------------------------------------------------------

describe("isKnownChainName", () => {
  it("matches brand-list names through punctuation", () => {
    expect(isKnownChainName("Roto-Rooter Plumbing & Water Cleanup")).toBe(true);
    expect(isKnownChainName("Mr. Rooter Plumbing of Boise")).toBe(true);
    expect(isKnownChainName("SERVPRO of Nampa")).toBe(true);
  });

  it("does not match independents or lookalike substrings", () => {
    expect(isKnownChainName("Snake River Plumbing Co")).toBe(false);
    // 'subway' is a brand; 'submarine' must not trip it
    expect(isKnownChainName("Joe's Submarine Sandwiches")).toBe(false);
  });
});

describe("multiLocationPlaceIds", () => {
  const record = (placeId: string, name: string): PlaceRecord => ({
    placeId,
    name,
    lat: 0,
    lng: 0,
    address: null,
    phone: null,
    websiteUrl: null,
    rating: null,
    reviewCount: null,
    businessStatus: "OPERATIONAL",
    primaryType: null,
  });

  it("flags a name appearing at 3+ locations", () => {
    const chains = multiLocationPlaceIds([
      record("a", "Boise Plumbing Co"),
      record("b", "Boise Plumbing Co"),
      record("c", "boise plumbing co."),
      record("d", "Snake River Plumbing Co"),
    ]);
    expect(chains).toEqual(new Set(["a", "b", "c"]));
  });

  it("does not flag a name appearing only twice", () => {
    const chains = multiLocationPlaceIds([
      record("a", "Twin Falls Plumbing"),
      record("b", "Twin Falls Plumbing"),
    ]);
    expect(chains.size).toBe(0);
  });
});

describe("normalizeBusinessName", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeBusinessName("  Boise   Plumbing Co. ")).toBe("boise plumbing co");
    expect(normalizeBusinessName("Roto-Rooter!")).toBe("roto rooter");
  });
});

// ---------------------------------------------------------------------------
// Full scout run against fixtures + MemoryStore
// ---------------------------------------------------------------------------

describe("runScout (fixture mode, end-to-end)", () => {
  async function scoutedSearch(radiusMiles: number) {
    const store = new MemoryStore();
    const places = new FixturePlacesClient();
    const search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: {
        zip: "83686",
        radius_miles: radiusMiles,
        min_reviews: 0,
        min_rating: 0,
        exclude_chains: false,
      },
      category: "plumber",
    });
    const result = await runScout({ store, places, search, jobId: null });
    return { store, search, result };
  }

  it("finds all 25 fixtures at 10 miles, deduped across tiles", async () => {
    const { store, search, result } = await scoutedSearch(10);

    expect(result.status).toBe("completed");
    expect(result.output?.count).toBe(FIXTURE_BUSINESSES.length);
    // 10 miles > 5 km → multiple tiles; overlaps exercised dedupe
    expect(result.output?.tiles).toBeGreaterThan(1);

    const ids = result.output?.business_ids ?? [];
    expect(new Set(ids).size).toBe(FIXTURE_BUSINESSES.length);

    const detail = await store.getSearchDetail(search.id);
    expect(detail?.leads).toHaveLength(FIXTURE_BUSINESSES.length);
    expect(detail?.search.results_count).toBe(FIXTURE_BUSINESSES.length);
  });

  it("classifies website kinds per the fixture edge cases", async () => {
    const { store, search } = await scoutedSearch(10);
    const detail = await store.getSearchDetail(search.id);
    const kinds = new Map<string, number>();
    for (const lead of detail?.leads ?? []) {
      const kind = lead.business.website_kind ?? "unknown";
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    expect(kinds.get("none")).toBe(5);
    expect(kinds.get("social_only")).toBe(4);
    expect(kinds.get("real")).toBe(16);
  });

  it("marks brand-list and multi-location chains", async () => {
    const { store, search } = await scoutedSearch(10);
    const detail = await store.getSearchDetail(search.id);
    const chains = (detail?.leads ?? [])
      .filter((l) => l.business.is_chain)
      .map((l) => l.business.name)
      .sort();
    expect(chains).toEqual([
      "Boise Plumbing Co",
      "Boise Plumbing Co",
      "Boise Plumbing Co",
      "Roto-Rooter Plumbing & Water Cleanup",
    ]);
  });

  it("logs a usage_events row per Places call (geocode + tiles + details)", async () => {
    const { store, result } = await scoutedSearch(10);
    const events = (store as MemoryStore).listUsageEvents();
    expect(events.length).toBe(result.output?.places_calls);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((e) => e.event_type === "places_call")).toBe(true);
    const endpoints = new Set(events.map((e) => e.metadata?.endpoint));
    expect(endpoints.has("geocode")).toBe(true);
    expect(endpoints.has("nearby")).toBe(true);
    expect(endpoints.has("details")).toBe(true);
  });

  it("radius-filters: a 5-mile search excludes outlying fixtures", async () => {
    const { result } = await scoutedSearch(5);
    expect(result.status).toBe("completed");
    expect(result.output?.count).toBeGreaterThan(5);
    expect(result.output?.count).toBeLessThan(FIXTURE_BUSINESSES.length);
  });
});
