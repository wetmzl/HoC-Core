import { describe, expect, it, vi } from "vitest";
import { selectSaveCoverImage } from "./save-cover";

describe("save cover selection", () => {
  it("falls back to character base art when feature candidates are unavailable", async () => {
    const isAvailable = vi.fn(async (url: string) => url === "/characters/example-character/preview.png");
    await expect(selectSaveCoverImage({
      loadFeatureCandidates: async () => ["/characters/example-character/extension-cover.png"],
      baseCandidates: ["/characters/example-character/preview.png", "/assets/fallback.png"],
      isAvailable
    })).resolves.toBe("/characters/example-character/preview.png");
    expect(isAvailable.mock.calls.map(([url]) => url)).toEqual([
      "/characters/example-character/extension-cover.png",
      "/characters/example-character/preview.png"
    ]);
  });

  it("does not require the optional extension", async () => {
    await expect(selectSaveCoverImage({
      loadFeatureCandidates: async () => { throw new Error("feature unavailable"); },
      baseCandidates: ["/characters/another-character/preview.png"],
      isAvailable: async () => true
    })).resolves.toBe("/characters/another-character/preview.png");
  });
});
