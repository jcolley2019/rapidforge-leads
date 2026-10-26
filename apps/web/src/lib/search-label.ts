/**
 * How a saved search reads back on the Dashboard's recent-searches rows
 * (RFL.SEARCH.CAT.2): the category exactly as typed — a Places type like
 * "plumber" or a phrase like "hvac repair" — then the area.
 */
import type { Search } from "@rapidforge/shared";

type SearchLike = Pick<Search, "category" | "mode" | "params">;

/** "83686 · 5 mi", "43.615, -116.202 · 10 mi", or the mode when neither is set. */
export function searchLocation(search: SearchLike): string {
  const params = search.params as {
    zip?: string;
    lat?: number;
    lng?: number;
    radius_miles?: number;
  };
  const radius = params.radius_miles ? ` · ${params.radius_miles} mi` : "";
  if (params.zip) return `${params.zip}${radius}`;
  if (params.lat !== undefined && params.lng !== undefined) {
    return `${params.lat.toFixed(3)}, ${params.lng.toFixed(3)}${radius}`;
  }
  return search.mode;
}

/** "hvac repair · 83686 · 5 mi" — the whole row title. */
export function searchTitle(search: SearchLike): string {
  return `${search.category} · ${searchLocation(search)}`;
}
