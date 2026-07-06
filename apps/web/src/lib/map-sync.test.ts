import { describe, expect, it } from "vitest";
import { METERS_PER_MILE } from "./geo";
import { radiusMilesToCircle, snapCircleRadius } from "./map-sync";

describe("snapCircleRadius (edge handle → state)", () => {
  it("passes an exact on-step radius through without resnap", () => {
    const snap = snapCircleRadius(10 * METERS_PER_MILE);
    expect(snap.miles).toBe(10);
    expect(snap.needsResnap).toBe(false);
  });

  it("snaps to 0.1-mile steps and flags the correction", () => {
    const snap = snapCircleRadius(10.234 * METERS_PER_MILE);
    expect(snap.miles).toBe(10.2);
    expect(snap.meters).toBeCloseTo(10.2 * METERS_PER_MILE, 6);
    expect(snap.needsResnap).toBe(true);
  });

  it("clamps a handle dragged past 25 miles back to the plan cap", () => {
    const snap = snapCircleRadius(40 * METERS_PER_MILE);
    expect(snap.miles).toBe(25);
    expect(snap.needsResnap).toBe(true);
  });

  it("clamps a pinched handle up to the 1-mile floor", () => {
    const snap = snapCircleRadius(200); // ~0.12 mi
    expect(snap.miles).toBe(1);
    expect(snap.meters).toBeCloseTo(METERS_PER_MILE, 6);
    expect(snap.needsResnap).toBe(true);
  });

  it("ignores sub-meter jitter (no feedback loop)", () => {
    const snap = snapCircleRadius(10 * METERS_PER_MILE + 0.5);
    expect(snap.miles).toBe(10);
    expect(snap.needsResnap).toBe(false);
  });
});

describe("radiusMilesToCircle (slider → circle)", () => {
  it("updates the circle when the slider moves", () => {
    const r = radiusMilesToCircle(8, 5 * METERS_PER_MILE);
    expect(r.meters).toBeCloseTo(8 * METERS_PER_MILE, 6);
    expect(r.needsUpdate).toBe(true);
  });

  it("does not touch a circle already at the target", () => {
    const r = radiusMilesToCircle(8, 8 * METERS_PER_MILE + 0.4);
    expect(r.needsUpdate).toBe(false);
  });

  it("clamps slider input to plan bounds", () => {
    expect(radiusMilesToCircle(90, 0).meters).toBeCloseTo(
      25 * METERS_PER_MILE,
      6,
    );
  });
});
