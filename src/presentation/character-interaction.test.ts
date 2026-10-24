import { afterEach, expect, it, vi } from "vitest";
import { clearCharacterImages, imageContentBox, prepareCharacterImageHitTest, visibleCharacterImagePoint } from "./character-interaction";
import { normalizedRegionError, regionContains, type NormalizedRegion } from "./regions";
import { validateAuthoringValue } from "../content/packages/authoring-schema";
import { readFileSync } from "node:fs";
afterEach(() => { clearCharacterImages(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function alphaFixture(values = [0, 15, 16, 255]) {
  const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(values.flatMap(alpha => [100, 100, 100, alpha])) }));
  const context = { drawImage: vi.fn(), getImageData };
  vi.stubGlobal("document", { baseURI: "https://example.test/", createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
  vi.stubGlobal("getComputedStyle", () => ({ objectFit: "contain", objectPosition: "50% 50%" }));
  const image = { src: "/first.png", currentSrc: "/first.png", complete: true, naturalWidth: 2, naturalHeight: 2, clientWidth: 200, clientHeight: 200,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 200, right: 210, bottom: 220 }) } as HTMLImageElement;
  return { image, context, getImageData };
}

it("excludes transparent and nearly invisible pixels while including the alpha threshold and image boundary", () => {
  const { image } = alphaFixture();
  prepareCharacterImageHitTest(image);
  expect(visibleCharacterImagePoint(image, 60, 70)).toBeUndefined();
  expect(visibleCharacterImagePoint(image, 160, 70)).toBeUndefined();
  expect(visibleCharacterImagePoint(image, 60, 170)).toEqual({ x: .25, y: .75 });
  expect(visibleCharacterImagePoint(image, 210, 220)).toEqual({ x: 1, y: 1 });
  expect(visibleCharacterImagePoint(image, 211, 170)).toBeUndefined();
});

it("reuses alpha across redraws but reads the new pose and releases cached content", () => {
  const { image, getImageData } = alphaFixture([0, 0, 0, 0]);
  expect(visibleCharacterImagePoint(image, 60, 70)).toBeUndefined();
  expect(visibleCharacterImagePoint({ ...image } as HTMLImageElement, 60, 70)).toBeUndefined();
  expect(getImageData).toHaveBeenCalledTimes(1);
  getImageData.mockReturnValue({ data: new Uint8ClampedArray(Array(4).fill([0, 0, 0, 255]).flat()) });
  Object.assign(image, { src: "/second.png", currentSrc: "/second.png" });
  expect(visibleCharacterImagePoint(image, 60, 70)).toEqual({ x: .25, y: .25 });
  expect(getImageData).toHaveBeenCalledTimes(2);
  clearCharacterImages();
  prepareCharacterImageHitTest(image);
  expect(getImageData).toHaveBeenCalledTimes(3);
});

it("waits for a loaded image and diagnoses unreadable alpha once before using rectangular fallback", () => {
  const { image, getImageData } = alphaFixture();
  Object.assign(image, { complete: false });
  expect(visibleCharacterImagePoint(image, 60, 70)).toBeUndefined();
  expect(getImageData).not.toHaveBeenCalled();
  Object.assign(image, { complete: true });
  getImageData.mockImplementation(() => { throw new Error("tainted canvas"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(visibleCharacterImagePoint(image, 60, 70)).toEqual({ x: .25, y: .25 });
  expect(visibleCharacterImagePoint(image, 60, 70)).toEqual({ x: .25, y: .25 });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(getImageData).toHaveBeenCalledTimes(1);
});
it("maps original content through contain, cover, position and scaling", () => {
  expect(imageContentBox({ left: 10, top: 20, width: 300, height: 200 }, 100, 200, "contain", "50% 100%")).toEqual({ left: 110, top: 20, width: 100, height: 200 });
  expect(imageContentBox({ left: 10, top: 20, width: 600, height: 400 }, 100, 200, "contain", "bottom center", 300, 200)).toEqual({ left: 210, top: 20, width: 200, height: 400 });
  expect(imageContentBox({ left: 0, top: 0, width: 200, height: 100 }, 100, 100, "cover", "50% 50%")).toEqual({ left: 0, top: -50, width: 200, height: 200 });
  expect(imageContentBox({ left: 0, top: 0, width: 100, height: 100 }, 200, 100, "contain", "left top")).toEqual({ left: 0, top: 0, width: 100, height: 50 });
  expect(imageContentBox({ left: 0, top: 0, width: 100, height: 100 }, 0, 0, "contain", "50% 50%")).toBeUndefined();
});
it("includes rectangular and concave polygon boundaries; rejects crossed and degenerate shapes", () => {
  const rect: NormalizedRegion = { shape: "rectangle", x: 0, y: 0, width: .5, height: .5 };
  expect(regionContains(rect, { x: .5, y: .5 })).toBe(true); expect(regionContains(rect, { x: .6, y: .5 })).toBe(false);
  const points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: .5, y: .5 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const polygon: NormalizedRegion = { shape: "polygon", points }; expect(normalizedRegionError(polygon)).toBeUndefined();
  expect(regionContains(polygon, { x: .5, y: .5 })).toBe(true); expect(regionContains(polygon, { x: .8, y: .5 })).toBe(false); expect(regionContains(polygon, { x: 0, y: .5 })).toBe(true);
  expect(normalizedRegionError({ shape: "rectangle", x: .5, y: 0, width: 1, height: 1 })).toContain("越界");
  expect(normalizedRegionError({ shape: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }] })).toBeDefined();
  expect(normalizedRegionError({ shape: "polygon", points: [{ x: 0, y: 0 }, { x: .5, y: .5 }, { x: 1, y: 1 }] })).toBeDefined();
});
it("validates package region data without importing or executing the plugin", () => {
  const schema = JSON.parse(readFileSync("public/characters/character-tap/authoring/regions.schema.json", "utf8"));
  const context = { files: [{ path: "portrait.png", mediaType: "image/png" }], resources: [{ id: "match", type: "game.character-match" }], requires: ["match"] };
  const region = { id: "one", shape: "rectangle", x: 0, y: 0, width: 1, height: 1 };
  const data = (image: string, regions: unknown[]) => ({ characterResourceId: "match", regions: ["one"], images: [{ image, regions }] });
  expect(validateAuthoringValue(schema, data("portrait.png", [region]), context)).toEqual([]);
  for (const bad of [data("../portrait.png", [region]), data("portrait.png", [{ ...region, width: 0 }]), data("portrait.png", [region, region]), data("portrait.png", [{ id: "bad", shape: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }] }])]) expect(validateAuthoringValue(schema, bad, context).length).toBeGreaterThan(0);
});

it("requires declared region IDs and reserves the implicit built-in full-portrait region", () => {
  const schema = JSON.parse(readFileSync("public/characters/character-tap/authoring/regions.schema.json", "utf8"));
  const data = { characterResourceId: "match", regions: ["upper"], images: [{ image: "portrait.png", regions: [{ id: "upper", shape: "rectangle", x: 0, y: 0, width: 1, height: .5 }] }] };
  expect(validateAuthoringValue(schema, data)).toEqual([]);
  expect(validateAuthoringValue(schema, { ...data, regions: [] })).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/images/0/regions/0/id", message: expect.stringContaining("未在 /regions 中声明") })]));
  for (const regions of [["full-portrait"], ["upper", "upper"]]) expect(validateAuthoringValue(schema, { ...data, regions }).length).toBeGreaterThan(0);
  expect(validateAuthoringValue(schema, { characterResourceId: "match", regions: ["upper"], images: [] })).toEqual([]);
});
