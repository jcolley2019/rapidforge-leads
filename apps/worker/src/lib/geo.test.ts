import { describe, expect, it } from "vitest";
import {
  gridTileOffsets,
  haversineMeters,
  MAX_TILES_PER_SEARCH,
  METERS_PER_MILE,
  offsetMeters,
  planTiles,
  tileRadiusFor,
} from "./geo";

const NAMPA = { lat: 43.574, lng: -116.56 };
const BOISE = { lat: 43.615, lng: -116.2 };

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(NAMPA, NAMPA)).toBe(0);
  });

  it("measures Nampa→Boise at roughly 29 km", () => {
    const d = haversineMeters(NAMPA, BOISE);
    expect(d).toBeGreaterThan(25_000);
    expect(d).toBeLessThan(35_000);
  });

  it("is symmetric", () => {
    expect(haversineMeters(NAMPA, BOISE)).toBeCloseTo(
      haversineMeters(BOISE, NAMPA),
      6,
    );
  });
});

describe("offsetMeters", () => {
  it("round-trips through haversine within 1%", () => {
    const moved = offsetMeters(NAMPA, 5000, 0);
    expect(haversineMeters(NAMPA, moved)).toBeGreaterThan(4950);
    expect(haversineMeters(NAMPA, moved)).toBeLessThan(5050);
  });
});

describe("tileRadiusFor", () => {
  it("small searches are a single tile of their own radius", () => {
    expect(tileRadiusFor(3000)).toBe(3000);
    expect(tileRadiusFor(5000)).toBe(5000);
  });

  it("medium searches use 5 km tiles", () => {
    expect(tileRadiusFor(10_000)).toBe(5000);
    expect(tileRadiusFor(15_000)).toBe(5000);
  });

  it("large searches use 10 km tiles", () => {
    expect(tileRadiusFor(16_000)).toBe(10_000);
    expect(tileRadiusFor(25 * METERS_PER_MILE)).toBe(10_000);
  });
});

describe("gridTileOffsets", () => {
  it("returns a single centered tile when the tile covers the search", () => {
    expect(gridTileOffsets(4000, 4000)).toEqual([{ xMeters: 0, yMeters: 0 }]);
  });

  it("fully covers the search disk (every point within a tile radius)", () => {
    const searchRadius = 20_000;
    const tileRadius = 10_000;
    const offsets = gridTileOffsets(searchRadius, tileRadius);

    // Sample the disk on a 1 km lattice; every sample must be inside
    // at least one tile.
    for (let x = -searchRadius; x <= searchRadius; x += 1000) {
      for (let y = -searchRadius; y <= searchRadius; y += 1000) {
        if (Math.hypot(x, y) > searchRadius) continue;
        const covered = offsets.some(
          (o) => Math.hypot(x - o.xMeters, y - o.yMeters) <= tileRadius,
        );
        expect(covered, `uncovered point (${x}, ${y})`).toBe(true);
      }
    }
  });

  it("orders tiles center-out", () => {
    const offsets = gridTileOffsets(20_000, 5_000);
    const distances = offsets.map((o) => Math.hypot(o.xMeters, o.yMeters));
    const sorted = [...distances].sort((a, b) => a - b);
    expect(distances).toEqual(sorted);
  });
});

describe("planTiles", () => {
  it("keeps the max 25-mile search within the cost cap, untruncated", () => {
    const { tiles, truncated } = planTiles(NAMPA, 25 * METERS_PER_MILE);
    expect(truncated).toBe(false);
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(MAX_TILES_PER_SEARCH);
  });

  it("keeps every tile center within reach of the search center", () => {
    const radius = 25 * METERS_PER_MILE;
    const { tiles } = planTiles(NAMPA, radius);
    for (const tile of tiles) {
      // + tile radius + 1% latlng-projection slack
      expect(haversineMeters(NAMPA, tile)).toBeLessThanOrEqual(
        (radius + tile.radiusMeters) * 1.01,
      );
    }
  });

  it("is a single tile for a 3-mile search", () => {
    const { tiles, truncated } = planTiles(NAMPA, 3 * METERS_PER_MILE);
    expect(truncated).toBe(false);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.lat).toBeCloseTo(NAMPA.lat, 6);
    expect(tiles[0]?.radiusMeters).toBeCloseTo(3 * METERS_PER_MILE, 6);
  });
});
