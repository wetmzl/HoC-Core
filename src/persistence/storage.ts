/** Best-effort persistent storage request; unsupported/denied storage never blocks boot. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const persist = globalThis.navigator?.storage?.persist;
    return persist ? await persist.call(globalThis.navigator.storage) : false;
  } catch { return false; }
}
