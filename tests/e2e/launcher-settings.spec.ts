import { expect, test } from '@playwright/test';

test('manual API rate limits show anonymous release notes as inert text without offering installation', async ({ page }) => {
  const feed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="https://github.com/wetmzl/HoC-Core/releases/tag/v0.3.0-beta.2"/><content type="html">&lt;p&gt;真实格式的发布说明&lt;/p&gt;&lt;p&gt;第二段&lt;img src="https://example.com/unwanted" onerror="window.__notesExecuted=true"&gt;&lt;/p&gt;&lt;script&gt;window.__notesExecuted=true&lt;/script&gt;</content></entry></feed>`;
  const external: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://example.com')) external.push(request.url()); });
  await page.addInitScript(feed => {
    const state = { feeds: 0, installs: 0 };
    (window as any).__notesState = state;
    (window as any).hocCoreUpdate = {
      getStatus: async () => ({ supported: true, currentVersion: '0.2.0-beta2', canInstall: true }),
      check: async () => { throw new Error('GitHub 暂时限制了检查频率，请稍后再试。'); },
      releaseNotes: async () => { state.feeds++; return { feed }; },
      install: async () => { state.installs++; }, download: async () => { state.installs++; }
    };
  }, feed);
  await page.goto('/');
  await expect(page.locator('[data-start-game]')).toBeEnabled();
  await expect(page.locator('.game-dialog[open]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__notesState.feeds)).toBe(0);
  await page.locator('[data-check-core-update]').click();
  const dialog = page.locator('.game-dialog[open]');
  await expect(dialog).toContainText('最近发布日志 · v0.3.0-beta.2');
  await expect(dialog).toContainText('无法确认所选通道的更新');
  await expect(dialog).toContainText('真实格式的发布说明\n\n第二段');
  await expect(dialog.locator('img, script')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '知道了', exact: true })).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: /下载|安装/ })).toHaveCount(0);
  await expect(dialog).not.toContainText('window.__notesExecuted');
  expect(await page.evaluate(() => (window as any).__notesExecuted)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__notesState)).toEqual({ feeds: 1, installs: 0 });
  expect(external).toEqual([]);
  await dialog.getByRole('button', { name: '知道了' }).click();
  await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-core-update-channel]')).toHaveValue('stable');
  const parsed = await page.evaluate(async () => {
    const path = '/src/platform/release-notes.ts';
    const { latestReleaseNotes } = await import(path);
    const entry = (tag: string, host = 'github.com/wetmzl/HoC-Core') => `<entry><link rel="alternate" href="https://${host}/releases/tag/${tag}"/><content type="text">${tag}</content></entry>`;
    const wrap = (text: string) => `<feed xmlns="http://www.w3.org/2005/Atom">${text}</feed>`;
    let invalid = false;
    try { latestReleaseNotes('<!DOCTYPE feed><feed/>'); } catch { invalid = true; }
    return { invalid, unknown: latestReleaseNotes(wrap(entry('v9.0.0', 'example.com'))),
      selected: latestReleaseNotes(wrap(entry('v1.0.0-beta.2') + entry('v1.0.0-beta.10') + entry('v0.1.0'))) };
  });
  expect(parsed).toEqual({ invalid: true, unknown: undefined, selected: { tag: 'v1.0.0-beta.10', notes: 'v1.0.0-beta.10' } });
});

test('launcher settings persist channels, keep missing stable quiet, and guard in-flight checks', async ({ page }, info) => {
  await page.addInitScript(() => {
    const state = { checks: [] as string[], pending: undefined as undefined | (() => void), hold: false };
    (window as any).__updates = state;
    (window as any).hocCoreUpdate = {
      getStatus: async () => ({ supported: true, currentVersion: '0.2.0-beta2', currentVersionCode: 5, canInstall: true }),
      check: async ({ channel }: { channel: string }) => {
        state.checks.push(channel);
        if (state.hold) await new Promise<void>(resolve => { state.pending = resolve; });
        return { state: 'no-release' };
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('[data-start-game]')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__updates.checks)).toEqual(['stable']);
  await expect(page.locator('.game-dialog[open]')).toHaveCount(0);
  await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-core-update-channel]')).toHaveValue('stable');
  await expect(page.locator('[data-launcher-settings] [data-check-core-update]')).toHaveCount(0);
  await page.locator('[data-close-launcher-settings]').click();
  const tools = page.locator('.launcher-tools');
  await expect(tools.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await expect(tools.getByRole('button', { name: '应用更新', exact: true })).toBeVisible();
  await expect(tools.locator('svg')).toHaveCount(2);
  await expect(page.locator('.launcher-actions [data-open-launcher-settings], .launcher-actions [data-check-core-update]')).toHaveCount(0);
  const corner = await tools.boundingBox();
  expect(corner!.y).toBeLessThan(50); expect(corner!.x).toBeGreaterThan(250);
  await page.locator('[data-check-core-update]').click();
  await expect(page.locator('.game-dialog[open]')).toContainText('暂无稳定版');
  await expect(page.locator('.game-dialog[open]')).toContainText('保留当前版本');
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  await page.locator('[data-open-launcher-settings]').click();
  await page.locator('[data-core-update-channel]').selectOption('latest');
  await expect(page.locator('[data-launcher-settings-status]')).toContainText('已保存');
  await page.locator('[data-close-launcher-settings]').click();
  await page.locator('[data-check-core-update]').click();
  await expect(page.locator('.game-dialog[open]')).toContainText('暂无可用发布');
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__updates.checks)).toEqual(['stable', 'stable', 'latest']);
  await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-launcher-settings] .setting-description, #core-update-channel-help')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('launcher-settings-390.png') });
  await page.setViewportSize({ width: 320, height: 720 });
  const metrics = await page.locator('[data-launcher-settings]').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom, overflow: element.scrollWidth > element.clientWidth };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0); expect(metrics.right).toBeLessThanOrEqual(320);
  expect(metrics.bottom).toBeLessThanOrEqual(720); expect(metrics.overflow).toBe(false);
  await page.screenshot({ path: info.outputPath('launcher-settings-320.png') });
  await page.reload(); await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-core-update-channel]')).toHaveValue('latest');
  // A channel switch made while a request is running must suppress its stale reply.
  await page.locator('[data-close-launcher-settings]').click();
  await page.evaluate(() => { (window as any).__updates.hold = true; });
  await page.locator('[data-check-core-update]').click();
  await expect(page.locator('[data-check-core-update]')).toBeDisabled();
  await page.locator('[data-open-launcher-settings]').click();
  await page.locator('[data-core-update-channel]').selectOption('stable');
  await page.evaluate(() => { (window as any).__updates.pending(); });
  await expect(page.locator('[data-check-core-update]')).toBeEnabled();
  await expect(page.locator('[data-check-core-update] svg')).toHaveCount(1);
  await expect(page.locator('.game-dialog[open]')).toHaveCount(0);
});

test('web launcher settings keep offline management accessible without native operations', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-launcher-settings] [data-check-core-update]')).toHaveCount(0);
  await page.locator('[data-open-offline]').click();
  await expect(page.locator('[data-offline-dialog]')).toBeVisible();
  await page.locator('[data-close-offline]').click();
  await expect(page.locator('[data-offline-dialog]')).not.toBeVisible();
  await expect(page.locator('[data-launcher-settings]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-launcher-settings]')).not.toBeVisible();
  await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.locator('[data-check-core-update]').click();
  await expect(page.locator('.game-dialog[open]')).toContainText('网页版本随网站更新');
});

test('downloads silently on Wi-Fi, prompts only when verified, and Update opens the native installer', async ({ page }, info) => {
  await page.addInitScript(() => {
    const release = { version: '1.0.0', tag: 'v1.0.0', bytes: 1024, sha256: 'a'.repeat(64), notes: '<b>更新说明</b>' };
    const state = { installs: 0, ready: false, downloads: 0 };
    (window as any).__updates = state;
    (window as any).hocCoreUpdate = {
      networkStatus: async () => ({ connected: true, wifi: true }),
      getStatus: async () => ({ supported: true, currentVersion: '0.2.0-beta2', currentVersionCode: 5, canInstall: true, ...(state.ready ? { ready: release } : {}) }),
      check: async () => ({ state: 'available', release }),
      download: async () => { state.downloads++; state.ready = true; return release; }, cancel: async () => {},
      install: async () => { state.installs++; return { state: 'manual', message: '已打开下载文件夹，请退出后解压替换。' }; },
      addListener: async () => ({ remove: async () => {} })
    };
  });
  await page.goto('/');
  const dialog = page.locator('.game-dialog[open]');
  await expect(dialog).toContainText('Core 更新已就绪');
  await expect(dialog).toContainText('<b>更新说明</b>');
  await expect(dialog.locator('b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__updates)).toEqual({ installs: 0, ready: true, downloads: 1 });
  await page.screenshot({ path: info.outputPath('update-ready.png') });
  await dialog.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.locator('[data-update-status]')).toContainText('请退出后解压替换');
  expect(await page.evaluate(() => (window as any).__updates.installs)).toBe(1);
  await page.locator('[data-update-close]').click();
  await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-core-auto-download]')).toHaveValue('wifi');
  await page.locator('[data-core-auto-download]').selectOption('never');
  await page.screenshot({ path: info.outputPath('update-settings.png') });
  await page.reload();
  await expect(page.locator('[data-start-game]')).toBeEnabled();
  await expect(page.locator('.game-dialog[open]')).toHaveCount(0);
  await page.locator('[data-open-launcher-settings]').click();
  await expect(page.locator('[data-core-auto-download]')).toHaveValue('never');
  await page.getByRole('button', { name: '手动检查更新', exact: true }).click();
  await expect(dialog).toContainText('发现新版本');
  expect(await page.evaluate(() => (window as any).__updates.downloads)).toBe(0);
  await dialog.getByRole('button', { name: '知道了' }).click();
  await page.getByRole('button', { name: '手动下载更新', exact: true }).click();
  await expect(dialog).toContainText('下载完成');
  expect(await page.evaluate(() => (window as any).__updates.installs)).toBe(0);
  await dialog.getByRole('button', { name: '知道了' }).click();
  await page.getByRole('button', { name: '手动更新', exact: true }).click();
  await expect(page.locator('[data-update-status]')).toContainText('请退出后解压替换');
});
