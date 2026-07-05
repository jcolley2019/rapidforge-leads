/**
 * Mode-aware search.params parsing (Sprint 5). zip_radius geocodes a zip to
 * a center; map_draw carries the pin directly. Both share the same filter
 * fields (radius/min_reviews/min_rating/exclude_chains), so Filter's gates
 * work identically for either mode.
 */
import {
  MapDrawParamsSchema,
  ZipRadiusParamsSchema,
  type MapDrawParams,
  type Search,
  type ZipRadiusParams,
} from "@rapidforge/shared";

export type ParsedSearchParams =
  | ({ mode: "zip_radius" } & ZipRadiusParams)
  | ({ mode: "map_draw" } & MapDrawParams);

export function parseSearchParams(
  search: Pick<Search, "mode" | "params">,
): ParsedSearchParams {
  if (search.mode === "map_draw") {
    return { mode: "map_draw", ...MapDrawParamsSchema.parse(search.params) };
  }
  // keyword mode is rejected at the API boundary until v1.5.
  return { mode: "zip_radius", ...ZipRadiusParamsSchema.parse(search.params) };
}
