/**
 * Scout — PRD 6.1 (v1, deterministic, no LLM).
 *
 * Places Nearby Search (New) with type filter; grid-tiles areas larger
 * than one search's coverage and dedupes by place_id; Place Details
 * enrichment for records missing website/phone; is_chain heuristic
 * (brand-name list + multi-location detection); website_kind
 * classification; upserts `businesses` on (workspace_id, google_place_id)
 * + `search_results`; logs a usage_events row per Places call.
 */
import {
  ZipRadiusParamsSchema,
  type AgentResult,
  type Search,
  type WebsiteKind,
} from "@rapidforge/shared";
import { haversineMeters, METERS_PER_MILE, planTiles } from "../lib/geo";
import type { PlaceRecord, PlacesClient } from "../lib/places";
import type { DataStore } from "../store";

/** Hard cap per search — Founder plan max_results_per_search (PRD 5.1). */
export const MAX_RESULTS_PER_SEARCH = 100;

/** Same normalized name at ≥ this many locations in one search → chain. */
export const MULTI_LOCATION_CHAIN_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Website classification (PRD 6.1) — deterministic, exported for tests
// ---------------------------------------------------------------------------

/** Hosts that count as a social/aggregator presence, not a real website. */
const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "yelp.com",
  "linktr.ee",
  "linktree.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
] as const;

export function classifyWebsiteKind(websiteUrl: string | null): WebsiteKind {
  if (!websiteUrl || websiteUrl.trim() === "") return "none";
  let host: string;
  try {
    host = new URL(websiteUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  for (const social of SOCIAL_HOSTS) {
    if (host === social || host.endsWith(`.${social}`)) return "social_only";
  }
  return "real";
}

// ---------------------------------------------------------------------------
// is_chain heuristic (PRD 6.1) — brand list + multi-location detection
// ---------------------------------------------------------------------------

/** National/franchise brands that never buy a local website rebuild. */
const KNOWN_CHAIN_BRANDS = [
  "roto rooter",
  "mr rooter",
  "benjamin franklin plumbing",
  "one hour heating",
  "aire serv",
  "servpro",
  "servicemaster",
  "stanley steemer",
  "terminix",
  "orkin",
  "trugreen",
  "chem dry",
  "molly maid",
  "merry maids",
  "jiffy lube",
  "midas",
  "meineke",
  "aamco",
  "firestone",
  "les schwab",
  "great clips",
  "supercuts",
  "sport clips",
  "planet fitness",
  "anytime fitness",
  "mcdonalds",
  "starbucks",
  "subway",
  "dominos",
  "pizza hut",
  "papa johns",
  "walmart",
  "home depot",
  "lowes",
  "ace hardware",
] as const;

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isKnownChainName(name: string): boolean {
  const padded = ` ${normalizeBusinessName(name)} `;
  return KNOWN_CHAIN_BRANDS.some((brand) => padded.includes(` ${brand} `));
}

/**
 * Multi-location detection: the same normalized name appearing at
 * MULTI_LOCATION_CHAIN_THRESHOLD+ distinct places within one search
 * marks every one of them as a chain.
 */
export function multiLocationPlaceIds(records: PlaceRecord[]): Set<string> {
  const byName = new Map<string, string[]>();
  for (const record of records) {
    const key = normalizeBusinessName(record.name);
    const ids = byName.get(key) ?? [];
    ids.push(record.placeId);
    byName.set(key, ids);
  }
  const chains = new Set<string>();
  for (const ids of byName.values()) {
    if (ids.length >= MULTI_LOCATION_CHAIN_THRESHOLD) {
      for (const id of ids) chains.add(id);
    }
  }
  return chains;
}

// ---------------------------------------------------------------------------
// Scout run
// ---------------------------------------------------------------------------

export interface ScoutContext {
  store: DataStore;
  places: PlacesClient;
  search: Search;
  jobId: string | null;
}

export interface ScoutOutput extends Record<string, unknown> {
  business_ids: string[];
  count: number;
  tiles: number;
  places_calls: number;
  tiles_truncated: boolean;
}

export async function runScout(ctx: ScoutContext): Promise<AgentResult<ScoutOutput>> {
  const { store, places, search } = ctx;
  const startedAt = Date.now();
  let placesCalls = 0;

  // One usage_events row per Places call (PRD 6.1 / CLAUDE.md Section 8).
  const unsubscribe = places.onCall(({ endpoint, costCents }) => {
    placesCalls += 1;
    void store
      .logUsageEvent({
        workspace_id: search.workspace_id,
        event_type: "places_call",
        cost_cents: costCents,
        metadata: { endpoint, mode: places.mode, search_id: search.id },
      })
      .catch((err) =>
        console.error(`[scout] usage_events log failed: ${String(err)}`),
      );
  });

  try {
    const params = ZipRadiusParamsSchema.parse(search.params);

    const center = await places.geocodeZip(params.zip);
    if (!center) {
      return fail(`Could not geocode zip ${params.zip}`, startedAt);
    }

    const radiusMeters = params.radius_miles * METERS_PER_MILE;
    const { tiles, truncated } = planTiles(center, radiusMeters);
    if (truncated) {
      console.warn(
        `[scout] tile cap truncated coverage for search ${search.id} — widest ring dropped`,
      );
    }

    // Sequential tile fetch (rate-limit friendly), dedupe by place_id.
    const deduped = new Map<string, PlaceRecord>();
    for (const tile of tiles) {
      const records = await places.nearbySearch({
        center: { lat: tile.lat, lng: tile.lng },
        radiusMeters: tile.radiusMeters,
        categoryType: search.category,
      });
      for (const record of records) {
        if (!deduped.has(record.placeId)) deduped.set(record.placeId, record);
      }
    }

    // Tiles overhang the requested circle — keep only true in-radius hits,
    // nearest first, capped by plan.
    const inRadius = [...deduped.values()]
      .filter(
        (r) => haversineMeters(center, { lat: r.lat, lng: r.lng }) <= radiusMeters,
      )
      .sort(
        (a, b) =>
          haversineMeters(center, { lat: a.lat, lng: a.lng }) -
          haversineMeters(center, { lat: b.lat, lng: b.lng }),
      )
      .slice(0, MAX_RESULTS_PER_SEARCH);

    // Place Details enrichment for records missing website or phone.
    const enriched: PlaceRecord[] = [];
    for (const record of inRadius) {
      if (record.websiteUrl !== null && record.phone !== null) {
        enriched.push(record);
        continue;
      }
      const details = await places.getDetails(record.placeId);
      enriched.push(
        details
          ? {
              ...record,
              websiteUrl: record.websiteUrl ?? details.websiteUrl,
              phone: record.phone ?? details.phone,
              rating: record.rating ?? details.rating,
              reviewCount: record.reviewCount ?? details.reviewCount,
              businessStatus: record.businessStatus ?? details.businessStatus,
            }
          : record,
      );
    }

    const multiLocation = multiLocationPlaceIds(enriched);

    const businessIds: string[] = [];
    for (const record of enriched) {
      const business = await store.upsertBusiness({
        workspace_id: search.workspace_id,
        google_place_id: record.placeId,
        name: record.name,
        phone: record.phone,
        website_url: record.websiteUrl,
        address: record.address,
        lat: record.lat,
        lng: record.lng,
        google_rating: record.rating,
        review_count: record.reviewCount,
        category: record.primaryType ?? search.category,
        business_status: record.businessStatus,
        is_chain:
          isKnownChainName(record.name) || multiLocation.has(record.placeId),
        website_kind: classifyWebsiteKind(record.websiteUrl),
      });
      await store.ensureSearchResult(search.workspace_id, search.id, business.id);
      businessIds.push(business.id);
    }

    await store.updateSearch(search.id, { results_count: businessIds.length });

    return {
      agent: "scout",
      status: "completed",
      output: {
        business_ids: businessIds,
        count: businessIds.length,
        tiles: tiles.length,
        places_calls: placesCalls,
        tiles_truncated: truncated,
      },
      error: null,
      modelUsed: null, // deterministic — no LLM, ever
      tokensUsed: 0,
      costCents: 0,
      durationMs: Date.now() - startedAt,
      guardrailPassed: true,
      guardrailNotes: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), startedAt);
  } finally {
    unsubscribe();
  }
}

function fail(error: string, startedAt: number): AgentResult<ScoutOutput> {
  return {
    agent: "scout",
    status: "failed",
    output: null,
    error,
    modelUsed: null,
    tokensUsed: 0,
    costCents: 0,
    durationMs: Date.now() - startedAt,
    guardrailPassed: true,
    guardrailNotes: null,
  };
}
