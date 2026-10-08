import { describe, expect, it } from "vitest";
import type { Audit, Business, SearchResult } from "@rapidforge/shared";
import type { LeadView } from "@/lib/api";
import { dedupeLeads, freshDrawerLead } from "./dedupe";

let counter = 0;

function lead(overrides: {
  businessId?: string;
  name?: string;
  searchId?: string;
  status?: SearchResult["status"];
  notes?: string | null;
  createdAt?: string;
  lastContactedAt?: string | null;
  audit?: Partial<Audit> | null;
}): LeadView {
  counter += 1;
  const businessId = overrides.businessId ?? "biz-1";
  const business: Business = {
    id: businessId,
    workspace_id: "w-1",
    google_place_id: `place-${businessId}`,
    name: overrides.name ?? "Boise Drain Pros",
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
    website_kind: "real",
    first_seen_at: null,
    last_refreshed_at: null,
  };
  const result: SearchResult = {
    id: `res-${counter}`,
    workspace_id: "w-1",
    search_id: overrides.searchId ?? `search-${counter}`,
    business_id: businessId,
    latest_audit_id: null,
    status: overrides.status ?? "new",
    notes: overrides.notes ?? null,
    last_contacted_at: overrides.lastContactedAt ?? null,
    next_followup_at: null,
    created_at: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
  };
  const audit =
    overrides.audit === null || overrides.audit === undefined
      ? null
      : ({
          id: `aud-${counter}`,
          workspace_id: "w-1",
          business_id: businessId,
          status: "completed",
          created_at: "2026-07-01T00:00:00.000Z",
          completed_at: "2026-07-01T00:00:00.000Z",
          website_health_score: 50,
          star_grade: 3,
          sellability_score: 60,
          ...overrides.audit,
        } as Audit);
  return { business, result, audit };
}

describe("dedupeLeads", () => {
  it("collapses the same business across searches with seenIn = N", () => {
    const rows = dedupeLeads([
      lead({ searchId: "s1" }),
      lead({ searchId: "s2" }),
      lead({ businessId: "biz-2", name: "Other Co", searchId: "s1" }),
    ]);
    expect(rows).toHaveLength(2);
    const dup = rows.find((r) => r.business.id === "biz-1");
    expect(dup?.seenIn).toBe(2);
    expect(rows.find((r) => r.business.id === "biz-2")?.seenIn).toBe(1);
  });

  it("keeps distinct businesses apart", () => {
    const rows = dedupeLeads([
      lead({ businessId: "a", name: "A" }),
      lead({ businessId: "b", name: "B" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.seenIn === 1)).toBe(true);
  });

  it("a worked row beats a newer unworked row (pipeline state survives re-search)", () => {
    const rows = dedupeLeads([
      lead({
        searchId: "s1",
        status: "interested",
        notes: "asked for callback",
        createdAt: "2026-06-01T00:00:00.000Z",
        lastContactedAt: "2026-06-20T00:00:00.000Z",
      }),
      lead({
        searchId: "s2",
        status: "new",
        createdAt: "2026-07-05T00:00:00.000Z",
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result.status).toBe("interested");
    expect(rows[0]?.result.notes).toBe("asked for callback");
  });

  it("among worked rows the most recently contacted wins", () => {
    const rows = dedupeLeads([
      lead({
        searchId: "s1",
        status: "called",
        lastContactedAt: "2026-06-10T00:00:00.000Z",
      }),
      lead({
        searchId: "s2",
        status: "sold",
        lastContactedAt: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    expect(rows[0]?.result.status).toBe("sold");
  });

  it("among unworked rows the newest search_result wins", () => {
    const rows = dedupeLeads([
      lead({ searchId: "s1", createdAt: "2026-06-01T00:00:00.000Z" }),
      lead({ searchId: "s2", createdAt: "2026-07-05T00:00:00.000Z" }),
    ]);
    expect(rows[0]?.result.search_id).toBe("s2");
  });

  it("latest audit wins for scores even when an older row carries it", () => {
    const rows = dedupeLeads([
      lead({
        searchId: "s1",
        createdAt: "2026-06-01T00:00:00.000Z",
        audit: {
          sellability_score: 88,
          completed_at: "2026-07-04T00:00:00.000Z",
        },
      }),
      lead({
        searchId: "s2",
        createdAt: "2026-07-05T00:00:00.000Z",
        audit: null, // newer search not audited yet (30-day cache path)
      }),
    ]);
    expect(rows).toHaveLength(1);
    // representative row is the newer result, but the audit comes across
    expect(rows[0]?.result.search_id).toBe("s2");
    expect(rows[0]?.audit?.sellability_score).toBe(88);
  });

  it("picks the newer of two audits", () => {
    const rows = dedupeLeads([
      lead({
        searchId: "s1",
        audit: { sellability_score: 40, completed_at: "2026-06-01T00:00:00.000Z" },
      }),
      lead({
        searchId: "s2",
        audit: { sellability_score: 90, completed_at: "2026-07-05T00:00:00.000Z" },
      }),
    ]);
    expect(rows[0]?.audit?.sellability_score).toBe(90);
  });

  it("sorts by sellability desc, nulls last", () => {
    const rows = dedupeLeads([
      lead({ businessId: "low", name: "Low", audit: { sellability_score: 40 } }),
      lead({ businessId: "none", name: "None", audit: null }),
      lead({ businessId: "hot", name: "Hot", audit: { sellability_score: 95 } }),
    ]);
    expect(rows.map((r) => r.business.id)).toEqual(["hot", "low", "none"]);
  });
});

describe("freshDrawerLead (RFL.FIX.3i.1: Pipeline's open drawer follows a finished audit)", () => {
  it("moves the drawer onto the reloaded card's new scores, then settles", () => {
    const before = dedupeLeads([
      lead({
        businessId: "landers",
        name: "Landers Home Services",
        audit: { website_health_score: 72, star_grade: 4, sellability_score: 55 },
      }),
    ]);
    const open = before[0]!;
    // lead.scored bumps leadsVersion → Pipeline refetches: same row, new objects.
    const reloaded = dedupeLeads(
      before.map((l) => ({
        business: { ...l.business },
        result: { ...l.result },
        audit: { ...l.audit!, website_health_score: 70, star_grade: 3, sellability_score: 62 },
      })),
    );
    const fresh = freshDrawerLead(reloaded, open);
    expect(fresh?.result.id).toBe(open.result.id);
    expect(fresh?.audit).toMatchObject({
      website_health_score: 70,
      star_grade: 3,
      sellability_score: 62,
    });
    // Once the drawer holds the fresh card there is nothing to do — no re-open loop.
    expect(freshDrawerLead(reloaded, fresh)).toBeNull();
  });

  it("a business seen in two searches: the card's latest audit and seenIn reach the drawer", () => {
    const worked = lead({
      searchId: "s1",
      status: "called",
      lastContactedAt: "2026-10-06T00:00:00.000Z",
      audit: { sellability_score: 55, completed_at: "2026-10-07T01:00:00.000Z" },
    });
    const other = lead({
      searchId: "s2",
      audit: { sellability_score: 55, completed_at: "2026-10-07T01:00:00.000Z" },
    });
    const open = dedupeLeads([worked, other])[0]!;
    // The re-audit lands on the other search's row.
    const reloaded = dedupeLeads([
      { ...worked },
      {
        ...other,
        audit: { ...other.audit!, sellability_score: 62, completed_at: "2026-10-07T02:00:00.000Z" },
      },
    ]);
    const fresh = freshDrawerLead(reloaded, open);
    expect(fresh?.result.id).toBe(worked.result.id);
    expect(fresh?.result.status).toBe("called");
    expect(fresh?.audit?.sellability_score).toBe(62);
    expect(fresh?.seenIn).toBe(2);
  });

  it("closed drawer, or a row no longer listed → null", () => {
    const rows = dedupeLeads([lead({ audit: { sellability_score: 60 } })]);
    expect(freshDrawerLead(rows, null)).toBeNull();
    expect(freshDrawerLead(rows, lead({ businessId: "gone" }))).toBeNull();
  });
});
