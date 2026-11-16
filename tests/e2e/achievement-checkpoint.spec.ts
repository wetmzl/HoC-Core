import { expect, test } from "@playwright/test";

test("IndexedDB commits gameplay and achievements atomically, preserving the old cursor on failure", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave, createRuntimeSave } = await load("/tests/e2e/runtime-fixture.ts");
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createAchievementCheckpoint } = await load("/src/core/achievements/commit.ts");
    const { createAchievementLedger } = await load("/src/core/achievements/engine.ts");
    const { IndexedDbSaveStorageDriver } = await load("/src/persistence/dexie-repository.ts");
    const { PersistenceService } = await load("/src/persistence/save-service.ts");
    const databaseName = `achievement-checkpoint-${crypto.randomUUID()}`;
    const driver = new IndexedDbSaveStorageDriver(databaseName), repository = new PersistenceService(driver);
    const previous = { longTerm: createDefaultSave(), runtime: createRuntimeSave(createMatch("achievement-storage", { opponentId: "llama" })) };
    await driver.writeSnapshot(previous);
    const legacy = await driver.readSnapshot();
    const achievements = { checkpoint: createAchievementCheckpoint(createAchievementLedger("browser-profile")), gameplay: { historyIndex: 0 } };
    const next = { ...previous, runtime: null, achievements };
    const originalPut = IDBObjectStore.prototype.put;
    let rejected = false, achievementWriteReached = false;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.transaction.db.name === databaseName && this.name === "saves" && (value as { id?: string }).id === "achievements") {
        achievementWriteReached = true;
        throw new DOMException("achievement quota failure", "QuotaExceededError");
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try { await repository.projectSnapshot(() => next); } catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const failed = await driver.readSnapshot();
    await repository.projectSnapshot(() => next);
    await driver.close();
    const reopened = new IndexedDbSaveStorageDriver(databaseName);
    const committed = await reopened.readSnapshot();
    await new PersistenceService(reopened).deleteLongTerm();
    const reset = await reopened.readSnapshot();
    await reopened.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
    return { previous, next, legacy, rejected, achievementWriteReached, failed, committed, reset };
  });
  expect(result.legacy).toEqual(result.previous);
  expect(result.rejected).toBe(true); expect(result.achievementWriteReached).toBe(true);
  expect(result.failed).toEqual(result.previous);
  expect(result.committed).toEqual(result.next);
  expect(result.reset).toEqual({ longTerm: null, runtime: null, achievements: result.next.achievements });
});
