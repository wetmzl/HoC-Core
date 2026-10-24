export const LEGACY_RESOURCE_PACK_CACHE_NAME = "blackjack-resource-pack-v1";
export const LEGACY_RESOURCE_PACK_STATUS_KEY = "blackjack-resource-pack-status";

export async function retireLegacyResourcePackCache(
  cacheStorage: Pick<CacheStorage, "delete"> | undefined = globalThis.caches,
  storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage
): Promise<boolean> {
  try { storage?.removeItem(LEGACY_RESOURCE_PACK_STATUS_KEY); } catch { /* Storage may be unavailable. */ }
  if (!cacheStorage || typeof cacheStorage.delete !== "function") return false;
  try { return await cacheStorage.delete(LEGACY_RESOURCE_PACK_CACHE_NAME); }
  catch { return false; }
}
