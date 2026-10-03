/**
 * FixturePlacesClient — dev/offline PlacesClient (Sprint 2 modified
 * constraint). Selected automatically when GOOGLE_PLACES_API_KEY is absent.
 *
 * Behaviors mirror the real API where it matters to Scout:
 *   - nearbySearch caps at 20 results per call (forces grid tiling +
 *     dedupe to actually do work)
 *   - radius filtering is real haversine math
 *   - every call notifies onCall listeners so usage_events logging is
 *     exercised end-to-end (cost 0 — no real spend)
 *
 * Divergence (logged): the category filter is ignored so any category
 * demoes against the full 25-business dataset.
 */
import { haversineMeters } from "../geo";
import type { LatLng } from "../geo";
import { FIXTURE_BUSINESSES, FIXTURE_CENTER, FIXTURE_DETAILS } from "./fixtures";
import {
  PLACE_PHOTO_NAME_RE,
  type NearbySearchParams,
  type PlaceDetails,
  type PlacePhoto,
  type PlaceRecord,
  type PlacesCallListener,
  type PlacesClient,
  type PlacesEndpoint,
} from "./types";

/** 1×1 transparent PNG — what the fixture photo proxy serves. */
export const FIXTURE_PHOTO_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
);

/** Nearby Search (New) hard response cap, mirrored here. */
export const NEARBY_RESULT_CAP = 20;

export class FixturePlacesClient implements PlacesClient {
  readonly mode = "fixture" as const;
  private listeners: PlacesCallListener[] = [];
  private warnedCategory = false;

  onCall(listener: PlacesCallListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(endpoint: PlacesEndpoint): void {
    for (const l of this.listeners) l({ endpoint, costCents: 0 });
  }

  async geocodeZip(zip: string): Promise<LatLng | null> {
    this.emit("geocode");
    console.log(
      `[places] fixture mode: zip ${zip} → Treasure Valley fixture center`,
    );
    return FIXTURE_CENTER;
  }

  async nearbySearch(params: NearbySearchParams): Promise<PlaceRecord[]> {
    this.emit("nearby");
    if (!this.warnedCategory) {
      this.warnedCategory = true;
      console.log(
        `[places] fixture mode: category '${params.categoryType}' ignored — returning fixture dataset regardless`,
      );
    }
    return FIXTURE_BUSINESSES.filter(
      (b) =>
        haversineMeters(params.center, { lat: b.lat, lng: b.lng }) <=
        params.radiusMeters,
    )
      .sort(
        (a, b) =>
          haversineMeters(params.center, { lat: a.lat, lng: a.lng }) -
          haversineMeters(params.center, { lat: b.lat, lng: b.lng }),
      )
      .slice(0, NEARBY_RESULT_CAP);
  }

  /**
   * Mirrors the real client: the record carries a raw `details` object —
   * the curated FIXTURE_DETAILS entry when one exists, else a minimal
   * record synthesized from the fixture fields (so places_details is never
   * left null after a fetch, exactly like production).
   */
  async getDetails(placeId: string): Promise<PlaceRecord | null> {
    this.emit("details");
    const record = FIXTURE_BUSINESSES.find((b) => b.placeId === placeId);
    if (!record) return null;
    const curated = FIXTURE_DETAILS[placeId];
    const details: PlaceDetails = {
      id: record.placeId,
      displayName: { text: record.name },
      formattedAddress: record.address ?? undefined,
      location: { latitude: record.lat, longitude: record.lng },
      rating: record.rating ?? undefined,
      userRatingCount: record.reviewCount ?? undefined,
      businessStatus: record.businessStatus ?? undefined,
      nationalPhoneNumber: record.phone ?? undefined,
      websiteUri: record.websiteUrl ?? undefined,
      primaryType: record.primaryType ?? undefined,
      ...curated,
      fetchedAt: "2026-07-06T07:00:00.000Z",
    };
    return { ...record, details };
  }

  async fetchPhoto(photoName: string, _maxWidthPx: number): Promise<PlacePhoto | null> {
    if (!PLACE_PHOTO_NAME_RE.test(photoName)) return null;
    this.emit("photo");
    return { bytes: FIXTURE_PHOTO_PNG, contentType: "image/png" };
  }
}
