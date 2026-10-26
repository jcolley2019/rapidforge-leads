/**
 * GooglePlacesClient reliability (audit finding 12) with a mocked fetch:
 * 15s timeout → typed error, one retry after 2s on 429/5xx, typed error on
 * the second failure, and Scout records that error instead of hanging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScout } from "../../agents/scout";
import { MemoryStore } from "../../store/memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID } from "../../store/types";
import {
  circleToRectangle,
  DETAILS_FIELD_MASK,
  GooglePlacesClient,
  PLACES_RETRY_BACKOFF_MS,
  PlacesApiError,
} from "./google-client";
import { PLACES_COST_CENTS } from "./types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GEOCODE_OK = { places: [{ location: { latitude: 43.6, longitude: -116.4 } }] };

function makeClient(fetchMock: typeof fetch, timeoutMs?: number) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const client = new GooglePlacesClient("test-key", {
    fetch: fetchMock,
    sleep,
    timeoutMs,
  });
  return { client, sleep };
}

describe("GooglePlacesClient timeout + retry", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts a hung call and throws a typed timeout error (no retry)", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const { client, sleep } = makeClient(fetchMock as typeof fetch, 25);

    const err = await client.geocodeZip("83642").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlacesApiError);
    expect(err).toMatchObject({
      endpoint: "geocode",
      kind: "timeout",
      status: null,
      message: "Places searchText timed out after 25ms",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("passes an AbortSignal on every request", async () => {
    const fetchMock = vi.fn(async () => json(GEOCODE_OK));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);

    await client.geocodeZip("83642");

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once after a 2s backoff on 429, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "RESOURCE_EXHAUSTED" }, 429))
      .mockResolvedValueOnce(json(GEOCODE_OK));
    const { client, sleep } = makeClient(fetchMock as unknown as typeof fetch);

    const center = await client.geocodeZip("83642");

    expect(center).toEqual({ lat: 43.6, lng: -116.4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(PLACES_RETRY_BACKOFF_MS);
  });

  it("throws a typed http error when a 5xx repeats on the retry", async () => {
    const fetchMock = vi.fn(async () => json({ error: "UNAVAILABLE" }, 503));
    const { client, sleep } = makeClient(fetchMock as unknown as typeof fetch);

    const err = await client
      .nearbySearch({
        center: { lat: 43.6, lng: -116.4 },
        radiusMeters: 1000,
        categoryType: "plumber",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlacesApiError);
    expect(err).toMatchObject({ endpoint: "nearby", kind: "http", status: 503 });
    expect((err as Error).message).toMatch(
      /^Places searchNearby 503 \(after 1 retry\): /,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable 4xx, and 404 details stays null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "NOT_FOUND" }, 404))
      .mockResolvedValueOnce(json({ error: "INVALID_ARGUMENT" }, 400));
    const { client, sleep } = makeClient(fetchMock as unknown as typeof fetch);

    expect(await client.getDetails("missing")).toBeNull();
    const err = await client.getDetails("bad").catch((e: unknown) => e);

    expect(err).toMatchObject({ kind: "http", status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("Scout records the typed error as its failure reason", async () => {
    const fetchMock = vi.fn(async () => json({ error: "INTERNAL" }, 500));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const store = new MemoryStore();
    const search = await store.createSearch({
      workspace_id: DEV_WORKSPACE_ID,
      created_by: DEV_USER_ID,
      mode: "zip_radius",
      params: { zip: "83642", radius_miles: 5 },
      category: "plumber",
    });

    const result = await runScout({ store, places: client, search, jobId: null });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^Places searchText 500 \(after 1 retry\): /);
  });
});

describe("textSearch — free-phrase discovery (RFL.SEARCH.CAT.2)", () => {
  const center = { lat: 43.6, lng: -116.4 };
  const TEXT_OK = {
    places: [
      {
        id: "p1",
        displayName: { text: "Valley Heating & Air" },
        location: { latitude: 43.61, longitude: -116.41 },
        primaryType: "hvac_contractor",
      },
      { id: "", displayName: { text: "dropped: no id" } },
    ],
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("circleToRectangle: bounding box of the circle, low = SW, high = NE", () => {
    const rect = circleToRectangle(center, 1000);
    expect(rect.low.latitude).toBeLessThan(center.lat);
    expect(rect.low.longitude).toBeLessThan(center.lng);
    expect(rect.high.latitude).toBeGreaterThan(center.lat);
    expect(rect.high.longitude).toBeGreaterThan(center.lng);
    // 1 km ≈ 0.009° of latitude either side.
    expect(rect.high.latitude - rect.low.latitude).toBeCloseTo(2 * 1000 / 111_320, 5);
  });

  it("POSTs places:searchText with the phrase, a 20 cap, a rectangle and the nearby field mask", async () => {
    const fetchMock = vi.fn(async () => json(TEXT_OK));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const calls: Array<{ endpoint: string; costCents: number }> = [];
    client.onCall((info) => calls.push(info));

    const records = await client.textSearch({
      center,
      radiusMeters: 2000,
      textQuery: "hvac repair",
    });

    const [url, init] = (fetchMock.mock.calls[0] as unknown[]) as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe(
      [
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
      ].join(","),
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      textQuery: "hvac repair",
      maxResultCount: 20,
      locationRestriction: { rectangle: circleToRectangle(center, 2000) },
    });
    expect(body).not.toHaveProperty("includedTypes");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      placeId: "p1",
      name: "Valley Heating & Air",
      primaryType: "hvac_contractor",
    });
    expect(calls).toEqual([{ endpoint: "text", costCents: PLACES_COST_CENTS.text }]);
    expect(PLACES_COST_CENTS.text).toBe(PLACES_COST_CENTS.nearby);
  });

  it("retries once after a 2s backoff on 429, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "RESOURCE_EXHAUSTED" }, 429))
      .mockResolvedValueOnce(json(TEXT_OK));
    const { client, sleep } = makeClient(fetchMock as unknown as typeof fetch);

    const records = await client.textSearch({ center, radiusMeters: 1000, textQuery: "hvac" });

    expect(records.map((r) => r.placeId)).toEqual(["p1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(PLACES_RETRY_BACKOFF_MS);
  });

  it("throws a typed http error naming the text endpoint when the retry fails too", async () => {
    const fetchMock = vi.fn(async () => json({ error: "UNAVAILABLE" }, 503));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const err = await client
      .textSearch({ center, radiusMeters: 1000, textQuery: "hvac" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesApiError);
    expect(err).toMatchObject({ endpoint: "text", kind: "http", status: 503 });
    expect((err as Error).message).toMatch(/^Places searchText 503 \(after 1 retry\): /);
  });
});

describe("Place Details + photos (RFL-06)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests the enrichment fields and keeps the originals", () => {
    for (const field of [
      "id",
      "displayName",
      "nationalPhoneNumber",
      "websiteUri",
      "primaryType",
      "regularOpeningHours",
      "photos",
      "reviews",
      "editorialSummary",
      "types",
      "priceLevel",
    ]) {
      expect(DETAILS_FIELD_MASK.split(",")).toContain(field);
    }
  });

  it("getDetails returns the record with the raw details attached (+ fetchedAt)", async () => {
    const raw = {
      id: "abc",
      displayName: { text: "Example Plumbing" },
      nationalPhoneNumber: "(208) 555-0100",
      regularOpeningHours: { weekdayDescriptions: ["Monday: 8 AM – 5 PM"] },
      photos: [{ name: "places/abc/photos/p1", widthPx: 100, heightPx: 100 }],
      reviews: [{ rating: 5, text: { text: "Great" } }],
      types: ["plumber"],
    };
    const fetchMock = vi.fn(async () => json(raw));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const record = await client.getDetails("abc");
    expect(record?.name).toBe("Example Plumbing");
    expect(record?.details).toMatchObject(raw);
    expect(record?.details?.fetchedAt).toMatch(/^\d{4}-/);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe(
      DETAILS_FIELD_MASK,
    );
  });

  it("fetchPhoto: media metadata then image; the API key is only ever a header", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ name: "places/abc/photos/p1/media", photoUri: "https://lh3.googleusercontent.com/p/x=s1600" }),
      )
      .mockResolvedValueOnce(
        new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
      );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { client } = makeClient(fetchMock as unknown as typeof fetch);

    const photo = await client.fetchPhoto("places/abc/photos/p1", 5000);

    expect(photo?.contentType).toBe("image/png");
    expect(photo?.bytes).toEqual(png);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe(
      "https://places.googleapis.com/v1/places/abc/photos/p1/media?maxWidthPx=1600&skipHttpRedirect=true",
    );
    expect((calls[0]![1].headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("test-key");
    for (const [url] of calls) expect(url).not.toContain("test-key");
    expect(calls[1]![0]).toBe("https://lh3.googleusercontent.com/p/x=s1600");
    const logged = [...logSpy.mock.calls, ...(console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls]
      .flat()
      .map(String)
      .join(" ");
    expect(logged).not.toContain("test-key");
  });

  it("fetchPhoto rejects a malformed reference without any request", async () => {
    const fetchMock = vi.fn();
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    expect(await client.fetchPhoto("../../secret", 800)).toBeNull();
    expect(await client.fetchPhoto("places/abc/photos/p1/../x", 800)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
