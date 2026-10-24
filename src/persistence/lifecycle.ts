import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

/** Adds the native background checkpoint and returns an explicit runtime disposer. */
export async function bindNativePersistenceLifecycle(flush: () => Promise<void>): Promise<() => Promise<void>> {
  if (!Capacitor.isNativePlatform()) return async () => undefined;
  const handle = await App.addListener("pause", () => { void flush(); });
  return async () => { await handle.remove(); };
}
