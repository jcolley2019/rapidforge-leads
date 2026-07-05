/**
 * Geometry helpers for Scout grid tiling (PRD 6.1).
 *
 * Places Nearby Search (New) returns at most 20 results per call, so any
 * area expected to hold more businesses than that must be covered by a
 * grid of smaller "tile" circles whose results are deduped by place_id.
 *
 * All math is pure and unit-tested (Sprint 2 acceptance).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TileCircle extends LatLng {
  radiusMeters: number;
}

export const METERS_PER_MILE = 1609.344;

/** Mean meters per degree of latitude (WGS-84 spherical approximation). */
const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Square-grid spacing factor. With tile radius r and center spacing
 * d = r·√2, every point of the plane is within r of the nearest grid
 * center (worst case is a cell-diagonal half: d·√2/2 = r) — full coverage.
 */
const GRID_SPACING_FACTOR = Math.SQRT2;

/**
 * Cost-discipline backstop (CLAUDE.md Section 8): never fire more Places
 * calls than this per search, no matter the radius. 48 tiles ≈ $1.55 of
 * Nearby Search — flagged in logs if the cap ever truncates coverage.
 */
export const MAX_TILES_PER_SEARCH = 48;

/** Haversine great-circle distance in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000; // mean Earth radius, meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Offset a point by meters east (x) and north (y) — local flat projection. */
export function offsetMeters(origin: LatLng, xMeters: number, yMeters: number): LatLng {
  const lat = origin.lat + yMeters / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLng =
    METERS_PER_DEGREE_LAT * Math.cos((origin.lat * Math.PI) / 180);
  const lng = origin.lng + xMeters / metersPerDegreeLng;
  return { lat, lng };
}

/**
 * Tile radius for a requested search radius — adaptive so small searches
 * stay a single cheap call while 25-mile searches don't explode into
 * hundreds of tiles:
 *   ≤5 km  → one tile (the search itself)
 *   ≤15 km → 5 km tiles
 *   larger → 10 km tiles
 */
export function tileRadiusFor(searchRadiusMeters: number): number {
  if (searchRadiusMeters <= 5_000) return searchRadiusMeters;
  if (searchRadiusMeters <= 15_000) return 5_000;
  return 10_000;
}

/**
 * Grid-center offsets (meters from search center) whose tiles of radius
 * `tileRadiusMeters` fully cover the disk of `searchRadiusMeters`.
 *
 * Square grid with spacing r·√2 guarantees every point is within r of a
 * center; keeping centers within R + r keeps the tile that covers each
 * border point. Ordered center-out so the densest area is fetched first
 * if the tile cap ever truncates.
 */
export function gridTileOffsets(
  searchRadiusMeters: number,
  tileRadiusMeters: number,
): Array<{ xMeters: number; yMeters: number }> {
  if (tileRadiusMeters >= searchRadiusMeters) {
    return [{ xMeters: 0, yMeters: 0 }];
  }

  const spacing = tileRadiusMeters * GRID_SPACING_FACTOR;
  const reach = searchRadiusMeters + tileRadiusMeters;
  const steps = Math.ceil(reach / spacing);

  const offsets: Array<{ xMeters: number; yMeters: number }> = [];
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const xMeters = i * spacing;
      const yMeters = j * spacing;
      if (Math.hypot(xMeters, yMeters) <= reach) {
        offsets.push({ xMeters, yMeters });
      }
    }
  }
  offsets.sort((a, b) => Math.hypot(a.xMeters, a.yMeters) - Math.hypot(b.xMeters, b.yMeters));
  return offsets;
}

export interface TilePlan {
  tiles: TileCircle[];
  /** True when MAX_TILES_PER_SEARCH truncated full coverage (log it). */
  truncated: boolean;
}

/** Concrete tile circles covering the search disk, capped for cost. */
export function planTiles(center: LatLng, searchRadiusMeters: number): TilePlan {
  const tileRadius = tileRadiusFor(searchRadiusMeters);
  const offsets = gridTileOffsets(searchRadiusMeters, tileRadius);
  const truncated = offsets.length > MAX_TILES_PER_SEARCH;
  const tiles = offsets
    .slice(0, MAX_TILES_PER_SEARCH)
    .map(({ xMeters, yMeters }) => ({
      ...offsetMeters(center, xMeters, yMeters),
      radiusMeters: tileRadius,
    }));
  return { tiles, truncated };
}
