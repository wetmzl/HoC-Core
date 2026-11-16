import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 320, height: 720 }, { width: 1280, height: 900 }]) {
  test(`启动失败弹窗在 ${viewport.width} 像素下保留原始报错、去掉说明小字且保持可读`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.locator('[data-start-game]')).toBeEnabled();
    const diagnostic = '原始报错：' + '<img src=x onerror="window.__unsafe = true">' + 'TechnicalDiagnostic/'.repeat(150);
    await page.evaluate(async raw => {
      const { showStartupErrorDialog } = await import('/src/startup-error-dialog.ts');
      const { ContentStartupError } = await import('/src/content/packages/startup-error.ts');
      void showStartupErrorDialog(new ContentStartupError(raw, { reason: 'api-version-unsupported', packageId: 'test/new', packageTitle: '测试插件', resourceType: 'plugin.module', apiVersion: 999, supportedApiVersions: [2, 3, 4] }), { onDisableAndRetry: async () => {} });
    }, diagnostic);
    const dialog = page.locator('[data-startup-error]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('pre')).toBeHidden();
    await expect(dialog.locator('summary')).toHaveText('详细报错');
    await expect(dialog.locator('.startup-error-details p')).toHaveCount(0);
    await expect(dialog).not.toContainText('看不懂也没关系');
    await dialog.locator('summary').click();
    await expect(dialog.locator('pre')).toHaveText(diagnostic);
    expect(await page.evaluate(() => (window as any).__unsafe)).toBeUndefined();
    const bounds = await dialog.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const pre = el.querySelector('pre')!;
      const retry = el.querySelector('[data-startup-error-retry]')!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, retryBottom: retry.bottom, font: parseFloat(getComputedStyle(el.querySelector('li')!).fontSize) };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
    expect(bounds.retryBottom).toBeLessThanOrEqual(bounds.height);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
    expect(bounds.font).toBeGreaterThanOrEqual(15);
    await dialog.getByRole('button', { name: '复制报错', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(diagnostic);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
}

test('禁用期间防止重复操作和关闭，禁用失败后保留弹窗与完整诊断', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-start-game]')).toBeEnabled();
  await page.evaluate(async () => {
    const { showStartupErrorDialog } = await import('/src/startup-error-dialog.ts');
    (window as any).__retryCalls = 0;
    void showStartupErrorDialog(new Error('原始启动报错'), { onDisableAndRetry: () => {
      (window as any).__retryCalls++;
      return new Promise<void>((resolve, reject) => { (window as any).__resolveDisable = resolve; (window as any).__rejectDisable = reject; });
    } });
  });
  const dialog = page.locator('[data-startup-error]');
  await dialog.getByRole('button', { name: '禁用相关内容并重试', exact: true }).click();
  await expect(dialog.locator('[data-startup-error-retry]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__retryCalls)).toBe(1);
  await page.evaluate(() => (window as any).__rejectDisable(new Error('至少需要保留一个启用的角色包。')));
  await expect(dialog.getByRole('alert')).toContainText('需要先启用另一个角色包');
  await expect(dialog.locator('[data-startup-error-retry]')).toBeEnabled();
  await dialog.locator('summary').click();
  await expect(dialog.locator('pre')).toContainText('原始启动报错');
  await expect(dialog.locator('pre')).toContainText('禁用失败');
  await dialog.getByRole('button', { name: '禁用相关内容并重试', exact: true }).click();
  await page.evaluate(() => (window as any).__resolveDisable());
  await expect(dialog).toHaveCount(0);
});
