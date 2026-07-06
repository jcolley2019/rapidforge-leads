/**
 * Pin/circle coupling math (S5.5) — pure so the geometry is testable
 * without Google objects. The component wires these into Maps events.
 */
import {
  clampRadiusMiles,
  metersToMiles,
  milesToMeters,
} from "@/lib/geo";

export interface RadiusSnap {
  /** Clamped, 0.1-step radius in miles — the UI/state value. */
  miles: number;
  /** The exact meters the circle should show for `miles`. */
  meters: number;
  /** True when the circle must be corrected (avoids feedback loops). */
  needsResnap: boolean;
}

/** Resnap tolerance — Google reports sub-meter jitter during handle drags. */
export const RESNAP_TOLERANCE_METERS = 1;

/**
 * A circle radius (from the edge resize handle) → the snapped state.
 * Clamps to the 1–25 mile plan bounds and 0.1-mile steps.
 */
export function snapCircleRadius(rawMeters: number): RadiusSnap {
  const miles = clampRadiusMiles(metersToMiles(rawMeters));
  const meters = milesToMeters(miles);
  return {
    miles,
    meters,
    needsResnap: Math.abs(meters - rawMeters) > RESNAP_TOLERANCE_METERS,
  };
}

/** Slider miles → target circle meters, with the same correction guard. */
export function radiusMilesToCircle(
  miles: number,
  currentCircleMeters: number,
): { meters: number; needsUpdate: boolean } {
  const meters = milesToMeters(clampRadiusMiles(miles));
  return {
    meters,
    needsUpdate:
      Math.abs(meters - currentCircleMeters) > RESNAP_TOLERANCE_METERS,
  };
}
