import { describe, expect, it } from "vitest";
import { CATEGORY_MAX_CHARS, isPlaceType, KNOWN_PLACE_TYPES } from "./place-types";

describe("isPlaceType (RFL.SEARCH.CAT.2 routing)", () => {
  it("accepts every known Table A type code", () => {
    for (const type of KNOWN_PLACE_TYPES) expect(isPlaceType(type)).toBe(true);
    expect(isPlaceType("plumber")).toBe(true);
    expect(isPlaceType("roofing_contractor")).toBe(true);
  });

  it("treats anything else as a free phrase", () => {
    expect(isPlaceType("hvac")).toBe(false);
    expect(isPlaceType("hvac repair")).toBe(false);
    expect(isPlaceType("HVAC")).toBe(false);
    expect(isPlaceType("Plumber")).toBe(false);
    expect(isPlaceType("med spa")).toBe(false);
    // Shaped like a type but not one Nearby accepts.
    expect(isPlaceType("hvac_contractor")).toBe(false);
    expect(isPlaceType("landscaper")).toBe(false);
    expect(isPlaceType("")).toBe(false);
  });

  it("caps the phrase length at 80", () => {
    expect(CATEGORY_MAX_CHARS).toBe(80);
  });
});
