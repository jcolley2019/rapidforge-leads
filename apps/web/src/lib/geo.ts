/**
 * Map-tab geometry + cost estimation (Sprint 5). Pure functions — the
 * radius→search-params conversion is acceptance-tested.
 */
import {
  MapDrawParamsSchema,
  type MapDrawParams,
} from "@rapidforge/shared";

export const METERS_PER_MILE = 1609.344;

export const MIN_RADIUS_MILES = 1;
export const MAX_RADIUS_MILES = 25;

export interface LatLng {
  lat: number;
  lng: number;
}

export function milesToMeters(miles: number): number {
  return miles * METERS_PER_MILE;
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}

/** Clamp to the plan limits (PRD 5.1 max_radius_miles), 0.1-mile steps. */
export function clampRadiusMiles(miles: number): number {
  const clamped = Math.min(MAX_RADIUS_MILES, Math.max(MIN_RADIUS_MILES, miles));
  return Math.round(clamped * 10) / 10;
}

/**
 * Rough Nearby-call count for the cost hint — mirrors the worker's tile
 * bands (1 tile ≤5km, 9 ≤15km, 30 beyond). Shared by both search tabs.
 */
export function estimatePlacesCalls(radiusMiles: number): number {
  if (radiusMiles <= 3.1) return 1;
  if (radiusMiles <= 9.3) return 9;
  return 30;
}

/** Nearby ($0.032/call) — the UI hint only; real spend logs to usage_events. */
export function estimateSearchCostCents(radiusMiles: number): number {
  return Math.round(estimatePlacesCalls(radiusMiles) * 3.2);
}

export interface SearchFilters {
  min_reviews: number;
  min_rating: number;
  exclude_chains: boolean;
}

/**
 * Pin + radius + filters → validated map_draw params (the exact body of
 * POST /api/searches). Coordinates round to 6 dp (~11cm) so params stay
 * stable across marker jitter; radius clamps to 1–25 mi.
 */
export function mapSelectionToParams(
  pin: LatLng,
  radiusMiles: number,
  filters: SearchFilters,
): MapDrawParams {
  return MapDrawParamsSchema.parse({
    lat: Math.round(pin.lat * 1e6) / 1e6,
    lng: Math.round(pin.lng * 1e6) / 1e6,
    radius_miles: clampRadiusMiles(radiusMiles),
    min_reviews: filters.min_reviews,
    min_rating: filters.min_rating,
    exclude_chains: filters.exclude_chains,
  });
}
