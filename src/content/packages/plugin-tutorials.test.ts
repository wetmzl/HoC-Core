import { afterEach, describe, expect, it, vi } from "vitest";
import { bindPluginTutorialIdentity, getPluginTutorialIdentity, pluginTutorialProgressId, validatePluginTutorialDefinition } from "./plugin-tutorials";

afterEach(() => vi.unstubAllGlobals());
const definition = { id: "first-guide", title: "Guide", pages: [{ body: "A useful explanation." }] };

describe("plugin tutorial declarations", () => {
  it("copies and freezes all queued data and supports each presentation", () => {
    const input = { ...definition, pages: [{ body: "Read this", resources: [{ type: "image", src: "./guide.webp", alt: "Example", caption: "Detail" }] }] };
    const parsed = validatePluginTutorialDefinition(input);
    input.pages[0].body = "Changed";
    input.pages[0].resources[0].src = "javascript:bad()";
    expect(parsed.pages[0].body).toBe("Read this");
    expect(parsed.pages[0].resources?.[0].src).toBe("./guide.webp");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.pages)).toBe(true);
    expect(Object.isFrozen(parsed.pages[0].resources?.[0])).toBe(true);
    for (const presentation of ["popover", "sidebar", "modal"]) {
      expect(validatePluginTutorialDefinition({ ...definition, presentation, autoSkipMs: null }).presentation).toBe(presentation);
    }
  });

  it("rejects empty content, invalid identifiers, extra fields and excessive bounds", () => {
    for (const invalid of [
      { ...definition, id: "adult-content-warning:override" }, { ...definition, title: " " },
      { ...definition, pages: [] }, { ...definition, pages: [{ body: "" }] },
      { ...definition, pages: Array.from({ length: 33 }, () => ({ body: "Too many" })) },
      { ...definition, pages: [{ body: "x".repeat(8_001) }] },
      { ...definition, html: "<script>bad()</script>" }, { ...definition, presentation: "banner" },
      { ...definition, autoSkipMs: 0 }, { ...definition, autoSkipMs: 300_001 },
      { ...definition, autoSkipMs: 1_000.5 }
    ]) expect(() => validatePluginTutorialDefinition(invalid)).toThrow();
  });

  it("allows relative images, HTTP(S), local blobs and raster data while rejecting executable URLs", () => {
    vi.stubGlobal("location", { origin: "https://example.test" });
    const withImage = (src: string) => ({ ...definition, pages: [{ body: "Image", resources: [{ type: "image", src, alt: "Image" }] }] });
    for (const src of ["/assets/image.webp", "../image.png", "https://cdn.test/image.png", "http://cdn.test/image.jpg", "blob:https://example.test/image", "data:image/png;base64,AQID"])
      expect(() => validatePluginTutorialDefinition(withImage(src))).not.toThrow();
    for (const src of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "\nhttps://example.test/image", "file:///image.png", "blob:https://other.test/image", "data:text/html;base64,AQID", "data:image/svg+xml;base64,AQID", "vbscript:bad()"])
      expect(() => validatePluginTutorialDefinition(withImage(src))).toThrow();
    vi.stubGlobal("location", { origin: "capacitor://localhost" });
    expect(() => validatePluginTutorialDefinition(withImage("/assets/image.webp"))).not.toThrow();
  });
});

describe("plugin tutorial ownership", () => {
  it("separates packages and built-in progress without depending on package versions", () => {
    expect(pluginTutorialProgressId("one/guide", "intro")).toBe("plugin:one/guide:intro");
    expect(pluginTutorialProgressId("two/guide", "intro")).not.toBe(pluginTutorialProgressId("one/guide", "intro"));
    expect(pluginTutorialProgressId("one/guide", "adult-content-warning")).not.toBe("adult-content-warning");
    expect(() => pluginTutorialProgressId("one/guide", "../other")).toThrow();
    expect(() => pluginTutorialProgressId(`one/${"a".repeat(120)}`, "intro")).toThrow("128");
  });

  it("accepts only loader-bound ownership and copies metadata away from callers", () => {
    const forged = { packageId: "other/package", apiVersion: 10, mountRuntime() {} };
    expect(getPluginTutorialIdentity(forged)).toBeUndefined();
    const identity = { packageId: "real/package", apiVersion: 10 };
    expect(bindPluginTutorialIdentity(forged, identity)).toBe(forged);
    identity.packageId = "changed/package";
    expect(getPluginTutorialIdentity(forged)).toEqual({ packageId: "real/package", apiVersion: 10 });
    expect(getPluginTutorialIdentity({ ...forged })).toBeUndefined();
  });
});
