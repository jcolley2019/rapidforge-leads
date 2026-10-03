import { describe, expect, it } from "vitest";
import {
  CreateSearchRequestSchema,
  MapDrawParamsSchema,
  UpdateLeadStatusRequestSchema,
  UpdateWorkspaceConfigRequestSchema,
} from "./schemas";

describe("MapDrawParamsSchema", () => {
  const valid = { lat: 43.6135, lng: -116.2035, radius_miles: 10 };

  it("accepts a pin with defaults applied", () => {
    const parsed = MapDrawParamsSchema.parse(valid);
    expect(parsed).toEqual({
      lat: 43.6135,
      lng: -116.2035,
      radius_miles: 10,
      min_reviews: 0,
      min_rating: 0,
      exclude_chains: true, // RFL-04: chains excluded by default
    });
  });

  it("keeps explicit filters", () => {
    const parsed = MapDrawParamsSchema.parse({
      ...valid,
      min_reviews: 25,
      min_rating: 4,
      exclude_chains: true,
    });
    expect(parsed.min_reviews).toBe(25);
    expect(parsed.min_rating).toBe(4);
    expect(parsed.exclude_chains).toBe(true);
  });

  it.each([
    ["lat above range", { ...valid, lat: 90.1 }],
    ["lat below range", { ...valid, lat: -90.1 }],
    ["lng above range", { ...valid, lng: 180.1 }],
    ["lng below range", { ...valid, lng: -180.1 }],
    ["radius below 1", { ...valid, radius_miles: 0.5 }],
    ["radius above 25", { ...valid, radius_miles: 26 }],
    ["negative min_reviews", { ...valid, min_reviews: -1 }],
    ["min_rating above 5", { ...valid, min_rating: 5.5 }],
  ])("rejects %s", (_label, params) => {
    expect(MapDrawParamsSchema.safeParse(params).success).toBe(false);
  });
});

describe("CreateSearchRequestSchema (discriminated union)", () => {
  it("still accepts a zip_radius request", () => {
    const parsed = CreateSearchRequestSchema.parse({
      mode: "zip_radius",
      category: "plumber",
      params: { zip: "83704", radius_miles: 10 },
    });
    expect(parsed.mode).toBe("zip_radius");
    if (parsed.mode === "zip_radius") {
      expect(parsed.params.zip).toBe("83704");
    }
  });

  it("accepts a map_draw request", () => {
    const parsed = CreateSearchRequestSchema.parse({
      mode: "map_draw",
      category: "electrician",
      params: { lat: 43.6, lng: -116.2, radius_miles: 5 },
    });
    expect(parsed.mode).toBe("map_draw");
    if (parsed.mode === "map_draw") {
      expect(parsed.params.lat).toBe(43.6);
      expect(parsed.params.exclude_chains).toBe(true);
    }
  });

  it("rejects keyword mode (v1.5)", () => {
    const result = CreateSearchRequestSchema.safeParse({
      mode: "keyword",
      category: "plumber",
      params: { query: "plumbers near boise" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects zip params under map_draw mode", () => {
    const result = CreateSearchRequestSchema.safeParse({
      mode: "map_draw",
      category: "plumber",
      params: { zip: "83704", radius_miles: 10 },
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateLeadStatusRequestSchema", () => {
  it("accepts a status-only change", () => {
    expect(
      UpdateLeadStatusRequestSchema.parse({ status: "called" }).status,
    ).toBe("called");
  });

  it("accepts a notes-only autosave", () => {
    const parsed = UpdateLeadStatusRequestSchema.parse({
      notes: "Spoke to owner, call back Tuesday",
    });
    expect(parsed.notes).toContain("Tuesday");
    expect(parsed.status).toBeUndefined();
  });

  it("accepts clearing notes with null", () => {
    expect(UpdateLeadStatusRequestSchema.parse({ notes: null }).notes).toBe(
      null,
    );
  });

  it("rejects an empty body", () => {
    expect(UpdateLeadStatusRequestSchema.safeParse({}).success).toBe(false);
  });

  it.each(["contacted", "won", "NEW", ""])(
    "rejects unknown status %j",
    (status) => {
      expect(UpdateLeadStatusRequestSchema.safeParse({ status }).success).toBe(
        false,
      );
    },
  );
});

describe("UpdateWorkspaceConfigRequestSchema", () => {
  it("accepts a partial patch", () => {
    const parsed = UpdateWorkspaceConfigRequestSchema.parse({
      your_offer: "Website rebuilds + local SEO",
      user_location: "Boise, ID",
    });
    expect(parsed.your_offer).toContain("SEO");
    expect(parsed.sales_tone).toBeUndefined();
  });

  it("accepts explicit nulls (field cleared)", () => {
    expect(
      UpdateWorkspaceConfigRequestSchema.parse({ target_industry: null })
        .target_industry,
    ).toBe(null);
  });

  it("strips unknown keys rather than persisting them", () => {
    const parsed = UpdateWorkspaceConfigRequestSchema.parse({
      user_brand: "RapidForgeAI",
      api_key: "should-not-survive",
    } as Record<string, unknown>);
    expect("api_key" in parsed).toBe(false);
  });
});
