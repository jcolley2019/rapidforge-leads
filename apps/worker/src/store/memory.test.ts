/**
 * MemoryStore chain bookkeeping (RFL-04): workspace-wide multi-location
 * detection at upsert, across searches, with chain_reason precedence.
 */
import { describe, expect, it } from "vitest";
import type { Business } from "@rapidforge/shared";
import { MULTI_LOCATION_CHAIN_THRESHOLD } from "../lib/chains";
import { MemoryStore } from "./memory";
import { DEV_USER_ID, DEV_WORKSPACE_ID, type UpsertBusinessInput } from "./types";

const OTHER_WORKSPACE = "00000000-0000-4000-8000-00000000beef";

function input(
  overrides: Partial<UpsertBusinessInput> & { google_place_id: string; name: string },
): UpsertBusinessInput {
  return {
    workspace_id: DEV_WORKSPACE_ID,
    phone: "(208) 555-0100",
    website_url: "https://example.com",
    address: null,
    lat: null,
    lng: null,
    google_rating: 4.4,
    review_count: 40,
    category: "hair_salon",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    ...overrides,
  };
}

async function allNamed(store: MemoryStore, searchId: string, name: string): Promise<Business[]> {
  const detail = await store.getSearchDetail(searchId);
  return (detail?.leads ?? []).map((l) => l.business).filter((b) => b.name === name);
}

describe("MemoryStore.upsertBusiness multi-location (workspace-wide)", () => {
  it("marks the same name as a chain once it reaches 3 places across two searches", async () => {
    const store = new MemoryStore();
    const mk = (category: string) =>
      store.createSearch({
        workspace_id: DEV_WORKSPACE_ID,
        created_by: DEV_USER_ID,
        mode: "zip_radius",
        params: { zip: "83642", radius_miles: 5 },
        category,
      });
    const searchA = await mk("hair_salon");
    const searchB = await mk("hair_salon");

    // Search A finds two "Trim Studio" locations — not a chain yet.
    const a1 = await store.upsertBusiness(input({ google_place_id: "p-1", name: "Trim Studio - Nampa" }));
    const a2 = await store.upsertBusiness(input({ google_place_id: "p-2", name: "Trim Studio – Meridian" }));
    await store.ensureSearchResult(DEV_WORKSPACE_ID, searchA.id, a1.id);
    await store.ensureSearchResult(DEV_WORKSPACE_ID, searchA.id, a2.id);
    expect(a1.is_chain).toBe(false);
    expect(a2.is_chain).toBe(false);
    expect(a1.name_normalized).toBe("trim studio");

    // Search B, days later, finds a third location: all three flip.
    const b3 = await store.upsertBusiness(input({ google_place_id: "p-3", name: "Trim Studio #3" }));
    await store.ensureSearchResult(DEV_WORKSPACE_ID, searchB.id, b3.id);
    expect(MULTI_LOCATION_CHAIN_THRESHOLD).toBe(3);
    expect(b3).toMatchObject({ is_chain: true, chain_reason: "multi_location" });

    const inA = await allNamed(store, searchA.id, "Trim Studio - Nampa");
    expect(inA[0]).toMatchObject({ is_chain: true, chain_reason: "multi_location" });
    expect((await store.getBusiness(a2.id))).toMatchObject({
      is_chain: true,
      chain_reason: "multi_location",
    });
  });

  it("counts distinct place ids, not refreshes of the same place", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i += 1) {
      await store.upsertBusiness(input({ google_place_id: "p-same", name: "Solo Salon" }));
    }
    const b = await store.upsertBusiness(input({ google_place_id: "p-same", name: "Solo Salon" }));
    expect(b.is_chain).toBe(false);
    expect(b.chain_reason).toBeNull();
  });

  it("is scoped to the workspace", async () => {
    const store = new MemoryStore();
    await store.upsertBusiness(input({ google_place_id: "p-1", name: "Trim Studio" }));
    await store.upsertBusiness(input({ google_place_id: "p-2", name: "Trim Studio" }));
    const other = await store.upsertBusiness(
      input({ google_place_id: "p-3", name: "Trim Studio", workspace_id: OTHER_WORKSPACE }),
    );
    expect(other.is_chain).toBe(false);
    expect((await store.getBusiness(other.id))?.chain_reason).toBeNull();
  });

  it("keeps a known_brand / url_shape reason when the multi-location rule also fires", async () => {
    const store = new MemoryStore();
    const brand = await store.upsertBusiness(
      input({ google_place_id: "g-1", name: "Great Clips", is_chain: true, chain_reason: "known_brand" }),
    );
    await store.upsertBusiness(input({ google_place_id: "g-2", name: "Great Clips" }));
    await store.upsertBusiness(input({ google_place_id: "g-3", name: "Great Clips" }));
    expect((await store.getBusiness(brand.id))?.chain_reason).toBe("known_brand");
    expect(
      (await store.getBusiness((await store.upsertBusiness(input({ google_place_id: "g-2", name: "Great Clips" }))).id))
        ?.chain_reason,
    ).toBe("multi_location");
  });
});
