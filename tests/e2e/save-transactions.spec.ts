import { expect, test } from "@playwright/test";

test("IndexedDB rolls back a continued result when its runtime write fails", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { IndexedDbSaveStorageDriver } = await load("/src/persistence/dexie-repository.ts");
    const { PersistenceService } = await load("/src/persistence/save-service.ts");
    const databaseName = `continued-result-${crypto.randomUUID()}`;
    const driver = new IndexedDbSaveStorageDriver(databaseName);
    const repository = new PersistenceService(driver);
    const previous = {
      longTerm: createDefaultSave(),
      runtime: createRuntimeSave(createMatch("previous-runtime", { opponentId: "chatgpt" }))
    };
    const next = {
      longTerm: { ...previous.longTerm, profile: { ...previous.longTerm.profile, matchesPlayed: 1 } },
      runtime: createRuntimeSave(createMatch("continued-runtime", { opponentId: "llama" }))
    };
    await driver.writeSnapshot(previous);
    const originalPut = IDBObjectStore.prototype.put;
    let rejected = false, runtimeWriteReached = false;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.transaction.db.name === databaseName && this.name === "saves" && (value as { id?: string }).id === "runtime") {
        runtimeWriteReached = true;
        throw new DOMException("runtime quota failure", "QuotaExceededError");
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try { await repository.commitMatchResult(next.longTerm, next.runtime); }
    catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const failed = await driver.readSnapshot();
    await repository.commitMatchResult(next.longTerm, next.runtime);
    await driver.close();
    const reopened = new IndexedDbSaveStorageDriver(databaseName);
    const committed = await reopened.readSnapshot();
    await new PersistenceService(reopened).commitMatchResult(next.longTerm);
    const finished = await reopened.readSnapshot();
    await reopened.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    });
    return { previous, next, rejected, runtimeWriteReached, failed, committed, finished };
  });
  expect(result.rejected).toBe(true);
  expect(result.runtimeWriteReached).toBe(true);
  expect(result.failed).toEqual(result.previous);
  expect(result.committed).toEqual(result.next);
  expect(result.finished).toEqual({ ...result.next, runtime: null });
});
