import { test, expect } from "@playwright/test";
import builtinIndex from "../../public/characters/packages.json" with { type: "json" };

test("direct embedded startup, management and optional complete offline download", async ({ page, context }, testInfo) => {
  test.setTimeout(150000);
  const requests: string[] = [], errors: string[] = [];
  context.on("request", request => requests.push(new URL(request.url()).pathname));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator('[data-start-game]')).toBeEnabled();
  expect(requests.filter(path => path.startsWith('/embedded/') && !path.endsWith('.json'))).toEqual([]);
  expect(requests.some(path => path.endsWith('.hocpkg'))).toBe(false);
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try { const content = await (await root.getDirectoryHandle('content')).getDirectoryHandle('v1'); await content.getDirectoryHandle('revisions'); return true; }
    catch { return false; }
  })).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('01-fresh-launcher.png'), fullPage: true });
  await page.locator('[data-open-packages]').click();
  await expect(page.locator('.embedded-badge')).toHaveCount(builtinIndex.packages.length);
  await expect(page.locator('[data-package-action="remove"]')).toHaveCount(0);
  const packageId = builtinIndex.packages.find(entry => entry.packageId.endsWith('/debug-engine'))!.packageId;
  const card = page.locator(`.package-card[data-package-id="${packageId}"]`);
  await card.locator('[data-package-action="disable"]').click();
  await expect(card).toHaveAttribute('data-package-state', 'disabled');
  await page.screenshot({ path: testInfo.outputPath('02-embedded-management.png'), fullPage: true });
  await page.locator('[data-close-packages]').click();
  await page.reload(); await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.locator('[data-open-packages]').click(); await expect(card).toHaveAttribute('data-package-state', 'disabled');
  await card.locator('[data-package-action="enable"]').click(); await page.locator('[data-close-packages]').click();
  await page.locator('[data-open-offline]').click();
  await expect(page.locator('[data-offline-dialog] [data-offline-download]')).toBeEnabled();
  await page.locator('[data-offline-dialog] [data-offline-download]').click();
  await expect(page.locator('[data-offline-dialog] [data-embedded-offline]')).toHaveAttribute('data-offline-state', 'complete', { timeout: 90000 });
  await page.screenshot({ path: testInfo.outputPath('03-complete-offline.png'), fullPage: true });
  await page.locator('[data-close-offline]').click();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  const cdp = await context.newCDPSession(page); await cdp.send('Network.clearBrowserCache');
  await context.setOffline(true); await page.reload(); await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.locator('[data-start-game]').click();
  await page.locator('[data-acknowledge-adult-content]').click();
  await expect(page.locator('main.lobby-menu-shell')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('04-offline-lobby.png'), fullPage: true });
  await page.locator('[data-enter-duel]').click();
  await page.locator('[data-invite-character]').first().click();
  await page.locator('[data-profile-start]').click();
  await expect(page.locator('main.table-shell')).toBeVisible();
  await expect(page.locator('.player-zone .card')).toHaveCount(2);
  expect(await page.locator('.character-portrait').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('05-offline-table.png'), fullPage: true });
  await page.reload(); await page.locator('[data-start-game]').click();
  await expect(page.locator('main.table-shell')).toBeVisible();
  expect(errors).toEqual([]);
});

test("offline download can cancel, report failure, retry and clear at narrow width", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const state = window as unknown as { offlineTestMode: string };
    state.offlineTestMode = 'slow';
    window.fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      if (path.startsWith('/embedded/') && !path.endsWith('.json')) {
        if (state.offlineTestMode === 'fail') return Promise.resolve(new Response('', { status: 503 }));
        if (state.offlineTestMode === 'slow') return new Promise((_resolve, reject) => {
          const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
          if (init?.signal?.aborted) cancel(); else init?.signal?.addEventListener('abort', cancel, { once: true });
        });
      }
      return original(input, init);
    };
  });
  await page.goto('/'); await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.locator('[data-open-offline]').click();
  const controls = page.locator('[data-offline-dialog] [data-embedded-offline]');
  await expect(controls).toHaveAttribute('data-offline-state', 'idle');
  await controls.locator('[data-offline-download]').click();
  await expect(controls).toHaveAttribute('data-offline-state', 'downloading');
  await page.screenshot({ path: testInfo.outputPath('17-download-progress.png'), fullPage: true });
  await controls.locator('[data-offline-cancel]').click();
  await expect(controls).toHaveAttribute('data-offline-state', 'cancelled');
  await page.screenshot({ path: testInfo.outputPath('18-download-cancelled.png'), fullPage: true });
  await page.evaluate(() => { (window as unknown as { offlineTestMode: string }).offlineTestMode = 'fail'; });
  await controls.locator('[data-offline-download]').click();
  await expect(controls).toHaveAttribute('data-offline-state', 'error');
  await page.screenshot({ path: testInfo.outputPath('19-download-retry.png'), fullPage: true });
  await page.evaluate(() => { (window as unknown as { offlineTestMode: string }).offlineTestMode = ''; });
  await controls.locator('[data-offline-download]').click();
  await expect(controls).toHaveAttribute('data-offline-state', 'complete', { timeout: 90000 });
  await controls.locator('[data-offline-clear]').click();
  await expect(controls).toHaveAttribute('data-offline-state', 'idle');
  await expect(controls.locator('[data-offline-status]')).toContainText('存档、自定义内容和启停状态保留');
  await page.screenshot({ path: testInfo.outputPath('20-cache-cleared.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-close-offline]').click();
  await expect(page.locator('[data-start-game]')).toBeEnabled();
});
