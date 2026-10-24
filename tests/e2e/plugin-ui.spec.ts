import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

function plugin(name: string, apiVersion = 8) {
  const files: Record<string, Buffer> = {
    "module.json": Buffer.from(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [] })),
    "plugin.css": Buffer.from("/* neutral UI fixture */"),
    "plugin.js": Buffer.from(`export function register(){return {handlers:[],createRuntime(){return {uiActions:[
      {id:'catalog',slot:'main-menu.secondary',label:'${name}目录',description:'<img src=x onerror=alert(1)>',order:25,async mount(context,signal){
        const log=window.__uiLog??=[]; log.push('mount:${name}');
        window.__uiContextKeys=Object.keys(context).sort(); window.__lastUiContext=context;
        signal.addEventListener('abort',()=>log.push('abort:${name}'),{once:true});
        context.container.textContent='${name}页面';
        return {dispose(){log.push('dispose:${name}');if('${name}'==='alpha')throw new Error('fixture cleanup failure')}};
      }},
      {id:'slow',slot:'main-menu.tools',label:'${name}延迟页面',icon:'◇',async mount(context,signal){
        const log=window.__uiLog??=[];
        signal.addEventListener('abort',()=>log.push('abort:slow:${name}'),{once:true});
        context.container.textContent='延迟加载中';
        await new Promise(resolve=>setTimeout(resolve,500));
        context.container.textContent='过期内容';
        return {dispose(){log.push('dispose:slow:${name}')}};
      }},
      {id:'failure',slot:'main-menu.secondary',label:'${name}失败页面',async mount(context,signal){
        signal.addEventListener('abort',()=>{(window.__uiLog??=[]).push('abort:failure:${name}')},{once:true});
        throw new Error('fixture failure');
      }}
    ]}}}}`)
  };
  const manifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "test", packageName: name, version: "1.0.0" },
    metadata: { title: name, description: "中性 UI 入口验证", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [{ id: "module", type: "plugin.module", apiVersion, entry: "module.json", requires: [] }],
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" })), extensions: {}
  };
  return Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)) }));
}
async function start(page: Page) {
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
}
async function install(page: Page, names: string[]) {
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator("[data-import-file]").setInputFiles({ name: "ui-fixtures.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(Object.fromEntries(names.map(name => [`${name}.hocpkg`, plugin(name)])))) });
  await page.getByRole("button", { name: "安装所选包" }).click();
  for (const name of names) {
    await page.locator(`[data-package-action="enable"][data-package-id="test/${name}"]`).click();
    await expect(page.locator(`.package-card[data-package-id="test/${name}"]`)).toHaveAttribute("data-package-state", "enabled");
  }
  await page.getByRole("button", { name: "关闭资源管理" }).click();
}
test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.locator("#third-party-content-warning"), async w => { await w.locator("[data-acknowledge-third-party-content]").click(); });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async w => { await w.locator("[data-acknowledge-adult-content]").click(); });
  await page.goto("/");
});

test("UI entries use isolated pages, retain built-ins and follow package enable/disable", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await install(page, ["alpha", "beta"]);
  await start(page);
  const buttons = page.locator('[data-ui-slot="main-menu.secondary"] > button');
  await expect(buttons).toHaveCount(7);
  expect(await buttons.locator("strong").allTextContents()).toEqual(["玩法说明", "技能与天赋", "alpha目录", "beta目录", "历史记录", "alpha失败页面", "beta失败页面"]);
  await expect(buttons.locator("img")).toHaveCount(0);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const button of await buttons.all()) {
      expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.screenshot({ path: testInfo.outputPath("ui-slots-320.png"), fullPage: true });
  await page.locator('[data-open="rules"]').click(); await expect(page.locator("#rules")).toBeVisible(); await page.locator("#rules [data-close]").click();
  await page.locator('[data-open="skills"]').click(); await expect(page.locator("#skills")).toBeVisible(); await page.locator("#skills [data-close]").click();
  await page.locator("[data-open-history]").click(); await expect(page.locator(".history-shell")).toBeVisible();
  await page.getByRole("button", { name: /返回/ }).first().click();
  await page.getByRole("button", { name: "alpha目录", exact: true }).click();
  await expect(page.locator(".plugin-ui-content")).toHaveText("alpha页面");
  expect(await page.evaluate(() => (window as any).__uiContextKeys)).toEqual(["alert", "confirm", "container", "navigateToMenu"]);
  await page.evaluate(() => (window as any).__lastUiContext.navigateToMenu());
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await page.getByRole("button", { name: "beta目录", exact: true }).click();
  await expect(page.locator(".plugin-ui-content")).toHaveText("beta页面");
  await page.getByRole("button", { name: "返回主菜单", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__uiLog)).toEqual(["mount:alpha", "abort:alpha", "dispose:alpha", "mount:beta", "abort:beta", "dispose:beta"]);
  // A retained context cannot navigate after its page has been released.
  await page.locator("[data-enter-duel]").click(); await expect(page.locator(".lobby-character-shell")).toBeVisible();
  await page.evaluate(() => (window as any).__lastUiContext.navigateToMenu());
  await expect(page.locator(".lobby-character-shell")).toBeVisible(); await expect(page.locator("[data-ui-action]")).toHaveCount(0);
  await page.locator("[data-lobby-home]").click();
  await page.locator("[data-exit-launcher]").click();
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator('[data-package-action="disable"][data-package-id="test/alpha"]').click();
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await start(page); await expect(page.getByRole("button", { name: "alpha目录", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "beta目录", exact: true }).click();
  await expect(page.locator(".plugin-ui-content")).toHaveText("beta页面");
  // Release the whole runtime while an extension page is current.
  await page.evaluate(async () => { const { requestGameRuntimeExit } = await import("/src/app.ts"); await requestGameRuntimeExit(); });
  await expect(page.locator("[data-start-game]")).toBeVisible();
  await page.getByRole("button", { name: "资源管理", exact: true }).click();
  await page.locator('[data-package-action="enable"][data-package-id="test/alpha"]').click();
  await expect(page.locator('.package-card[data-package-id="test/alpha"]')).toHaveAttribute("data-package-state", "enabled");
  await page.getByRole("button", { name: "关闭资源管理" }).click();
  await start(page);
  await expect(page.getByRole("button", { name: "beta目录", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "alpha目录", exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("failed and late page mounts can return safely and release their signals", async ({ page }) => {
  await install(page, ["alpha"]); await start(page);
  await page.getByRole("button", { name: "alpha失败页面", exact: true }).click();
  await expect(page.locator(".plugin-ui-content")).toContainText("暂时无法打开");
  await page.getByRole("button", { name: "返回主菜单", exact: true }).click();
  await page.getByRole("button", { name: "alpha延迟页面", exact: true }).click();
  await expect(page.locator(".plugin-ui-content")).toHaveText("延迟加载中");
  await page.getByRole("button", { name: "返回主菜单", exact: true }).click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__uiLog)).toEqual(["abort:failure:alpha", "abort:slow:alpha", "dispose:slow:alpha"]);
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
});
