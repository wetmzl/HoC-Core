import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function seed(page: Page) {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createDefaultSave } = await load('/src/persistence/boot.ts');
    const { createPersistenceService } = await load('/src/persistence/factory.ts');
    const save = createDefaultSave(); save.profile.displayName = '原进度'; save.profile.matchesPlayed = 7;
    save.skipTutorial = true; save.tutorialProgress.completedIds.push('adult-content-warning');
    await createPersistenceService().saveLongTerm(save);
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('house-of-chances'); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('saves', 'readwrite'); tx.objectStore('saves').put({ id: 'runtime', data: { marker: 'unfinished' } }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); });
    return save;
  });
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const { IndexedDbSaveStorageDriver } = await import(/* @vite-ignore */ '/src/persistence/dexie-repository.ts');
    return new IndexedDbSaveStorageDriver().readSnapshot();
  });
}
async function open(page: Page) {
  await page.goto('/'); await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.locator('[data-open-launcher-settings]').click();
}

test('launcher import cancels safely, replaces old progress and unfinished game atomically, and exports both formats', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
  await open(page); const original = await seed(page);
  const next = { ...original, profile: { ...original.profile, displayName: '导入验证', matchesPlayed: 17 } };
  const file = { name: 'save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) };
  const before = await snapshot(page);
  await page.locator('[data-launcher-save-file]').setInputFiles(file);
  await expect(page.locator('[data-launcher-import-save]')).toBeDisabled();
  await page.locator('[data-game-dialog-choice="cancel"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('已取消');
  expect(await snapshot(page)).toEqual(before);
  await page.locator('[data-launcher-save-file]').setInputFiles(file);
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('存档已导入');
  expect((await snapshot(page))?.runtime).toBeNull();
  expect((await snapshot(page))?.longTerm).toMatchObject({ profile: { displayName: '导入验证', matchesPlayed: 17 } });
  await page.locator('[data-launcher-export-format]').selectOption('json');
  const jsonDownload = page.waitForEvent('download'); await page.locator('[data-launcher-export-save]').click();
  const exported = JSON.parse(await readFile((await (await jsonDownload).path())!, 'utf8'));
  expect(exported.profile).toMatchObject({ displayName: '导入验证', matchesPlayed: 17 });
  await expect(page.locator('[data-launcher-export-save]')).toBeEnabled();
  await page.locator('[data-launcher-export-format]').selectOption('image');
  const pngDownload = page.waitForEvent('download'); await page.locator('[data-launcher-export-save]').click();
  const png = await readFile((await (await pngDownload).path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  await expect(page.locator('[data-launcher-export-save]')).toBeEnabled();
  await page.locator('[data-launcher-save-file]').setInputFiles({ name: 'image-save.png', mimeType: 'image/png', buffer: png });
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('存档已导入');
  await page.locator('[data-close-launcher-settings]').click();
  await page.locator('[data-start-game]').click();
  await page.addLocatorHandler(page.locator('#tutorial-popover'), async p => { await p.getByRole('button', { name: '跳过', exact: true }).click(); }, { noWaitAfter: true });
  await expect(page.locator('.lobby-menu-shell')).toBeVisible();
  await page.locator('[data-open="settings"]').click();
  await expect(page.locator('[data-setting="soundEnabled"]')).toBeVisible();
  await expect(page.locator('[data-setting="musicVolume"]')).toBeVisible();
  await expect(page.locator('[data-setting="telemetryEnabled"], [data-launcher-telemetry], [data-embedded-offline]')).toHaveCount(0);
  await expect(page.locator('[data-export], [data-import]')).toHaveCount(2);
  await page.locator('[data-export-format]').selectOption('json');
  const inGameDownload = page.waitForEvent('download'); await page.locator('[data-export]').click();
  const inGame = JSON.parse(await readFile((await (await inGameDownload).path())!, 'utf8'));
  expect(inGame.profile).toMatchObject({ displayName: '导入验证', matchesPlayed: 17 });
});

test('failed import transactions and unreadable inputs preserve both original save and runtime', async ({ page }) => {
  await open(page); const original = await seed(page); const before = await snapshot(page);
  await page.locator('[data-launcher-save-file]').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{bad-json') });
  await expect(page.locator('[data-launcher-save-status]')).toContainText('当前存档未被替换');
  await expect(page.locator('[data-launcher-export-original]')).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as any).__restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function (value, key) {
      if (value.id === 'long-term') throw new Error('模拟存档写入失败');
      return put.call(this, value, key);
    };
  });
  const next = { ...original, profile: { ...original.profile, matchesPlayed: 99 } };
  await page.locator('[data-launcher-save-file]').setInputFiles({ name: 'new.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) });
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('模拟存档写入失败');
  expect(await snapshot(page)).toEqual(before);
  await page.evaluate(() => (window as any).__restorePut());
});

test('launcher opt-out survives restart without writing game data or queuing a launch event', async ({ page }) => {
  test.skip(!process.env.VITE_HOC_TELEMETRY_ENDPOINT, 'Needs a configured test telemetry endpoint');
  let requests = 0;
  await page.route('**/v1/events', route => { requests++; return route.abort(); });
  await open(page);
  await expect(page.locator('[data-launcher-telemetry]')).toBeEnabled();
  const before = await snapshot(page);
  const inspect = () => page.evaluate(async () => { const { gameTelemetry } = await import(/* @vite-ignore */ '/src/telemetry/index.ts'); return { enabled: gameTelemetry()!.enabled, count: gameTelemetry()!.pendingCount }; });
  expect(await inspect()).toEqual({ enabled: true, count: 0 }); expect(requests).toBe(0);
  await page.locator('[data-launcher-telemetry]').uncheck();
  await expect(page.locator('[data-telemetry-status]')).toContainText('已保存');
  expect(await snapshot(page)).toEqual(before);
  await page.reload(); await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-launcher-telemetry]')).toBeEnabled();
  await expect(page.locator('[data-launcher-telemetry]')).not.toBeChecked();
  expect(await inspect()).toEqual({ enabled: false, count: 0 }); expect(requests).toBe(0);
});

test('cache management clears only downloadable media while progress and custom files survive', async ({ page }) => {
  await open(page); await seed(page); const before = await snapshot(page);
  await page.evaluate(async () => {
    const { EMBEDDED_MEDIA_CACHE } = await import(/* @vite-ignore */ '/src/resources/embedded-offline.ts');
    await (await caches.open(EMBEDDED_MEDIA_CACHE)).put('/embedded/neutral-cache.bin', new Response('cached media'));
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('neutral-custom-content.txt', { create: true });
    const writable = await file.createWritable(); await writable.write('custom content'); await writable.close();
  });
  await page.locator('[data-open-offline]').click();
  await page.locator('[data-offline-clear]').click();
  await expect(page.locator('[data-offline-status]')).toContainText('已清除内嵌下载缓存');
  expect(await snapshot(page)).toEqual(before);
  const retained = await page.evaluate(async () => {
    const { EMBEDDED_MEDIA_CACHE } = await import(/* @vite-ignore */ '/src/resources/embedded-offline.ts');
    const root = await navigator.storage.getDirectory();
    return { mediaCache: await caches.has(EMBEDDED_MEDIA_CACHE), custom: await (await (await root.getFileHandle('neutral-custom-content.txt')).getFile()).text() };
  });
  expect(retained).toEqual({ mediaCache: false, custom: 'custom content' });
});


test('launcher clear requires confirmation, clears durable progress and collections, and survives restart', async ({ page }, info) => {
  await open(page); await seed(page);
  await page.evaluate(async () => {
    const { IndexedDbSaveStorageDriver } = await import(/* @vite-ignore */ '/src/persistence/dexie-repository.ts');
    const driver = new IndexedDbSaveStorageDriver(); const current = await driver.readSnapshot();
    await driver.writeSnapshot({ ...current!, story: { marker: 'story-progress' }, notebook: { marker: 'character-records' } });
    localStorage.setItem('hoc.core-update.auto-download.v1', 'never');
    const root = await navigator.storage.getDirectory(); const file = await root.getFileHandle('clear-save-content.txt', { create: true });
    const writable = await file.createWritable(); await writable.write('retained content'); await writable.close();
  });
  const before = await snapshot(page);
  await page.locator('[data-launcher-reset-save]').click();
  await expect(page.locator('[data-game-dialog-choice="confirm"]')).toContainText('清空');
  await expect(page.locator('.game-dialog[open]')).toContainText('不会删除未完成牌局');
  await page.screenshot({ path: info.outputPath('launcher-clear-confirm.png') });
  await page.locator('[data-game-dialog-choice="cancel"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('已取消清空');
  expect(await snapshot(page)).toEqual(before);
  await page.locator('[data-launcher-reset-save]').click();
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('长期存档已清空');
  expect(await snapshot(page)).toEqual({ longTerm: null, runtime: before!.runtime });
  await page.reload(); await expect(page.locator('[data-start-game]')).toBeEnabled();
  expect(await snapshot(page)).toEqual({ longTerm: null, runtime: before!.runtime });
  expect(await page.evaluate(async () => ({
    policy: localStorage.getItem('hoc.core-update.auto-download.v1'),
    content: await (await (await (await navigator.storage.getDirectory()).getFileHandle('clear-save-content.txt')).getFile()).text()
  }))).toEqual({ policy: 'never', content: 'retained content' });
  await page.locator('[data-open-launcher-settings]').click();
  await page.locator('[data-launcher-export-save]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('尚无长期存档');
});

test('failed launcher clear keeps the original save and unfinished game and permits retry', async ({ page }) => {
  await open(page); await seed(page); const before = await snapshot(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    (window as any).__restoreDelete = () => { IDBObjectStore.prototype.delete = original; };
    IDBObjectStore.prototype.delete = function(key) {
      if (key === 'long-term') throw new Error('模拟清空失败');
      return original.call(this, key);
    };
  });
  await page.locator('[data-launcher-reset-save]').click(); await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('模拟清空失败');
  expect(await snapshot(page)).toEqual(before);
  await expect(page.locator('[data-launcher-reset-save]')).toBeEnabled();
  await page.evaluate(() => (window as any).__restoreDelete());
  await page.locator('[data-launcher-reset-save]').click(); await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator('[data-launcher-save-status]')).toContainText('长期存档已清空');
});
