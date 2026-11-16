import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { zipSync } from 'fflate';
import { respondToOfficialPlaylistCopy } from './playlist-fixture';

function fixture(name: string, title: string, type: string, apiVersion: number, raw: string) {
  const body = Buffer.from(raw);
  return zipSync({
    'hocpkg-info.json': Buffer.from(JSON.stringify({
      format: 'house-of-chances-hocpkg', formatVersion: 1,
      identity: { authorId: 'test', packageName: name, version: '1.0.0' },
      metadata: { title, description: '中性重试夹具', tags: [], creators: [{ displayName: 'Test', roles: ['design'] }] },
      resources: [{ id: 'content', type, apiVersion, entry: 'content.json', requires: [] }],
      files: [{ path: 'content.json', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), mediaType: 'application/json' }], extensions: {}
    })),
    'content.json': body
  });
}

test('一次点击只禁用当前问题包，新问题再次弹窗且保留其他已启用内容', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '资源管理', exact: true }).click();
  await page.locator('[data-import-file]').setInputFiles({ name: 'retry.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({
    'first.hocpkg': fixture('first', '问题插件', 'plugin.module', 999, '{}'),
    'second.hocpkg': fixture('second', '问题技能包', 'game.player-skill', 4, '{invalid JSON'),
    'unrelated.hocpkg': fixture('unrelated', '其他内容', 'test.content', 1, '{}')
  })) });
  await page.getByRole('button', { name: '安装所选包' }).click();
  for (const name of ['first', 'second', 'unrelated']) {
    const card = page.locator(`.package-card[data-package-id="test/${name}"]`);
    const official = await page.locator('[data-embedded-default-playlist]').count();
    await card.getByRole('button', { name: '启用', exact: true }).click();
    if (official) await respondToOfficialPlaylistCopy(page, 'confirm');
    await expect(card).toHaveAttribute('data-package-state', 'enabled');
  }
  await page.getByRole('button', { name: '关闭资源管理' }).click();
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  const dialog = page.locator('[data-startup-error]');
  await expect(dialog.locator('.startup-error-package strong')).toHaveText('问题插件');
  await dialog.getByRole('button', { name: '禁用相关内容并重试', exact: true }).click();
  await page.locator('[data-acknowledge-third-party-content]').click();
  await expect(dialog.locator('.startup-error-package strong')).toHaveText('问题技能包');
  await expect(page.locator('.package-card[data-package-id="test/first"]')).toHaveAttribute('data-package-state', 'disabled');
  await expect(page.locator('.package-card[data-package-id="test/second"]')).toHaveAttribute('data-package-state', 'enabled');
  await expect(page.locator('.package-card[data-package-id="test/unrelated"]')).toHaveAttribute('data-package-state', 'enabled');
  await dialog.getByRole('button', { name: '禁用相关内容并重试', exact: true }).click();
  await page.getByRole('button', { name: '我已成年并继续' }).click();
  await expect(page.locator('main.lobby-menu-shell')).toBeVisible();
  await page.locator('[data-exit-launcher]').click();
  await page.getByRole('button', { name: '资源管理', exact: true }).click();
  await expect(page.locator('.package-card[data-package-id="test/first"]')).toHaveAttribute('data-package-state', 'disabled');
  await expect(page.locator('.package-card[data-package-id="test/second"]')).toHaveAttribute('data-package-state', 'disabled');
  await expect(page.locator('.package-card[data-package-id="test/unrelated"]')).toHaveAttribute('data-package-state', 'enabled');
});
