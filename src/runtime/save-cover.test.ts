import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SAVE_COVER_URL, selectSaveCoverImage } from "./save-cover";

describe("save cover selection", () => {
  it("uses the fixed public card without an optional plugin", async () => {
    const isAvailable = vi.fn(async () => true);
    await expect(selectSaveCoverImage({ isAvailable })).resolves.toBe(DEFAULT_SAVE_COVER_URL);
    expect(isAvailable).toHaveBeenCalledExactlyOnceWith(DEFAULT_SAVE_COVER_URL);
  });

  it("prefers the first available plugin cover to the public card", async () => {
    const isAvailable = vi.fn(async (url: string) => url !== "/extension/missing.png");
    await expect(selectSaveCoverImage({
      loadFeatureCandidates: async () => ["/extension/missing.png", "/extension/cover.png"],
      isAvailable
    })).resolves.toBe("/extension/cover.png");
    expect(isAvailable.mock.calls.map(([url]) => url)).toEqual(["/extension/missing.png", "/extension/cover.png"]);
  });

  it.each([{ candidates: [] }, { candidates: ["/extension/missing.png"] }])("uses the public card when plugin candidates $candidates are unavailable", async ({ candidates }) => {
    await expect(selectSaveCoverImage({
      loadFeatureCandidates: async () => candidates,
      isAvailable: async (url) => url === DEFAULT_SAVE_COVER_URL
    })).resolves.toBe(DEFAULT_SAVE_COVER_URL);
  });

  it("uses the public card if the optional plugin fails", async () => {
    await expect(selectSaveCoverImage({
      loadFeatureCandidates: async () => { throw new Error("feature unavailable"); },
      isAvailable: async (url) => url === DEFAULT_SAVE_COVER_URL
    })).resolves.toBe(DEFAULT_SAVE_COVER_URL);
  });

  it("reports unavailable covers instead of selecting character preview art", async () => {
    await expect(selectSaveCoverImage({ isAvailable: async () => false })).rejects.toThrow("存档封面资源不可用。");
  });
});
