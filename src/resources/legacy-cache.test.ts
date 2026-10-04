import { describe, expect, it, vi } from "vitest";
import { LEGACY_RESOURCE_PACK_CACHE_NAME, LEGACY_RESOURCE_PACK_STATUS_KEY, retireLegacyResourcePackCache } from "./legacy-cache";

describe("legacy resource cache retirement", () => {
  it("deletes only the retired pack cache and its obsolete status marker", async () => {
    const removeItem = vi.fn();
    const deleteCache = vi.fn(async () => true);

    await expect(retireLegacyResourcePackCache({ delete: deleteCache }, { removeItem })).resolves.toBe(true);

    expect(deleteCache).toHaveBeenCalledWith(LEGACY_RESOURCE_PACK_CACHE_NAME);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_RESOURCE_PACK_STATUS_KEY);
  });

  it("keeps startup best-effort when Cache Storage is unavailable", async () => {
    await expect(retireLegacyResourcePackCache(undefined, undefined)).resolves.toBe(false);
  });
});
