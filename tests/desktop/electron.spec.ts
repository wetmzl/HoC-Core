import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { encryptedZip, neutralPackage } from '../fixtures/encrypted-bundles';

function neutralPlugin() {
  const files: Record<string, Buffer> = {
    'module.json': Buffer.from(JSON.stringify({ module: 'module.js', style: 'style.css', provides: [] })),
    'module.js': Buffer.from('export function register() { globalThis.__desktopPluginLoaded = true; return { handlers: [], createRuntime() { return {}; } }; }'),
    'style.css': Buffer.from('/* Neutral desktop import fixture. */')
  };
  const manifest = {
    format: 'house-of-chances-hocpkg', formatVersion: 1,
    identity: { authorId: 'example', packageName: 'desktop-check', version: '1.0.0' },
    metadata: { title: '桌面验证插件', description: '中性导入与模块加载验证', tags: [], creators: [{ displayName: 'Example', roles: ['design'] }] },
    resources: [{ id: 'module', type: 'plugin.module', apiVersion: 2, entry: 'module.json', requires: [] }],
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: path.endsWith('.json') ? 'application/json' : path.endsWith('.js') ? 'text/javascript' : 'text/css' })), extensions: {}
  };
  return Buffer.from(zipSync({ 'hocpkg-info.json': Buffer.from(JSON.stringify(manifest)), ...files }));
}

async function launch(userData: string) {
  const env = { ...process.env, HOC_ELECTRON_USER_DATA_DIR: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [resolve('output/electron/app')], env: { ...env, HOC_ELECTRON_USER_DATA_DIR: join(userData, 'profile') }, timeout: 30_000 });
}

async function startGame(page: Page) {
  await page.locator('[data-start-game]').click();
  await page.addLocatorHandler(page.locator('#third-party-content-warning'), async warning => {
    await warning.locator('[data-acknowledge-third-party-content]').click();
  });
  await page.addLocatorHandler(page.locator('#adult-content-warning'), async warning => {
    await warning.locator('[data-acknowledge-adult-content]').click();
  });
  await page.addLocatorHandler(page.locator('#tutorial-popover'), async tutorial => {
    await tutorial.getByRole('button', { name: '跳过', exact: true }).click();
  }, { noWaitAfter: true });
  await expect(page.locator('main.lobby-menu-shell')).toBeVisible();
}

test('offline desktop boots, imports a plugin, exports a save, and restores both after restart', async ({}, info) => {
  const userData = await mkdtemp(join(tmpdir(), 'hoc-electron-e2e-'));
  let desktop: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    desktop = await launch(userData);
    const page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:\/\//, route => route.abort());
    await expect(page.locator('[data-start-game]')).toBeEnabled();
    expect(page.url()).toBe('hoc://app/');
    const environment = await page.evaluate(async () => ({
      secure: isSecureContext, opfs: Boolean(await navigator.storage.getDirectory()),
      node: typeof (globalThis as any).require, process: typeof (globalThis as any).process,
      sw: Boolean(navigator.serviceWorker?.controller), savePicker: typeof (window as any).showSaveFilePicker
    }));
    expect(environment).toMatchObject({ secure: true, opfs: true, node: 'undefined', process: 'undefined', sw: false });
    await info.attach('environment', { body: JSON.stringify(environment), contentType: 'application/json' });
    await page.locator('[data-open-packages]').click();
    await expect(page.locator('[data-offline-download]')).toHaveCount(0);
    await page.locator('[data-import-file]').setInputFiles({ name: 'desktop-check.hocpkg', mimeType: 'application/zip', buffer: neutralPlugin() });
    await expect(page.locator('[data-import-candidate]')).toHaveCount(1);
    await page.locator('[data-import-next]').click();
    await expect(page.locator('[data-import-dialog]')).toHaveCount(0);
    const plugin = page.locator('.package-card[data-package-id="example/desktop-check"]');
    if (await plugin.getByRole('button', { name: '启用', exact: true }).count()) await plugin.getByRole('button', { name: '启用', exact: true }).click();
    await expect(plugin).toHaveAttribute('data-package-state', 'enabled');
    await page.getByRole('button', { name: '关闭资源管理' }).click();
    await startGame(page);
    expect(await page.evaluate(() => (globalThis as any).__desktopPluginLoaded)).toBe(true);
    await page.locator('[data-open="settings"]').click();
    // The test driver supplies the native save location; the renderer still
    // initiates the actual Blob download, without a test-only export bridge.
    const savePath = info.outputPath('save.png');
    await desktop.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path));
    }, savePath);
    await page.locator('[data-export]').click();
    await expect.poll(async () => (await readFile(savePath).catch(() => Buffer.alloc(0))).length).toBeGreaterThan(1000);
    expect((await readFile(savePath)).subarray(1, 4).toString()).toBe('PNG');
    await page.locator('#save-file').setInputFiles(savePath);
    await expect(page.locator('#settings')).not.toBeVisible();
    const png = await readFile(savePath);
    let exported: any;
    for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
      if (png.toString('ascii', offset + 4, offset + 8) === 'svJS') exported = JSON.parse(png.toString('utf8', offset + 8, offset + 8 + png.readUInt32BE(offset)));
    }
    expect(exported).toBeDefined();
    exported.profile.displayName = '桌面存档验证';
    await page.locator('[data-open="settings"]').click();
    await page.locator('#save-file').setInputFiles({ name: 'desktop-save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await expect(page.locator('#settings')).not.toBeVisible();
    await page.screenshot({ path: info.outputPath('desktop-lobby.png') });
    const profile = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('house-of-chances'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const result = await new Promise<any>((resolve, reject) => {
        const request = db.transaction('saves').objectStore('saves').get('long-term'); request.onsuccess = () => resolve(request.result.data.profile); request.onerror = () => reject(request.error);
      });
      db.close(); return result;
    });
    expect(profile.displayName).toBe('桌面存档验证');
    await desktop.close(); desktop = await launch(userData);
    const restored = await desktop.firstWindow();
    await expect(restored.locator('[data-start-game]')).toBeEnabled();
    await restored.locator('[data-open-packages]').click();
    await expect(restored.locator('.package-card[data-package-id="example/desktop-check"]')).toHaveAttribute('data-package-state', 'enabled');
    await restored.getByRole('button', { name: '关闭资源管理' }).click();
    await startGame(restored);
    expect(await restored.evaluate(() => (globalThis as any).__desktopPluginLoaded)).toBe(true);
    await restored.locator('[data-open="settings"]').click();
    await expect(restored.locator('#settings')).toBeVisible();
    expect(await restored.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('house-of-chances'); request.onsuccess = () => resolve(request.result); });
      const result = await new Promise<any>(resolve => { const request = db.transaction('saves').objectStore('saves').get('long-term'); request.onsuccess = () => resolve(request.result.data.profile); });
      db.close(); return result;
    })).toEqual(profile);
    expect(errors).toEqual([]);
  } finally {
    await desktop?.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('desktop CSP permits encrypted ZIP extraction in the content worker', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'hoc-electron-encrypted-'));
  let desktop: ElectronApplication | undefined;
  try {
    desktop = await launch(userData);
    const page = await desktop.firstWindow();
    await expect(page.locator('[data-start-game]')).toBeEnabled();
    await page.locator('[data-open-packages]').click();
    const bytes = await encryptedZip({ 'encrypted.hocpkg': neutralPackage('desktop-encrypted') }, 'desktop-password', false, 6);
    await page.locator('[data-import-file]').setInputFiles({ name: 'desktop-encrypted.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
    const dialog = page.getByRole('dialog', { name: '解锁加密 ZIP', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.locator('[name="password"]').fill('desktop-password');
    await dialog.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(page.locator('[data-import-candidate]')).toHaveCount(1);
    await page.locator('[data-import-next]').click();
    await expect(page.locator('[data-import-dialog]')).toHaveCount(0);
    await expect(page.locator('.package-card[data-package-id="zip-test/desktop-encrypted"]')).toBeVisible();
  } finally {
    await desktop?.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('restricted updater bridge exposes launcher settings and persists the channel without Node access', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'hoc-electron-update-'));
  let desktop: ElectronApplication | undefined;
  try {
    desktop = await launch(userData);
    let page = await desktop.firstWindow();
    await expect(page.locator('[data-start-game]')).toBeEnabled();
    const status = await page.evaluate(() => (window as any).hocCoreUpdate.getStatus({ channel: 'stable' }));
    expect(status.supported).toBe(false); // Development Electron never installs a public release.
    expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
    await page.locator('[data-open-launcher-settings]').click();
    await page.locator('[data-open-offline]').click();
    await expect(page.locator('[data-offline-dialog]')).toContainText('暂无可清理的下载缓存');
    await expect(page.locator('[data-offline-download]')).toHaveCount(0);
    await page.locator('[data-close-offline]').click();
    await page.locator('[data-core-update-channel]').selectOption('latest');
    await page.locator('[data-close-launcher-settings]').click();
    await page.locator('[data-check-core-update]').click();
    await expect(page.locator('.game-dialog[open]')).toContainText('开发模式');
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await expect(page.evaluate(() => (window as any).hocCoreUpdate.check({ channel: 'nightly' }))).rejects.toThrow('更新通道无效');
    await desktop.close(); desktop = await launch(userData); page = await desktop.firstWindow();
    await expect(page.locator('[data-start-game]')).toBeEnabled();
    await page.locator('[data-open-launcher-settings]').click();
    await expect(page.locator('[data-core-update-channel]')).toHaveValue('latest');
  } finally {
    await desktop?.close(); await rm(userData, { recursive: true, force: true });
  }
});
