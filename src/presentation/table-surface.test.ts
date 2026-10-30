import { afterEach, expect, it, vi } from "vitest";
import { mountTableSurface, tablePortraitGeometry } from "./table-surface";
import { tablePortraitPlacement } from "../content/characters/table-portrait";

afterEach(() => vi.unstubAllGlobals());

it("uses the original image content, including contain letterboxing and portrait scale", () => {
  const landscape = { width: 224, height: 260, naturalWidth: 1152, naturalHeight: 768, fit: "contain", position: "bottom center", scale: 1 };
  expect(tablePortraitGeometry(landscape, { anchorY: 1 })?.offsetY).toBeCloseTo(0);
  expect(tablePortraitGeometry(landscape, { anchorY: .85 })?.offsetY).toBeCloseTo(22.4);
  expect(tablePortraitGeometry({ ...landscape, scale: 1.5 }, { anchorY: .85 })?.offsetY).toBeCloseTo(33.6);
  expect(tablePortraitGeometry({ ...landscape, naturalWidth: 768, naturalHeight: 1152 }, { anchorY: .9 })?.offsetY).toBeCloseTo(26);
  expect(tablePortraitGeometry(landscape, { anchorY: 1, offsetX: -.06 })?.offsetX).toBeCloseTo(-13.44);
  expect(tablePortraitGeometry({ ...landscape, scale: 1.5 }, { anchorY: 1, offsetX: -.06 })?.offsetX).toBeCloseTo(-20.16);
  expect(tablePortraitGeometry({ ...landscape, naturalWidth: 768, naturalHeight: 1152 }, { anchorY: 1, offsetX: .1 })?.offsetX).toBeCloseTo(17.333333);
  expect(tablePortraitGeometry({ ...landscape, naturalWidth: 0 }, { anchorY: .9 })).toBeUndefined();
});

it("inherits the role default and resolves relative, absolute and host-managed image overrides", () => {
  const presentation = { anchorY: .95, offsetX: -.06, images: [{ image: "/art/tap.webp", anchorY: .85 }, { image: "blob:pose", anchorY: .9, offsetX: 0 }] };
  expect(tablePortraitPlacement(undefined, "/art/base.webp")).toEqual({ anchorY: 1, offsetX: 0 });
  expect(tablePortraitPlacement(presentation, "/art/base.webp").offsetX).toBe(-.06);
  expect(tablePortraitPlacement(presentation, "/art/tap.webp").offsetX).toBe(-.06);
  expect(tablePortraitPlacement(presentation, "blob:pose").offsetX).toBe(0);
  expect(tablePortraitPlacement(presentation, "/art/base.webp").anchorY).toBe(.95);
  expect(tablePortraitPlacement(presentation, "https://example.test/art/tap.webp", "https://example.test/").anchorY).toBe(.85);
  expect(tablePortraitPlacement(presentation, "blob:pose").anchorY).toBe(.9);
});

it("keeps the tabletop fixed across direct src swaps, scale, loading and resize; disposes listeners", () => {
  const makeStyle = () => {
    const values = new Map<string, string>();
    return { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key), getPropertyValue: (key: string) => values.get(key) ?? "" };
  };
  const element = (bounds: Record<string, number>) => ({ style: makeStyle(), getBoundingClientRect: () => bounds });
  const shell = element({ left: 0, width: 390 });
  const bottom = element({ top: 500, left: 16 });
  const strip = element({ bottom: 508 });
  const hand = element({ bottom: 720 });
  const portrait = Object.assign(new EventTarget(), { clientWidth: 300, clientHeight: 260, naturalWidth: 1152, naturalHeight: 768,
    currentSrc: "https://example.test/base.png", src: "https://example.test/base.png", ownerDocument: { baseURI: "https://example.test/" } });
  let scale = 1;
  vi.stubGlobal("getComputedStyle", () => ({ objectFit: "contain", objectPosition: "bottom center",
    getPropertyValue: (key: string) => key === "--character-art-scale" ? String(scale) : key === "--table-art-rest-bottom" ? "18px" : "" }));
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect = disconnect; });
  const elements: Record<string, unknown> = { ".table-playing": shell, ".table-bottom": bottom, ".character-strip": strip, ".character-portrait": portrait, ".player-zone .hand-row": hand };
  const mounted = mountTableSurface({ querySelector: (selector: string) => elements[selector] } as HTMLElement, { anchorY: .9, offsetX: -.06, images: [{ image: "/thinking.png", anchorY: .8 }] });
  const offset = () => parseFloat(strip.style.getPropertyValue("--table-art-anchor-offset"));
  const tableTop = () => bottom.style.getPropertyValue("--table-surface-top");
  expect(offset()).toBeCloseTo(20);
  expect(parseFloat(strip.style.getPropertyValue("--table-art-offset-x"))).toBeCloseTo(-18);
  expect(tableTop()).toBe("-10px");
  // The previous image remains displayed while the new thinking art is loading.
  portrait.src = "https://example.test/thinking.png";
  resize();
  expect(offset()).toBeCloseTo(20);
  portrait.currentSrc = portrait.src;
  portrait.dispatchEvent(new Event("load"));
  expect(offset()).toBeCloseTo(40);
  expect(tableTop()).toBe("-10px");
  scale = 1.5;
  resize();
  expect(offset()).toBeCloseTo(60);
  expect(tableTop()).toBe("-10px");
  portrait.clientWidth = 224;
  resize();
  expect(offset()).toBeCloseTo(44.8);
  expect(parseFloat(strip.style.getPropertyValue("--table-art-offset-x"))).toBeCloseTo(-20.16);
  expect(tableTop()).toBe("-10px");
  mounted.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(strip.style.getPropertyValue("--table-art-offset-x")).toBe("");
  expect(strip.style.getPropertyValue("--table-art-anchor-offset")).toBe("");
  portrait.dispatchEvent(new Event("load"));
  expect(strip.style.getPropertyValue("--table-art-anchor-offset")).toBe("");
});
