/**
 * Recent-searches rows (RFL.SEARCH.CAT.2): the category reads back exactly
 * as typed — a type code or a free phrase — followed by the area.
 */
import { describe, expect, it } from "vitest";
import { searchLocation, searchTitle } from "./search-label";

describe("searchTitle", () => {
  it("shows a free phrase as typed with the zip and radius", () => {
    expect(
      searchTitle({
        category: "hvac repair",
        mode: "zip_radius",
        params: { zip: "83686", radius_miles: 5 },
      }),
    ).toBe("hvac repair · 83686 · 5 mi");
  });

  it("shows a type code as stored, with a map pin rounded to 3 places", () => {
    expect(
      searchTitle({
        category: "plumber",
        mode: "map_draw",
        params: { lat: 43.6135, lng: -116.2035, radius_miles: 10 },
      }),
    ).toBe("plumber · 43.614, -116.204 · 10 mi");
  });

  it("falls back to the mode when the params carry no area", () => {
    expect(searchLocation({ category: "x", mode: "zip_radius", params: {} })).toBe("zip_radius");
  });
});
