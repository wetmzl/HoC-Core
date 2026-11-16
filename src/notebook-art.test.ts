import { describe, expect, it } from "vitest";
import { notebookAlphaBounds, notebookArtLayout } from "./notebook-art";

describe("notebook artwork viewport", () => {
  it("keeps faint edge pixels and clamps the safety margin to the original canvas", () => {
    const rgba = new Uint8ClampedArray(6 * 5 * 4);
    rgba[(1 * 6 + 2) * 4 + 3] = 1;
    rgba[(3 * 6 + 3) * 4 + 3] = 255;
    expect(notebookAlphaBounds(rgba, 6, 5, 1)).toEqual({ x: 1, y: 0, width: 4, height: 5 });
    expect(notebookAlphaBounds(new Uint8ClampedArray(24), 3, 2)).toBeNull();
    expect(notebookAlphaBounds([], 3, 2)).toBeNull();
  });

  it("enlarges the actual silhouette beyond whole-canvas contain without cutting any of its bounds", () => {
    const bounds = { x: 195, y: 0, width: 806, height: 768 };
    const result = notebookArtLayout(1152, 768, bounds, 290, 700);
    const oldScale = 290 / 1152;
    expect(result.scale / oldScale).toBeGreaterThan(1.3);
    expect(result.left + bounds.x * result.scale).toBeCloseTo(8);
    expect(result.left + (bounds.x + bounds.width) * result.scale).toBeCloseTo(282);
    expect(result.top + bounds.y * result.scale).toBeGreaterThanOrEqual(7.99);
    expect(result.top + (bounds.y + bounds.height) * result.scale).toBeLessThanOrEqual(result.frameHeight - 7.99);
    expect(result.width / result.height).toBeCloseTo(1152 / 768);
    expect(result.frameHeight).toBeLessThan(300);
  });

  it("limits tall artwork to the viewport height while keeping the whole contour centered", () => {
    const bounds = { x: 200, y: 100, width: 900, height: 2000 };
    const result = notebookArtLayout(1600, 2200, bounds, 400, 560);
    expect(result.frameHeight).toBe(560);
    expect(result.top + bounds.y * result.scale).toBeCloseTo(8);
    expect(result.top + (bounds.y + bounds.height) * result.scale).toBeCloseTo(552);
    const left = result.left + bounds.x * result.scale, right = result.left + (bounds.x + bounds.width) * result.scale;
    expect(left).toBeGreaterThanOrEqual(8); expect(right).toBeLessThanOrEqual(392);
    expect((left + right) / 2).toBeCloseTo(200);
  });
});
