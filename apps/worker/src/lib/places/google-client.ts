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
 *
 * Reliability (audit finding 12): every fetch carries a 15s
 * AbortSignal.timeout; a 429/5xx is retried once after a 2s backoff. A
 * timeout, network error, second 429/5xx, or other non-OK status throws a
 * PlacesApiError, which Scout records as the job's failure reason instead
 * of hanging the job in 'running'.
 */
import type { LatLng } from "../geo";
import {
  PLACE_PHOTO_MAX_WIDTH_PX,
  PLACE_PHOTO_NAME_RE,
  PLACES_COST_CENTS,
  type NearbySearchParams,
  type PlaceDetails,
  type PlacePhoto,
  type PlaceRecord,
  type PlacesCallListener,
  type PlacesClient,
  type PlacesEndpoint,
} from "./types";

const BASE = "https://places.googleapis.com/v1";

export const PLACES_TIMEOUT_MS = 15_000;
export const PLACES_RETRY_BACKOFF_MS = 2_000;

/** Typed Places failure — status is null for a timeout / network error. */
export class PlacesApiError extends Error {
  override readonly name = "PlacesApiError";
  constructor(
    message: string,
    readonly endpoint: PlacesEndpoint,
    readonly kind: "timeout" | "network" | "http",
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Test seams — production uses global fetch, real sleep and the 15s cap. */
export interface GooglePlacesClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

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

/**
 * Place Details mask (RFL-06): the Pro fields plus what the Design Brief
 * needs — hours, photos, reviews, editorial summary, types, price level.
 * Reviews/photos bill at the Enterprise (+ Atmosphere) SKU, so Filter only
 * fetches details for businesses that pass its gates.
 */
export const DETAILS_FIELD_MASK = [
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
  "types",
  "priceLevel",
  "editorialSummary",
  "regularOpeningHours",
  "photos",
  "reviews",
].join(",");

/** Raw Places (New) place resource — the fields we request. */
type GooglePlace = Omit<PlaceDetails, "fetchedAt">;

function toPlaceRecord(p: GooglePlace, details?: PlaceDetails): PlaceRecord | null {
  if (!p.id || !p.displayName?.text) return null;
  return {
    ...(details ? { details } : {}),
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

  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: GooglePlacesClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = options.timeoutMs ?? PLACES_TIMEOUT_MS;
  }

  onCall(listener: PlacesCallListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(endpoint: PlacesEndpoint): void {
    for (const l of this.listeners)
      l({ endpoint, costCents: PLACES_COST_CENTS[endpoint] });
  }

  /**
   * fetch with timeout + one retry on 429/5xx. Returns the response when it
   * is OK or listed in passStatuses; throws PlacesApiError otherwise.
   */
  private async request(
    endpoint: PlacesEndpoint,
    label: string,
    url: string,
    init: RequestInit,
    passStatuses: readonly number[] = [],
  ): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "TimeoutError") {
          throw new PlacesApiError(
            `${label} timed out after ${this.timeoutMs}ms`,
            endpoint,
            "timeout",
            null,
            { cause: err },
          );
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new PlacesApiError(
          `${label} network error: ${detail}`,
          endpoint,
          "network",
          null,
          { cause: err },
        );
      }
      if (res.ok || passStatuses.includes(res.status)) return res;
      if (isRetryableStatus(res.status) && attempt === 1) {
        await res.body?.cancel().catch(() => undefined);
        console.warn(
          `[places] ${label} ${res.status} — retrying once in ${PLACES_RETRY_BACKOFF_MS}ms`,
        );
        await this.sleep(PLACES_RETRY_BACKOFF_MS);
        continue;
      }
      const body = await res.text().catch(() => "");
      const retried = attempt > 1 ? " (after 1 retry)" : "";
      throw new PlacesApiError(
        `${label} ${res.status}${retried}: ${body}`,
        endpoint,
        "http",
        res.status,
      );
    }
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
    const res = await this.request(
      "geocode",
      "Places searchText",
      `${BASE}/places:searchText`,
      {
        method: "POST",
        headers: this.headers("places.location"),
        body: JSON.stringify({ textQuery: `${zip} USA`, maxResultCount: 1 }),
      },
    );
    const data = (await res.json()) as { places?: GooglePlace[] };
    const loc = data.places?.[0]?.location;
    if (loc?.latitude === undefined || loc.longitude === undefined) return null;
    return { lat: loc.latitude, lng: loc.longitude };
  }

  async nearbySearch(params: NearbySearchParams): Promise<PlaceRecord[]> {
    this.emit("nearby");
    const res = await this.request(
      "nearby",
      "Places searchNearby",
      `${BASE}/places:searchNearby`,
      {
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
      },
    );
    const data = (await res.json()) as { places?: GooglePlace[] };
    return (data.places ?? [])
      .map((p) => toPlaceRecord(p))
      .filter((p): p is PlaceRecord => p !== null);
  }

  async getDetails(placeId: string): Promise<PlaceRecord | null> {
    this.emit("details");
    const res = await this.request(
      "details",
      "Place Details",
      `${BASE}/places/${encodeURIComponent(placeId)}`,
      { headers: this.headers(DETAILS_FIELD_MASK) },
      [404],
    );
    if (res.status === 404) return null;
    const raw = (await res.json()) as GooglePlace;
    return toPlaceRecord(raw, { ...raw, fetchedAt: new Date().toISOString() });
  }

  /**
   * Two-step media fetch: /media?skipHttpRedirect=true returns the signed
   * photoUri (JSON), then the image is fetched from that URI. The API key
   * travels only in the X-Goog-Api-Key header — never in a URL, so logs
   * and error messages cannot leak it.
   */
  async fetchPhoto(photoName: string, maxWidthPx: number): Promise<PlacePhoto | null> {
    if (!PLACE_PHOTO_NAME_RE.test(photoName)) return null;
    const width = Math.min(Math.max(1, Math.floor(maxWidthPx)), PLACE_PHOTO_MAX_WIDTH_PX);
    this.emit("photo");
    const meta = await this.request(
      "photo",
      "Place Photo",
      `${BASE}/${photoName}/media?maxWidthPx=${width}&skipHttpRedirect=true`,
      { headers: { "X-Goog-Api-Key": this.apiKey } },
      [404],
    );
    if (meta.status === 404) return null;
    const { photoUri } = (await meta.json()) as { photoUri?: string };
    if (!photoUri) return null;
    const img = await this.request("photo", "Place Photo media", photoUri, {}, [404]);
    if (img.status === 404) return null;
    return {
      bytes: new Uint8Array(await img.arrayBuffer()),
      contentType: img.headers.get("content-type") ?? "image/jpeg",
    };
  }
}
