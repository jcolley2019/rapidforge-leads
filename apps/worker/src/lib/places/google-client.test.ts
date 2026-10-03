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
  GooglePlacesClient,
  PLACES_RETRY_BACKOFF_MS,
  PlacesApiError,
} from "./google-client";

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
