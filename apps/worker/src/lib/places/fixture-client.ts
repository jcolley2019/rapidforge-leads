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
import { FIXTURE_BUSINESSES, FIXTURE_CENTER } from "./fixtures";
import type {
  NearbySearchParams,
  PlaceRecord,
  PlacesCallListener,
  PlacesClient,
} from "./types";

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

  private emit(endpoint: "geocode" | "nearby" | "details"): void {
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

  async getDetails(placeId: string): Promise<PlaceRecord | null> {
    this.emit("details");
    return FIXTURE_BUSINESSES.find((b) => b.placeId === placeId) ?? null;
  }
}
