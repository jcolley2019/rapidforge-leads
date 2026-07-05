import { describe, expect, it } from "vitest";
import { MapDrawParamsSchema } from "@rapidforge/shared";
import {
  clampRadiusMiles,
  estimatePlacesCalls,
  estimateSearchCostCents,
  mapSelectionToParams,
  metersToMiles,
  milesToMeters,
} from "./geo";

describe("unit conversions", () => {
  it("round-trips miles ↔ meters", () => {
    expect(milesToMeters(1)).toBeCloseTo(1609.344, 3);
    expect(metersToMiles(milesToMeters(12.5))).toBeCloseTo(12.5, 9);
  });
});

describe("clampRadiusMiles", () => {
  it("clamps to the 1–25 mile plan bounds", () => {
    expect(clampRadiusMiles(0.2)).toBe(1);
    expect(clampRadiusMiles(80)).toBe(25);
  });

  it("snaps to 0.1-mile steps", () => {
    expect(clampRadiusMiles(7.6789)).toBe(7.7);
    expect(clampRadiusMiles(10)).toBe(10);
  });
});

describe("estimates", () => {
  it("mirrors the worker tile bands", () => {
    expect(estimatePlacesCalls(2)).toBe(1);
    expect(estimatePlacesCalls(5)).toBe(9);
    expect(estimatePlacesCalls(25)).toBe(30);
  });

  it("prices at 3.2¢ per Nearby call", () => {
    expect(estimateSearchCostCents(2)).toBe(3);
    expect(estimateSearchCostCents(25)).toBe(96);
  });
});

describe("mapSelectionToParams (radius → search params conversion)", () => {
  const boise = { lat: 43.61503997, lng: -116.20234501 };
  const filters = { min_reviews: 10, min_rating: 4, exclude_chains: true };

  it("produces schema-valid map_draw params carrying the filters", () => {
    const params = mapSelectionToParams(boise, 8, filters);
    expect(MapDrawParamsSchema.safeParse(params).success).toBe(true);
    expect(params).toMatchObject({
      radius_miles: 8,
      min_reviews: 10,
      min_rating: 4,
      exclude_chains: true,
    });
  });

  it("rounds coordinates to 6 decimal places", () => {
    const params = mapSelectionToParams(boise, 8, filters);
    expect(params.lat).toBe(43.61504);
    expect(params.lng).toBe(-116.202345);
  });

  it("clamps a dragged-out radius to the 25-mile plan cap", () => {
    expect(mapSelectionToParams(boise, 31.4, filters).radius_miles).toBe(25);
  });

  it("clamps a pinched radius up to 1 mile", () => {
    expect(mapSelectionToParams(boise, 0.05, filters).radius_miles).toBe(1);
  });

  it("throws on an out-of-range pin rather than sending it", () => {
    expect(() =>
      mapSelectionToParams({ lat: 91, lng: 0 }, 5, filters),
    ).toThrow();
  });
});
