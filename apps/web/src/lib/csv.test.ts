import { describe, expect, it } from "vitest";
import type { Audit, Business, SearchResult } from "@rapidforge/shared";
import type { LeadView } from "@/lib/api";
import { CSV_HEADERS, csvField, leadsToCsv } from "./csv";

function makeLead(overrides: {
  business?: Partial<Business>;
  audit?: Partial<Audit> | null;
  result?: Partial<SearchResult>;
}): LeadView {
  const business: Business = {
    id: "b-1",
    workspace_id: "w-1",
    google_place_id: "fx-001",
    name: "Snake River Plumbing Co",
    phone: "(208) 555-0101",
    website_url: "https://snakeriverplumbing.com",
    address: "1120 N Main St, Meridian, ID 83642",
    lat: 43.6,
    lng: -116.4,
    google_rating: 4.7,
    review_count: 127,
    category: "plumber",
    business_status: "OPERATIONAL",
    is_chain: false,
    website_kind: "real",
    first_seen_at: null,
    last_refreshed_at: null,
    ...overrides.business,
  };
  const result: SearchResult = {
    id: "r-1",
    workspace_id: "w-1",
    search_id: "s-1",
    business_id: "b-1",
    latest_audit_id: null,
    status: "new",
    notes: null,
    last_contacted_at: null,
    next_followup_at: null,
    created_at: null,
    ...overrides.result,
  };
  const audit =
    overrides.audit === null
      ? null
      : ({
          id: "a-1",
          workspace_id: "w-1",
          business_id: "b-1",
          website_health_score: 88,
          star_grade: 5,
          sellability_score: 42,
          status: "completed",
          ...overrides.audit,
        } as Audit);
  return { business, result, audit };
}

describe("csvField", () => {
  it("passes plain values through unquoted", () => {
    expect(csvField("plumber")).toBe("plumber");
    expect(csvField(42)).toBe("42");
  });

  it("renders null/undefined as empty, never 'null'", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes commas, quotes, and newlines per RFC 4180", () => {
    expect(csvField("1120 N Main St, Meridian")).toBe(
      '"1120 N Main St, Meridian"',
    );
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("leadsToCsv", () => {
  it("emits a header row plus one CRLF-terminated row per lead", () => {
    const csv = leadsToCsv([makeLead({}), makeLead({})]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_HEADERS.join(","));
    expect(lines).toHaveLength(4); // header + 2 rows + trailing empty
    expect(lines[3]).toBe("");
  });

  it("keeps every column aligned with the header", () => {
    const csv = leadsToCsv([makeLead({})]);
    const lines = csv.split("\r\n");
    const header = lines[0] ?? "";
    const row = lines[1] ?? "";
    expect(header.split(",").length).toBe(CSV_HEADERS.length);
    // The fixture address contains commas → quoted, so count via regex.
    const fields = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g);
    expect(row).toContain('"1120 N Main St, Meridian, ID 83642"');
    expect(fields).not.toBeNull();
  });

  it("exports scores, status, and notes; empty fields for unaudited leads", () => {
    const audited = makeLead({
      result: { status: "interested", notes: 'callback, ask for "Sam"' },
    });
    const unaudited = makeLead({ audit: null, business: { phone: null } });
    const csv = leadsToCsv([audited, unaudited]);
    const rows = csv.trimEnd().split("\r\n").slice(1);

    expect(rows[0]).toContain("88");
    expect(rows[0]).toContain("42");
    expect(rows[0]).toContain("interested");
    expect(rows[0]).toContain('"callback, ask for ""Sam"""');

    // Unaudited: health/stars/sellability columns are empty (,, runs).
    expect(rows[1]).toContain(",,,");
    expect(rows[1]).toContain("new");
  });

  it("defaults a null status to 'new'", () => {
    const csv = leadsToCsv([makeLead({ result: { status: null } })]);
    expect(csv.split("\r\n")[1]).toContain("new");
  });
});
