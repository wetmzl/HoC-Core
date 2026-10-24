import { CapacitorContentHostProvider } from "./capacitor-host";
import type { ContentHostProvider } from "./contracts";
import { OpfsContentHostProvider } from "./opfs-host";

export function createDefaultContentHostProviders(
  injected: readonly ContentHostProvider[] = []
): readonly ContentHostProvider[] {
  return Object.freeze([
    ...injected,
    new CapacitorContentHostProvider(),
    new OpfsContentHostProvider()
  ]);
}
