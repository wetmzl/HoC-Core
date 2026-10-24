import { describe, expect, it } from "vitest";
import { dampedDrawerPosition, drawerStops, nearestDrawerStop } from "./detent-drawer";

describe("measured drawer stops", () => {
  it("accepts finite ordered content boundaries and merges subpixel duplicates", () => {
    expect(drawerStops([130, NaN, 0, 64, 64.25, Infinity])).toEqual([0, 64, 130]);
  });
  it("chooses the closest complete content without projecting fling velocity", () => {
    const stops = [0, 64, 130];
    expect(nearestDrawerStop(30, stops)).toBe(0);
    expect(nearestDrawerStop(36, stops)).toBe(64);
    expect(nearestDrawerStop(105, stops)).toBe(130);
    expect(nearestDrawerStop(-1000, stops)).toBe(0);
    expect(nearestDrawerStop(1000, stops)).toBe(130);
  });
  it("tracks inside the limits and progressively resists overscroll at both ends", () => {
    expect(dampedDrawerPosition(64, 0, 130)).toBe(64);
    const lower = dampedDrawerPosition(-80, 0, 130);
    const upper = dampedDrawerPosition(210, 0, 130);
    expect(lower).toBeLessThan(0);
    expect(lower).toBeGreaterThan(-26);
    expect(upper - 130).toBeCloseTo(-lower);
    expect(dampedDrawerPosition(10000, 0, 130)).toBeLessThan(156);
  });
});
