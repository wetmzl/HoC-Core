import { Capacitor } from "@capacitor/core";
import { CapacitorFileSaveStorageDriver, LegacyCopyingSaveStorageDriver } from "./capacitor-driver";
import { IndexedDbSaveStorageDriver } from "./dexie-repository";
import { PersistenceService } from "./save-service";

export function createPersistenceService(): PersistenceService {
  const webDriver = new IndexedDbSaveStorageDriver();
  if (!Capacitor.isNativePlatform()) return new PersistenceService(webDriver);
  return new PersistenceService(new LegacyCopyingSaveStorageDriver(
    new CapacitorFileSaveStorageDriver(),
    webDriver
  ));
}
