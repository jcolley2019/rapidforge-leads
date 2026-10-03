/**
 * Scout — PRD 6.1 (v1, deterministic, no LLM).
 *
 * Places Nearby Search (New) with type filter; grid-tiles areas larger
 * than one search's coverage and dedupes by place_id; Place Details
 * enrichment for records missing website/phone; is_chain heuristic
 * (lib/chains: brand list + URL shape + multi-location, with chain_reason);
 * website_kind
 * classification; upserts `businesses` on (workspace_id, google_place_id)
 * + `search_results`; logs a usage_events row per Places call.
 */
import {
  type AgentResult,
  type ChainReason,
  type Search,
  type WebsiteKind,
} from "@rapidforge/shared";
import {
  MULTI_LOCATION_CHAIN_THRESHOLD,
  detectChain,
  isKnownChainName,
  normalizeBusinessName,
} from "../lib/chains";
import { haversineMeters, METERS_PER_MILE, planTiles } from "../lib/geo";
import { parseSearchParams } from "../lib/search-params";
import type { PlaceDetails, PlaceRecord, PlacesClient } from "../lib/places";
import type { DataStore } from "../store";

/** Hard cap per search — Founder plan max_results_per_search (PRD 5.1). */
export const MAX_RESULTS_PER_SEARCH = 100;

export { MULTI_LOCATION_CHAIN_THRESHOLD } from "../lib/chains";

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
// is_chain heuristic (PRD 6.1) — brand list + URL shape live in lib/chains;
// re-exported so existing imports keep working.
// ---------------------------------------------------------------------------

export { isKnownChainName, normalizeBusinessName };

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
    const params = parseSearchParams(search);

    // map_draw carries its own pin; zip_radius geocodes (PRD 6.1 / Sprint 5).
    const center =
      params.mode === "map_draw"
        ? { lat: params.lat, lng: params.lng }
        : await places.geocodeZip(params.zip);
    if (!center) {
      return fail(
        params.mode === "zip_radius"
          ? `Could not geocode zip ${params.zip}`
          : "map_draw search missing center",
        startedAt,
      );
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
              details: details.details ?? null,
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
        ...chainFields(record, multiLocation.has(record.placeId)),
        website_kind: classifyWebsiteKind(record.websiteUrl),
        // Only when this pass fetched details (website/phone were missing);
        // otherwise leave whatever Filter persisted earlier untouched.
        ...(record.details ? { places_details: toJson(record.details) } : {}),
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

/** Raw details → plain jsonb object for the store. */
function toJson(details: PlaceDetails): Record<string, unknown> {
  return details as unknown as Record<string, unknown>;
}

/** is_chain + chain_reason for the upsert (brand → URL → multi-location). */
function chainFields(
  record: PlaceRecord,
  multiLocationInSearch: boolean,
): { is_chain: boolean; chain_reason: ChainReason | null } {
  const detection = detectChain(record.name, record.websiteUrl, multiLocationInSearch);
  return { is_chain: detection.isChain, chain_reason: detection.reason };
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
