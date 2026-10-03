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
  /**
   * Raw Place Details record when getDetails fetched it (RFL-06) — persisted
   * verbatim to businesses.places_details. Absent on Nearby Search records.
   */
  details?: PlaceDetails | null;
}

/**
 * Raw Places (New) place resource as returned for DETAILS_FIELD_MASK, plus
 * fetchedAt. Stored as-is (jsonb) so the Design Brief (brick 7) can read
 * hours, photos and review text without another Places call.
 */
export interface PlaceDetails {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
  types?: string[];
  priceLevel?: string;
  editorialSummary?: { text?: string; languageCode?: string };
  regularOpeningHours?: {
    openNow?: boolean;
    periods?: Array<{
      open?: { day?: number; hour?: number; minute?: number };
      close?: { day?: number; hour?: number; minute?: number };
    }>;
    weekdayDescriptions?: string[];
  };
  /** `name` is the photo resource ("places/{id}/photos/{ref}") for /media. */
  photos?: Array<{
    name?: string;
    widthPx?: number;
    heightPx?: number;
    authorAttributions?: Array<{ displayName?: string; uri?: string }>;
  }>;
  reviews?: Array<{
    name?: string;
    rating?: number;
    text?: { text?: string; languageCode?: string };
    originalText?: { text?: string; languageCode?: string };
    relativePublishTimeDescription?: string;
    publishTime?: string;
    authorAttribution?: { displayName?: string; uri?: string };
  }>;
  /** ISO timestamp the worker fetched this record. */
  fetchedAt: string;
}

/** Bytes of one Places photo (GET /api/places/photo/:ref proxies these). */
export interface PlacePhoto {
  bytes: Uint8Array;
  contentType: string;
}

/** Photo resource names look like places/{placeId}/photos/{ref}. */
export const PLACE_PHOTO_NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

/** Largest width the proxy will request (keeps egress and SKU cost sane). */
export const PLACE_PHOTO_MAX_WIDTH_PX = 1600;

export interface NearbySearchParams {
  center: LatLng;
  radiusMeters: number;
  /** Places (New) included type, e.g. 'plumber'. */
  categoryType: string;
}

/** Fired once per upstream API call so Scout can log usage_events. */
export type PlacesEndpoint = "geocode" | "nearby" | "details" | "photo";

export type PlacesCallListener = (info: {
  endpoint: PlacesEndpoint;
  costCents: number;
}) => void;

export interface PlacesClient {
  readonly mode: "google" | "fixture";
  /** Resolve a US zip to a search center; null when the zip is unknown. */
  geocodeZip(zip: string): Promise<LatLng | null>;
  /** One Nearby Search (New) call — capped at 20 results by the API. */
  nearbySearch(params: NearbySearchParams): Promise<PlaceRecord[]>;
  /**
   * Place Details enrichment; null when the place id is unknown. The
   * returned record carries the raw `details` (RFL-06 field mask: hours,
   * photos, reviews, editorialSummary, types, priceLevel).
   */
  getDetails(placeId: string): Promise<PlaceRecord | null>;
  /**
   * One Places photo's bytes at ≤ maxWidthPx (server key stays inside the
   * client — never in a URL). Null when the ref is unknown/invalid.
   */
  fetchPhoto(photoName: string, maxWidthPx: number): Promise<PlacePhoto | null>;
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
  /**
   * Place Details with the RFL-06 mask (hours/photos = Enterprise,
   * reviews/editorialSummary = Enterprise + Atmosphere) — ~$0.035/call.
   */
  details: 4,
  /** Place Photo media — $0.007/call. */
  photo: 1,
} as const;
