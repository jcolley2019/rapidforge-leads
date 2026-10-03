/**
 * RFL-06: Place Details are fetched by Filter only for businesses that pass
 * the gates (pending_audit / hot_lead), never for skips / dead / blocked /
 * cache hits, and never twice (Scout already persisted → reuse).
 */
import { describe, expect, it } from "vitest";
import type { Audit } from "@rapidforge/shared";
import { FixturePlacesClient } from "../lib/places/fixture-client";
import type { PlaceRecord, PlacesClient } from "../lib/places/types";
import { FixtureWebProbe } from "../lib/probe";
import { MemoryStore } from "../store/memory";
import {
  DEV_USER_ID,
  DEV_WORKSPACE_ID,
  type UpsertBusinessInput,
} from "../store/types";
import { runFilter } from "./filter";

/** Fixture client that counts getDetails calls. */
class CountingPlaces extends FixturePlacesClient implements PlacesClient {
  detailsCalls: string[] = [];
  override async getDetails(placeId: string): Promise<PlaceRecord | null> {
    this.detailsCalls.push(placeId);
    return super.getDetails(placeId);
  }
}

async function setup(
  overrides: Partial<UpsertBusinessInput> = {},
  params: Record<string, unknown> = {},
) {
  const store = new MemoryStore();
  const places = new CountingPlaces();
  const search = await store.createSearch({
    workspace_id: DEV_WORKSPACE_ID,
    created_by: DEV_USER_ID,
    mode: "zip_radius",
    params: { zip: "83642", radius_miles: 10, exclude_chains: false, ...params },
    category: "plumber",
  });
  const business = await store.upsertBusiness({
    workspace_id: DEV_WORKSPACE_ID,
    google_place_id: "fx-001",
    name: "Snake River Plumbing Co",
    phone: "(208) 555-0101",
    website_url: "https://snakeriverplumbing.com",
    address: "1120 N Main St, Meridian, ID 83642",
    lat: null,
    lng: null,
    google_rating: 4.7,
    review_count: 127,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    ...overrides,
  });
  await store.ensureSearchResult(DEV_WORKSPACE_ID, search.id, business.id);
  const run = (cachedAudit: Audit | null = null) =>
    runFilter({
      store,
      probe: new FixtureWebProbe(),
      places,
      search,
      business,
      jobId: null,
      cachedAudit,
    });
  return { store, places, search, business, run };
}

describe("Filter fetches Place Details only when the business passes (RFL-06)", () => {
  it("pending_audit (live real site): one getDetails, persisted to places_details", async () => {
    const { store, places, business, run } = await setup();
    const result = await run();
    expect(result.output?.outcome).toBe("pending_audit");
    expect(result.output?.details_fetched).toBe(true);
    expect(places.detailsCalls).toEqual(["fx-001"]);
    const stored = await store.getBusiness(business.id);
    const details = stored?.places_details as {
      regularOpeningHours?: { weekdayDescriptions?: string[] };
      photos?: unknown[];
      reviews?: unknown[];
      fetchedAt?: string;
    } | null;
    expect(details?.regularOpeningHours?.weekdayDescriptions).toHaveLength(7);
    expect(details?.photos).toHaveLength(2);
    expect(details?.reviews).toHaveLength(3);
    expect(details?.fetchedAt).toBeTruthy();
  });

  it("hot_lead (no website): one getDetails", async () => {
    const { places, run } = await setup({ website_url: null, website_kind: "none" });
    const result = await run();
    expect(result.output?.outcome).toBe("hot_lead");
    expect(places.detailsCalls).toHaveLength(1);
  });

  it("skip (gated out) never calls getDetails", async () => {
    const closed = await setup({ business_status: "CLOSED_PERMANENTLY" });
    expect((await closed.run()).output?.outcome).toBe("skip");
    expect(closed.places.detailsCalls).toEqual([]);

    const chain = await setup({ is_chain: true }, { exclude_chains: true });
    expect((await chain.run()).output?.outcome).toBe("skip");
    expect(chain.places.detailsCalls).toEqual([]);
  });

  it("dead site never calls getDetails", async () => {
    const { places, run } = await setup({
      website_url: "http://www.oldfaithfulplumbing.com", // DEAD_FIXTURE_HOSTS
    });
    expect((await run()).output?.outcome).toBe("dead_site");
    expect(places.detailsCalls).toEqual([]);
  });

  it("does not double-fetch when Scout already persisted places_details", async () => {
    const { places, run } = await setup({
      places_details: { id: "fx-001", fetchedAt: "2026-07-06T06:00:00.000Z" },
    });
    const result = await run();
    expect(result.output?.outcome).toBe("pending_audit");
    expect(result.output?.details_fetched).toBe(false);
    expect(places.detailsCalls).toEqual([]);
  });

  it("a 30-day cache hit never calls getDetails", async () => {
    const { store, places, business, search, run } = await setup();
    const cached = await store.insertAudit({
      workspace_id: DEV_WORKSPACE_ID,
      business_id: business.id,
      website_url: business.website_url,
      http_status: 200,
      response_ms: 300,
      ssl_valid: true,
      website_health_score: 80,
      star_grade: 4,
      sellability_score: 55,
      score_breakdown: {},
      issues: [],
      status: "completed",
      error_message: null,
      completed_at: new Date().toISOString(),
    });
    await store.setLatestAudit(search.id, business.id, cached.id);
    const result = await run(cached);
    expect(result.output?.outcome).toBe("cache_hit");
    expect(places.detailsCalls).toEqual([]);
  });

  it("works without a Places client (no fetch, no failure)", async () => {
    const { store, search, business } = await setup();
    const result = await runFilter({
      store,
      probe: new FixtureWebProbe(),
      search,
      business,
      jobId: null,
      cachedAudit: null,
    });
    expect(result.status).toBe("completed");
    expect(result.output?.details_fetched).toBe(false);
  });
});

describe("MemoryStore.places_details", () => {
  it("an upsert without the field leaves a stored record untouched; null clears it", async () => {
    const store = new MemoryStore();
    const base: UpsertBusinessInput = {
      workspace_id: DEV_WORKSPACE_ID,
      google_place_id: "p-1",
      name: "Keep My Details",
      phone: null,
      website_url: null,
      address: null,
      lat: null,
      lng: null,
      google_rating: null,
      review_count: null,
      category: null,
      business_status: null,
      is_chain: false,
      website_kind: "none",
    };
    const first = await store.upsertBusiness(base);
    expect(first.places_details).toBeNull();
    await store.setBusinessPlacesDetails(first.id, { id: "p-1", fetchedAt: "x" });
    const again = await store.upsertBusiness(base); // Scout re-upsert, no details
    expect(again.places_details).toEqual({ id: "p-1", fetchedAt: "x" });
    const cleared = await store.upsertBusiness({ ...base, places_details: null });
    expect(cleared.places_details).toBeNull();
  });
});
