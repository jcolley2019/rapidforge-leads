/**
 * MemoryStore deletes (RFL.DATA.1): deleteSearch removes a search, its
 * results and only the businesses no other search still references;
 * clearWorkspaceData empties the workspace's six tables. usage_events and
 * workspace_config stay in both cases; other workspaces are never touched.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory";
import {
  DEV_USER_ID,
  DEV_WORKSPACE_ID,
  SearchActiveError,
  SearchNotFoundError,
  type UpsertBusinessInput,
} from "./types";

const OTHER_WORKSPACE = "00000000-0000-4000-8000-00000000beef";

function business(
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
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    ...overrides,
  };
}

async function newSearch(store: MemoryStore, workspaceId = DEV_WORKSPACE_ID) {
  const search = await store.createSearch({
    workspace_id: workspaceId,
    created_by: DEV_USER_ID,
    mode: "zip_radius",
    params: { zip: "83642", radius_miles: 5 },
    category: "plumber",
  });
  await store.updateSearch(search.id, { status: "completed" });
  return search;
}

/**
 * Two completed searches. A is found only by search A, Shared by both,
 * B only by search B. Each business has one audit, one audit job and one
 * agent run; each search has a scout job and a scout agent run.
 */
async function seed(store: MemoryStore) {
  const searchA = await newSearch(store);
  const searchB = await newSearch(store);
  const onlyA = await store.upsertBusiness(business({ google_place_id: "p-a", name: "Only A" }));
  const shared = await store.upsertBusiness(business({ google_place_id: "p-s", name: "Shared" }));
  const onlyB = await store.upsertBusiness(business({ google_place_id: "p-b", name: "Only B" }));
  await store.ensureSearchResult(DEV_WORKSPACE_ID, searchA.id, onlyA.id);
  await store.ensureSearchResult(DEV_WORKSPACE_ID, searchA.id, shared.id);
  await store.ensureSearchResult(DEV_WORKSPACE_ID, searchB.id, shared.id);
  await store.ensureSearchResult(DEV_WORKSPACE_ID, searchB.id, onlyB.id);

  for (const [search, biz] of [
    [searchA, onlyA],
    [searchA, shared],
    [searchB, shared],
    [searchB, onlyB],
  ] as const) {
    const audit = await store.insertAudit({
      workspace_id: DEV_WORKSPACE_ID,
      business_id: biz.id,
      website_url: biz.website_url,
      http_status: 200,
      response_ms: 300,
      ssl_valid: true,
      website_health_score: 50,
      star_grade: 3,
      sellability_score: 60,
      score_breakdown: null,
      issues: [],
      status: "completed",
      error_message: null,
      completed_at: new Date().toISOString(),
    });
    await store.setLatestAudit(search.id, biz.id, audit.id);
    const job = await store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "audit_business",
      payload: { search_id: search.id, business_id: biz.id },
    });
    await store.insertAgentRun({
      workspace_id: DEV_WORKSPACE_ID,
      agent_name: "health",
      job_id: job.id,
      target_id: biz.id,
      input: { search_id: search.id },
    });
  }
  for (const search of [searchA, searchB]) {
    const scout = await store.enqueueJob({
      workspace_id: DEV_WORKSPACE_ID,
      job_type: "scout",
      payload: { search_id: search.id },
    });
    await store.insertAgentRun({
      workspace_id: DEV_WORKSPACE_ID,
      agent_name: "scout",
      job_id: scout.id,
      target_id: null,
      input: { search_id: search.id },
    });
  }
  await store.logUsageEvent({
    workspace_id: DEV_WORKSPACE_ID,
    event_type: "places_call",
    cost_cents: 3,
    metadata: null,
  });
  await store.updateWorkspaceConfig(DEV_WORKSPACE_ID, { user_brand: "Keep Me" });
  return { searchA, searchB, onlyA, shared, onlyB };
}

describe("MemoryStore.deleteSearch (RFL.DATA.1)", () => {
  it("removes the search, its results and its orphan business; a business in two searches survives", async () => {
    const store = new MemoryStore();
    const { searchA, searchB, onlyA, shared, onlyB } = await seed(store);

    const counts = await store.deleteSearch(DEV_WORKSPACE_ID, searchA.id);
    expect(counts).toEqual({
      results: 2, // onlyA + shared rows of search A
      businesses: 1, // onlyA
      audits: 1, // onlyA's audit — shared keeps both of its audits
      jobs: 3, // A's scout job + A's two audit jobs (onlyA, shared)
      agentRuns: 3, // the runs of those jobs (all carry search A's id)
      searches: 1,
    });

    expect(await store.getSearch(searchA.id)).toBeNull();
    expect(await store.getBusiness(onlyA.id)).toBeNull();
    expect(await store.getBusiness(shared.id)).not.toBeNull();
    expect(await store.getBusiness(onlyB.id)).not.toBeNull();
    expect(await store.listAuditsForBusiness(shared.id)).toHaveLength(2);
    expect(await store.listAuditsForBusiness(onlyA.id)).toHaveLength(0);

    const detailB = await store.getSearchDetail(searchB.id);
    expect(detailB?.leads.map((l) => l.business.name).sort()).toEqual(["Only B", "Shared"]);
    expect(detailB?.job_counts.queued).toBe(3);
    expect(detailB?.agent_states).toHaveLength(3);

    const leads = await store.listWorkspaceLeads(DEV_WORKSPACE_ID);
    expect(leads.map((l) => l.business.name).sort()).toEqual(["Only B", "Shared"]);

    // The cost ledger and Settings stay.
    expect(store.listUsageEvents()).toHaveLength(1);
    expect((await store.getWorkspaceConfig(DEV_WORKSPACE_ID))?.user_brand).toBe("Keep Me");
  });

  it("deleting the second search afterwards removes the now-orphaned shared business too", async () => {
    const store = new MemoryStore();
    const { searchA, searchB, shared } = await seed(store);
    await store.deleteSearch(DEV_WORKSPACE_ID, searchA.id);
    const counts = await store.deleteSearch(DEV_WORKSPACE_ID, searchB.id);
    expect(counts).toEqual({ results: 2, businesses: 2, audits: 3, jobs: 3, agentRuns: 3, searches: 1 });
    expect(await store.getBusiness(shared.id)).toBeNull();
    expect(await store.listWorkspaceLeads(DEV_WORKSPACE_ID)).toEqual([]);
  });

  it("refuses a search that is still running and deletes nothing", async () => {
    const store = new MemoryStore();
    const { searchA, onlyA } = await seed(store);
    await store.updateSearch(searchA.id, { status: "auditing" });

    await expect(store.deleteSearch(DEV_WORKSPACE_ID, searchA.id)).rejects.toBeInstanceOf(
      SearchActiveError,
    );
    expect(await store.getSearch(searchA.id)).not.toBeNull();
    expect(await store.getBusiness(onlyA.id)).not.toBeNull();
    expect((await store.getSearchDetail(searchA.id))?.leads).toHaveLength(2);

    // pending (never started) counts as active too — only completed/failed delete.
    await store.updateSearch(searchA.id, { status: "pending" });
    await expect(store.deleteSearch(DEV_WORKSPACE_ID, searchA.id)).rejects.toBeInstanceOf(
      SearchActiveError,
    );
    await store.updateSearch(searchA.id, { status: "failed" });
    await expect(store.deleteSearch(DEV_WORKSPACE_ID, searchA.id)).resolves.toMatchObject({
      searches: 1,
    });
  });

  it("404s a search from another workspace or an unknown id", async () => {
    const store = new MemoryStore();
    const { searchA } = await seed(store);
    await expect(store.deleteSearch(OTHER_WORKSPACE, searchA.id)).rejects.toBeInstanceOf(
      SearchNotFoundError,
    );
    await expect(
      store.deleteSearch(DEV_WORKSPACE_ID, "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toBeInstanceOf(SearchNotFoundError);
    expect(await store.getSearch(searchA.id)).not.toBeNull();
  });
});

describe("MemoryStore.clearWorkspaceData (RFL.DATA.1)", () => {
  it("empties the six tables for the workspace only; usage_events and config stay", async () => {
    const store = new MemoryStore();
    await seed(store);
    // Another tenant's rows must survive.
    const foreign = await newSearch(store, OTHER_WORKSPACE);
    const foreignBiz = await store.upsertBusiness(
      business({ google_place_id: "p-x", name: "Elsewhere", workspace_id: OTHER_WORKSPACE }),
    );
    await store.ensureSearchResult(OTHER_WORKSPACE, foreign.id, foreignBiz.id);

    const counts = await store.clearWorkspaceData(DEV_WORKSPACE_ID);
    expect(counts).toEqual({
      results: 4,
      businesses: 3,
      audits: 4,
      jobs: 6,
      agentRuns: 6,
      searches: 2,
    });
    expect(await store.listRecentSearches(DEV_WORKSPACE_ID, 10)).toEqual([]);
    expect(await store.listWorkspaceLeads(DEV_WORKSPACE_ID)).toEqual([]);
    expect(store.listAgentRuns()).toHaveLength(0);
    expect(await store.getQueueHealth()).toMatchObject({ queued: 0, running: 0 });

    expect(await store.getSearch(foreign.id)).not.toBeNull();
    expect(await store.getBusiness(foreignBiz.id)).not.toBeNull();
    expect(await store.listWorkspaceLeads(OTHER_WORKSPACE)).toHaveLength(1);

    expect(store.listUsageEvents()).toHaveLength(1);
    expect((await store.getWorkspaceConfig(DEV_WORKSPACE_ID))?.user_brand).toBe("Keep Me");

    // Idempotent: a second clear finds nothing.
    expect(await store.clearWorkspaceData(DEV_WORKSPACE_ID)).toEqual({
      results: 0,
      businesses: 0,
      audits: 0,
      jobs: 0,
      agentRuns: 0,
      searches: 0,
    });
  });
});
