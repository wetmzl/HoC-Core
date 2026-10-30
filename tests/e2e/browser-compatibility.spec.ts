import { expect, test, type Page } from '@playwright/test';

// Emulate UA/capability combinations in the installed Chromium. These tests
// verify startup policy and the escape path, not historical-engine support.
const chromeUA = (version: number, webview = false) =>
  `Mozilla/5.0 (Linux; Android 10; Test Device${webview ? '; wv' : ''}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;
const iosUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/107.0.0.0 Mobile/15E148 Safari/604.1';
const continueName = '跳过提醒，尝试进入';
type MissingFoundation = 'modules' | 'fetch' | 'promise' | 'storage' | 'digest';

async function environment(page: Page, options: { ua?: string; missing?: MissingFoundation; insecure?: boolean; optionalMissing?: boolean; cssMissing?: boolean } = {}) {
  await page.addInitScript(({ ua, missing, insecure, optionalMissing, cssMissing }) => {
    if (ua) Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
    if (insecure) Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    if (missing === 'modules') Reflect.deleteProperty(HTMLScriptElement.prototype, 'noModule');
    if (missing === 'fetch') Object.defineProperty(window, 'fetch', { configurable: true, value: undefined });
    if (missing === 'promise') Object.defineProperty(window, 'Promise', { configurable: true, value: undefined });
    if (missing === 'storage') Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: undefined });
    if (missing === 'digest') Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: undefined });
    if (cssMissing) CSS.supports = () => false;
    if (optionalMissing) {
      for (const name of ['structuredClone', 'ResizeObserver', 'AbortController']) Object.defineProperty(window, name, { configurable: true, value: undefined });
      for (const [owner, name] of [[Array.prototype, 'at'], [Object, 'hasOwn'], [crypto, 'randomUUID'], [HTMLDialogElement.prototype, 'showModal'], [FileSystemFileHandle.prototype, 'createWritable']] as const) {
        Object.defineProperty(owner, name, { configurable: true, value: undefined });
      }
    }
  }, options);
}

// Use a neutral module when testing only the startup decision. Missing optional
// APIs may still affect individual game features; bypassing is not a polyfill.
const stubBody = 'window.__startupCount = (window.__startupCount || 0) + 1; document.getElementById("app").textContent = "startup reached " + window.__startupCount;';
async function stubGame(page: Page) {
  const requests: string[] = [];
  await page.route('**/src/main.ts', route => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: 'text/javascript', body: stubBody });
  });
  return requests;
}
async function expectStartedOnce(page: Page, requests: string[]) {
  await expect(page.locator('#app')).toHaveText('startup reached 1');
  await expect(page.locator('#compatibility-notice')).toBeHidden();
  expect(requests).toHaveLength(1);
}

function gameRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/src/main.ts' || path.startsWith('/characters/')) requests.push(path);
  });
  return requests;
}

test('an old WebView UA and missing CSS features no longer stop the launcher', async ({ page }) => {
  await environment(page, { ua: chromeUA(107, true), cssMissing: true });
  await page.goto('/');
  await expect(page.locator('#compatibility-notice')).toBeHidden();
  await expect(page.locator('main.launcher-shell')).toBeVisible();
});

test('missing auxiliary APIs no longer trigger a compatibility gate', async ({ page }) => {
  await environment(page, { ua: chromeUA(80, true), optionalMissing: true, cssMissing: true });
  const requests = await stubGame(page);
  await page.goto('/');
  await expectStartedOnce(page, requests);
});

test('a current browser still completes the normal content installation', async ({ page }) => {
  await environment(page, { ua: chromeUA(156) });
  await page.goto('/');
  await expect(page.locator('#compatibility-notice')).toBeHidden();
  await expect(page.getByRole('button', { name: '开始游戏', exact: true })).toBeEnabled({ timeout: 45_000 });
});

for (const ua of ['UnidentifiedBrowser/1.0', iosUA]) {
  test(`UA alone does not block startup: ${ua.slice(0, 30)}`, async ({ page }) => {
    await environment(page, { ua });
    const requests = await stubGame(page);
    await page.goto('/');
    await expectStartedOnce(page, requests);
  });
}

for (const [missing, label] of [
  ['modules', 'JavaScript 模块'], ['fetch', '基础网络能力'], ['promise', '基础网络能力'],
  ['storage', '本地内容目录'], ['digest', '内容数据校验']
] as const) {
  test(`a missing ${missing} foundation warns but can be bypassed exactly once`, async ({ page }) => {
    await environment(page, { ua: 'UnidentifiedBrowser/1.0', missing });
    const requests = await stubGame(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '请更新浏览器' })).toBeVisible();
    await expect(page.locator('#compatibility-detail')).toContainText(label);
    expect(requests).toEqual([]);
    // Dispatch repeated user clicks in one task to exercise the startup latch.
    await page.locator('#compatibility-continue').evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expectStartedOnce(page, requests);
  });
}

test('skipping before the bootstrap arrives still starts the game once', async ({ page }) => {
  await environment(page, { missing: 'digest' });
  const requests = await stubGame(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/src/bootstrap.ts', async route => { await pending; await route.continue(); });
  await page.goto('/', { waitUntil: 'commit' });
  try {
    await expect(page.getByRole('heading', { name: '请更新浏览器' })).toBeVisible();
    await page.getByRole('button', { name: continueName }).click();
    await expect(page.getByRole('heading', { name: '正在尝试进入游戏' })).toBeVisible();
    expect(requests).toEqual([]);
  } finally {
    release();
  }
  await expectStartedOnce(page, requests);
});

test('native loading errors do not diagnose an old version from UA or CSS alone', async ({ page }) => {
  await environment(page, { ua: chromeUA(80, true), cssMissing: true, missing: 'storage' });
  await page.goto('/browser-update.html');
  await expect(page.getByRole('heading', { name: '游戏页面未能加载' })).toBeVisible();
  await expect(page.locator('#compatibility-detail')).not.toContainText('缺少');
});

test('native-page bypass reaches the entry once without persisting or looping', async ({ page }) => {
  await environment(page, { ua: chromeUA(80, true), missing: 'digest' });
  const requests = await stubGame(page);
  await page.goto('/browser-update.html');
  await expect(page.getByRole('heading', { name: '请更新系统网页组件' })).toBeVisible();
  await page.getByRole('button', { name: continueName }).click();
  await expectStartedOnce(page, requests);
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.reload();
  await expect(page.getByRole('heading', { name: '请更新系统网页组件' })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('a one-attempt bypass removes only its own parameter and is rechecked on reload', async ({ page }) => {
  await environment(page, { missing: 'digest' });
  const requests = await stubGame(page);
  await page.goto('/?example=keep&hoc-try-anyway=1#anchor');
  await expectStartedOnce(page, requests);
  await expect(page).toHaveURL(/\/?\?example=keep#anchor$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: '请更新浏览器' })).toBeVisible();
  expect(requests).toHaveLength(1);
});

for (const module of ['main', 'bootstrap']) {
  test(`a failed ${module} load can retry through a fresh document`, async ({ page }) => {
    let attempts = 0;
    if (module === 'bootstrap') await stubGame(page);
    await page.route(`**/src/${module}.ts`, route => {
      attempts++;
      if (attempts === 1) return route.abort('failed');
      return module === 'main' ? route.fulfill({ contentType: 'text/javascript', body: stubBody }) : route.continue();
    });
    await page.goto('/?example=keep#anchor');
    await expect(page.getByRole('heading', { name: '游戏页面未能加载' })).toBeVisible();
    await expect(page.locator('#compatibility-message')).toContainText('检查网络');
    await page.getByRole('button', { name: continueName }).click();
    await expect(page.locator('#app')).toHaveText('startup reached 1');
    await expect(page.locator('#compatibility-notice')).toBeHidden();
    await expect(page).toHaveURL(/\/?\?example=keep#anchor$/);
    expect(attempts).toBe(2);
  });
}

test('a failed entry preserves the foundation warning and can still retry after skipping', async ({ page }) => {
  await environment(page, { ua: chromeUA(107, true), missing: 'digest' });
  const requests = await stubGame(page);
  let attempts = 0;
  await page.route('**/src/bootstrap.ts', route => ++attempts === 1 ? route.abort('failed') : route.continue());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '请更新系统网页组件' })).toBeVisible();
  await page.getByRole('button', { name: continueName }).click();
  await expectStartedOnce(page, requests);
  expect(attempts).toBe(2);
});

test('HTTPS guidance is distinct from outdated-browser guidance and remains bypassable', async ({ page }) => {
  await environment(page, { insecure: true, missing: 'storage' });
  const requests = await stubGame(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '请通过安全地址打开游戏' })).toBeVisible();
  await expect(page.locator('#compatibility-help')).toContainText('HTTPS');
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: continueName }).click();
  await expectStartedOnce(page, requests);
});

test('an iOS storage warning keeps its system-update guidance', async ({ page }) => {
  await environment(page, { ua: iosUA, missing: 'storage' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '请更新浏览器' })).toBeVisible();
  await expect(page.locator('#compatibility-help')).toContainText('iOS / iPadOS 更新');
  await expect(page.locator('#compatibility-detail')).not.toContainText('Chromium');
});

test('a native app does not require browser-only storage APIs', async ({ page }) => {
  await environment(page, { ua: chromeUA(80, true), missing: 'storage' });
  await page.addInitScript(() => Object.defineProperty(window, 'Capacitor', { value: { isNativePlatform: () => true } }));
  const requests = await stubGame(page);
  await page.goto('/');
  await expectStartedOnce(page, requests);
});

test('a narrow foundation warning keeps both actions reachable and diagnostics expandable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await environment(page, { ua: chromeUA(107, true), missing: 'digest' });
  const requests = gameRequests(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '请更新系统网页组件' })).toBeVisible();
  await expect(page.locator('#compatibility-help')).toContainText('无需卸载游戏或清除游戏数据');
  await expect(page.locator('#compatibility-detail')).toBeHidden();
  await page.locator('#compatibility-diagnostics summary').click();
  await expect(page.locator('#compatibility-detail')).toBeVisible();
  for (const name of [continueName, '重新检查']) {
    const button = page.getByRole('button', { name });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(requests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('bypassable-webview-320.png'), fullPage: true });
});

test('disabled JavaScript retains static guidance without an inert bypass action', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL, viewport: { width: 320, height: 720 } });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '游戏尚未启动' })).toBeVisible();
    await expect(page.locator('noscript p')).toHaveText('浏览器已禁用 JavaScript，请启用后重新打开游戏。');
    await expect(page.locator('#compatibility-continue')).toBeHidden();
  } finally {
    await context.close();
  }
});
