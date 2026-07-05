/**
 * PlacesClient — the swappable seam between Scout and Google Places (New).
 *
 * Two implementations (Sprint 2 modified constraint):
 *   - GooglePlacesClient: real API, selected when GOOGLE_PLACES_API_KEY is set
 *   - FixturePlacesClient: 25 realistic Treasure Valley businesses, selected
 *     automatically when the key is absent — full dev flow, zero services
 *
 * Scout only ever sees this interface; flipping to live is an env change,
 * not a code change.
 */
import type { LatLng } from "../geo";

/** Provider-agnostic business record (normalized from Places API fields). */
export interface PlaceRecord {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  phone: string | null;
  websiteUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' */
  businessStatus: string | null;
  /** Places primary type, e.g. 'plumber'. */
  primaryType: string | null;
}

export interface NearbySearchParams {
  center: LatLng;
  radiusMeters: number;
  /** Places (New) included type, e.g. 'plumber'. */
  categoryType: string;
}

/** Fired once per upstream API call so Scout can log usage_events. */
export type PlacesCallListener = (info: {
  endpoint: "geocode" | "nearby" | "details";
  costCents: number;
}) => void;

export interface PlacesClient {
  readonly mode: "google" | "fixture";
  /** Resolve a US zip to a search center; null when the zip is unknown. */
  geocodeZip(zip: string): Promise<LatLng | null>;
  /** One Nearby Search (New) call — capped at 20 results by the API. */
  nearbySearch(params: NearbySearchParams): Promise<PlaceRecord[]>;
  /** Place Details enrichment; null when the place id is unknown. */
  getDetails(placeId: string): Promise<PlaceRecord | null>;
  /**
   * Subscribe to per-call notifications (usage_events logging). Returns
   * an unsubscribe — Scout subscribes per run and MUST detach in finally,
   * since the client instance outlives individual searches.
   */
  onCall(listener: PlacesCallListener): () => void;
}

/** Google Places (New) SKU prices, integer cents (usage_events.cost_cents). */
export const PLACES_COST_CENTS = {
  /** Text Search (used to geocode a zip) — $0.032/call. */
  geocode: 3,
  /** Nearby Search Pro fields — $0.032/call. */
  nearby: 3,
  /** Place Details Pro fields — $0.017/call. */
  details: 2,
} as const;
