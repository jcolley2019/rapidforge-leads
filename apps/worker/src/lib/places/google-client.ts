/**
 * GooglePlacesClient — real Places API (New) implementation (PRD 6.1).
 * Selected automatically when GOOGLE_PLACES_API_KEY is set.
 *
 * Endpoints:
 *   - places:searchText   → zip geocoding (one call per search)
 *   - places:searchNearby → business discovery (≤20 results per call;
 *                           Scout grid-tiles + dedupes above that)
 *   - places/{id}         → Place Details enrichment
 *
 * Every call notifies onCall listeners so Scout logs a usage_events row
 * per Places call (CLAUDE.md Section 8).
 */
import type { LatLng } from "../geo";
import {
  PLACES_COST_CENTS,
  type NearbySearchParams,
  type PlaceRecord,
  type PlacesCallListener,
  type PlacesClient,
} from "./types";

const BASE = "https://places.googleapis.com/v1";

/** Pro-tier fields Scout needs — one FieldMask for nearby, one for details. */
const NEARBY_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.primaryType",
].join(",");

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "rating",
  "userRatingCount",
  "businessStatus",
  "nationalPhoneNumber",
  "websiteUri",
  "primaryType",
].join(",");

/** Raw Places (New) place resource — only the fields we request. */
interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
}

function toPlaceRecord(p: GooglePlace): PlaceRecord | null {
  if (!p.id || !p.displayName?.text) return null;
  return {
    placeId: p.id,
    name: p.displayName.text,
    lat: p.location?.latitude ?? 0,
    lng: p.location?.longitude ?? 0,
    address: p.formattedAddress ?? null,
    phone: p.nationalPhoneNumber ?? null,
    websiteUrl: p.websiteUri ?? null,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? null,
    primaryType: p.primaryType ?? null,
  };
}

export class GooglePlacesClient implements PlacesClient {
  readonly mode = "google" as const;
  private listeners: PlacesCallListener[] = [];

  constructor(private readonly apiKey: string) {}

  onCall(listener: PlacesCallListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(endpoint: "geocode" | "nearby" | "details"): void {
    for (const l of this.listeners)
      l({ endpoint, costCents: PLACES_COST_CENTS[endpoint] });
  }

  private headers(fieldMask: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": this.apiKey,
      "X-Goog-FieldMask": fieldMask,
    };
  }

  async geocodeZip(zip: string): Promise<LatLng | null> {
    this.emit("geocode");
    const res = await fetch(`${BASE}/places:searchText`, {
      method: "POST",
      headers: this.headers("places.location"),
      body: JSON.stringify({ textQuery: `${zip} USA`, maxResultCount: 1 }),
    });
    if (!res.ok) {
      throw new Error(`Places searchText ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { places?: GooglePlace[] };
    const loc = data.places?.[0]?.location;
    if (loc?.latitude === undefined || loc.longitude === undefined) return null;
    return { lat: loc.latitude, lng: loc.longitude };
  }

  async nearbySearch(params: NearbySearchParams): Promise<PlaceRecord[]> {
    this.emit("nearby");
    const res = await fetch(`${BASE}/places:searchNearby`, {
      method: "POST",
      headers: this.headers(NEARBY_FIELD_MASK),
      body: JSON.stringify({
        includedTypes: [params.categoryType],
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: {
              latitude: params.center.lat,
              longitude: params.center.lng,
            },
            // API max is 50,000 m
            radius: Math.min(params.radiusMeters, 50_000),
          },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Places searchNearby ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { places?: GooglePlace[] };
    return (data.places ?? [])
      .map(toPlaceRecord)
      .filter((p): p is PlaceRecord => p !== null);
  }

  async getDetails(placeId: string): Promise<PlaceRecord | null> {
    this.emit("details");
    const res = await fetch(`${BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: this.headers(DETAILS_FIELD_MASK),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Place Details ${res.status}: ${await res.text()}`);
    }
    return toPlaceRecord((await res.json()) as GooglePlace);
  }
}
