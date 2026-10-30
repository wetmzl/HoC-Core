import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { installBossTrialPackage } from "./boss-trial-package-fixture";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const digest = (value: unknown) => hash(Buffer.from(JSON.stringify(canonical(value))));

/** All art is existing neutral Core art; this overlay is never shipped as character content. */
async function installSkinFixture(page: Page, options: { characterId?: string; covers?: boolean; rules?: boolean } = {}) {
  const characterId = options.characterId ?? "chatgpt";
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => {
    await dialog.getByRole("button", { name: "我已成年并继续" }).click();
  });
  const root = new URL("../../public/characters/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL(`${characterId}/hocpkg-info.json`, root), "utf8"));
  const match = JSON.parse(await readFile(new URL(`${characterId}/resources/character-match.json`, root), "utf8"));
  const dialogue = JSON.parse(await readFile(new URL(`${characterId}/resources/dialogue.json`, root), "utf8"));
  const base = JSON.parse(await readFile(new URL(`${characterId}/resources/appearance.json`, root), "utf8"));
  const baseResources = Object.fromEntries(Object.entries(base.resources).map(([key, resource]: [string, any]) => [key, { ...resource, variants: [{ ...resource.variants[0], skinId: "a" }] }]));
  const basePortrait = base.resources["portrait:relaxed"].variants[0].value;
  const baseFocus = base.resources["focus:cover"].variants[0].value;
  const portrait = { ...basePortrait, scale: 1, anchorY: .94 };
  const appearance = {
    skins: [{ id: "a", name: "原装" }, { id: "b", name: "晚礼服", ...(options.rules ? { unlock: { type: "defeat-character", count: 2 } } : {}) }, { id: "c", name: "旅行装", ...(options.rules ? { unlock: { type: "defeat-character", count: 1 } } : {}) }],
    resources: {
      ...baseResources,
      portrait: { type: "portrait", variants: [{ skinId: "a", value: portrait }, { skinId: "b", value: { ...portrait, image: base.resources["portrait:mocking"].variants[0].value.image, scale: 1.1, anchorY: .82 } }] },
      subtitle: { type: "text", variants: [{ skinId: "a", value: "中性换装测试角色" }, { skinId: "c", value: "旅行装的文字，立绘回退至原装" }] }
    }
  };
  match.presentationResourceId = "appearance";
  match.metadata.subtitle = { presentationRef: "subtitle" };
  match.metadata.previewImage = { presentationRef: "portrait", path: "/image" };
  if (options.covers) {
    appearance.resources["test:cover"] = { type: "image", variants: [{ skinId: "a", value: "cover.png" }, { skinId: "b", value: "alternate-cover.png" }] };
    appearance.resources["test:cover-focus"] = { type: "data", variants: [{ skinId: "a", value: baseFocus }, { skinId: "b", value: { x: .48, y: .4 } }] };
    match.metadata.previewImage = { presentationRef: "test:cover" };
    match.definition.assets.cover = { presentationRef: "test:cover" };
    match.metadata.previewFocus = { presentationRef: "test:cover-focus" };
  }
  match.definition.assets.relaxed = { presentationRef: "portrait", path: "/image" };
  match.definition.revolverPlacement = { presentationRef: "portrait", path: "/revolverPlacement" };
  match.definition.tablePortrait = { anchorY: 1, images: [{ image: { presentationRef: "portrait", path: "/image" }, anchorY: { presentationRef: "portrait", path: "/anchorY" } }] };
  dialogue.poolPortraits = { [dialogue.fallbackPoolId]: { presentationRef: "portrait" } };
  // Keep the initial fallback visible so its image and positioning can be inspected in a match.
  dialogue.rules = [];
  const changed = new Map<string, Buffer>([
    ["resources/character-match.json", encode(match)], ["resources/dialogue.json", encode(dialogue)], ["resources/appearance.json", encode(appearance)]
  ]);
  if (options.covers) changed.set("alternate-cover.png", await readFile(new URL("../../public/assets/package-cover-fallback.png", import.meta.url)));
  for (const resource of manifest.resources) {
    if (resource.type === "game.character-match") { resource.apiVersion = 13; if (!resource.requires.includes("appearance")) resource.requires.push("appearance"); }
    if (resource.type === "game.character-dialogue") { resource.apiVersion = 4; if (!resource.requires.includes("appearance")) resource.requires.push("appearance"); }
  }
  if (!manifest.resources.some((resource: any) => resource.id === "appearance")) manifest.resources.push({ id: "appearance", type: "presentation.character", apiVersion: 1, entry: "resources/appearance.json", requires: [] });
  const appearanceDescriptor = manifest.resources.find((resource: any) => resource.id === "appearance");
  appearanceDescriptor.apiVersion = options.rules ? 2 : 1;
  manifest.files = manifest.files.filter((file: any) => !changed.has(file.path));
  for (const [path, bytes] of changed) manifest.files.push({ path, bytes: bytes.length, sha256: hash(bytes), mediaType: path.endsWith(".png") ? "image/png" : "application/json" });
  manifest.files.sort((a: any, b: any) => a.path.localeCompare(b.path));
  const index = JSON.parse(await readFile(new URL("packages.json", root), "utf8"));
  const entry = index.packages.find((entry: any) => entry.packageId === `hoc-core/${characterId}`);
  entry.contentDigest = digest(manifest); entry.bytes = manifest.files.reduce((sum: number, file: any) => sum + file.bytes, 0);
  delete index.releaseDigest; index.releaseDigest = digest(index);
  changed.set("hocpkg-info.json", encode(manifest));
  await page.route("**/characters/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/characters/packages.json") ? encode(index) : path.includes(`/characters/${characterId}/`) ? changed.get(path.split(`/characters/${characterId}/`)[1]) : undefined;
    if (body) await route.fulfill({ body, contentType: path.endsWith(".png") ? "image/png" : "application/json" }); else await route.continue();
  });
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  return index;
}

async function openHall(page: Page, seedSave = true, defeatBoss = true, unlockSkins = true, captureApi = false) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  if (captureApi) await page.evaluate(async () => {
    // Capture the real public plugin context without adding a production test hook.
    const { RuntimeExtensions } = await import(/* @vite-ignore */ "/src/runtime/runtime-extensions.ts");
    const mount = RuntimeExtensions.prototype.mount;
    RuntimeExtensions.prototype.mount = function () {
      const context = (this as any).options.context;
      (globalThis as any).__skinUnlockTestApi = context.characterSkinUnlocks;
      (globalThis as any).__skinSelectionTestApi = context.characterPresentation;
      return mount.call(this);
    };
  });
  if (seedSave) await page.evaluate(async ({ defeatBoss, unlockSkins }) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false;
    save.defeats = ["chatgpt", "claude", "gemini", "llama", "deepseek"].filter(id => defeatBoss || id !== "claude").map(opponentId => ({ opponentId, timestamp: "2026-10-29T00:00:00.000Z" }));
    if (unlockSkins) for (const id of ["chatgpt", "claude", "gemini", "llama", "deepseek"]) {
      const manifest = await (await fetch(`/characters/${id}/hocpkg-info.json`)).json();
      const match = manifest.resources.find((entry: any) => entry.type === "game.character-match");
      const presentation = manifest.resources.find((entry: any) => entry.type === "presentation.character");
      const catalog = await (await fetch(`/characters/${id}/${presentation.entry}`)).json();
      save.characterSkinUnlocks[`hoc-core/${id}#${match.id}`] = Object.fromEntries(catalog.skins.map((skin: any) => [skin.id, true]));
    }
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  }, { defeatBoss, unlockSkins });
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator("[data-enter-duel]").click();
  await page.locator("[data-load-more-defeated]").scrollIntoViewIfNeeded();
  await expect(page.locator("#defeated-character-list > .character-card")).toHaveCount(defeatBoss ? 5 : 4);
}

for (const width of [320, 1280]) test(`Core 皮肤解锁 API、锁定 UI 与重载持久化 ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await installSkinFixture(page);
  await openHall(page, true, true, false, true);
  const button = page.locator('[data-change-skin="chatgpt"]');
  await button.scrollIntoViewIfNeeded(); await button.click();
  const dialog = page.getByRole("dialog", { name: "选择服装" });
  const alternate = dialog.locator('[data-skin-id="b"]');
  await expect(alternate).toBeDisabled();
  await expect(alternate).toContainText("未解锁");
  expect(await page.evaluate(async () => {
    try { await (globalThis as any).__skinSelectionTestApi.select("chatgpt", "b", new AbortController().signal); return "unexpected"; }
    catch (error) { return (error as Error).message; }
  })).toContain("尚未解锁");
  await page.screenshot({ path: info.outputPath(`locked-skins-${width}.png`) });
  await page.evaluate(async () => { await (globalThis as any).__skinUnlockTestApi.unlock("chatgpt", "b"); });
  await expect(alternate).toBeEnabled();
  await expect(dialog.locator('[data-skin-id="c"]')).toBeDisabled();
  await alternate.click(); await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.character-card[data-character-id="chatgpt"] .portrait img')).toHaveAttribute("src", /mocking\.png/);
  await openHall(page, false, true, false, true);
  await button.scrollIntoViewIfNeeded(); await button.click();
  await expect(alternate).toBeEnabled();
  await expect(alternate).toHaveAttribute("aria-checked", "true");
  await dialog.locator('[data-skin-id="a"]').click(); await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(async () => { await (globalThis as any).__skinUnlockTestApi.lock("chatgpt", "b"); });
  await button.click(); await expect(alternate).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await openHall(page, false, true, false);
  await button.scrollIntoViewIfNeeded(); await button.click(); await expect(alternate).toBeDisabled();
});

test("声明式击败次数解锁会补齐旧档并持久化，显式插件锁定优先", async ({ page }) => {
  await installSkinFixture(page, { rules: true });
  await openHall(page, true, true, false, true);
  const button = page.locator('[data-change-skin="chatgpt"]');
  await button.scrollIntoViewIfNeeded(); await button.click();
  const dialog = page.getByRole("dialog", { name: "选择服装" });
  await expect(dialog.locator('[data-skin-id="c"]')).toBeEnabled();
  await expect(dialog.locator('[data-skin-id="b"]')).toBeDisabled();
  await expect(dialog.locator('[data-skin-id="b"]')).toContainText("击败该角色 2 次解锁");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repository = createPersistenceService(); const save = await repository.loadLongTerm();
    save.characterDefeatProgress = { counts: { chatgpt: 2 }, matchIds: ["one", "two"] };
    await repository.saveLongTerm(save);
  });
  await openHall(page, false, true, false, true);
  await button.scrollIntoViewIfNeeded(); await button.click();
  await expect(dialog.locator('[data-skin-id="b"]')).toBeEnabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const save = await createPersistenceService().loadLongTerm(); return save.characterSkinUnlocks['hoc-core/chatgpt#match'];
  })).toEqual({ b: true, c: true });
  await page.evaluate(async () => { await (globalThis as any).__skinUnlockTestApi.lock("chatgpt", "b"); });
  await openHall(page, false, true, false);
  await button.scrollIntoViewIfNeeded(); await button.click();
  await expect(dialog.locator('[data-skin-id="b"]')).toBeDisabled();
  await expect(dialog.locator('[data-skin-id="c"]')).toBeEnabled();
});

for (const width of [390, 320, 1280]) test(`大厅换装确认、回退和滚动保持 ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
  await installSkinFixture(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openHall(page);
  const button = page.locator('[data-change-skin="chatgpt"]');
  await button.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => ({ y: scrollY, ids: [...document.querySelectorAll(".character-card")].map(card => (card as HTMLElement).dataset.characterId) }));
  await button.click();
  const dialog = page.getByRole("dialog", { name: "选择服装" });
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  await expect.poll(() => dialog.locator("img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const previewA = await dialog.locator('[data-skin-id="a"] img').getAttribute("src");
  const previewC = await dialog.locator('[data-skin-id="c"] img').getAttribute("src");
  expect(previewC).toBe(previewA);
  await dialog.getByRole("radio", { name: /晚礼服/ }).click();
  const card = page.locator('.character-card[data-character-id="chatgpt"]');
  await expect(card.locator(".portrait img")).toHaveAttribute("src", /relaxed\.png/);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(before.y, 0);
  await button.click();
  await dialog.getByRole("radio", { name: /晚礼服/ }).click();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator(".portrait img")).toHaveAttribute("src", /mocking\.png/);
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(before.y, 0);
  expect(await page.locator(".character-card").evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.characterId))).toEqual(before.ids);
  await button.click();
  await expect(dialog.locator('[data-skin-id="b"]')).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: info.outputPath(`skin-picker-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await dialog.getByRole("radio", { name: /旅行装/ }).click();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator(".portrait img")).toHaveAttribute("src", /relaxed\.png/);
  await expect(card.locator(".character-copy > p:not(.eyebrow)")).toHaveText("旅行装的文字，立绘回退至原装");
  await openHall(page, false);
  await button.scrollIntoViewIfNeeded(); await button.click();
  await expect(dialog.locator('[data-skin-id="c"]')).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(errors).toEqual([]);
});

test("保存失败保留旧服装，重试后牌桌使用新皮肤", async ({ page }) => {
  await installSkinFixture(page); await openHall(page);
  await page.locator('[data-change-skin="chatgpt"]').click();
  const dialog = page.getByRole("dialog", { name: "选择服装" });
  await dialog.getByRole("radio", { name: /晚礼服/ }).click();
  await page.evaluate(async () => {
    const { PersistenceService } = await import(/* @vite-ignore */ "/src/persistence/save-service.ts");
    const original = PersistenceService.prototype.saveLongTerm;
    PersistenceService.prototype.saveLongTerm = async function (save) {
      PersistenceService.prototype.saveLongTerm = original;
      throw new Error("测试写入失败");
    };
  });
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("换装失败，请重试。");
  await expect(page.locator('.character-card[data-character-id="chatgpt"] .portrait img')).toHaveAttribute("src", /relaxed\.png/);
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('[data-invite-character="chatgpt"]').click();
  await page.locator('[data-profile-start="chatgpt"]').click();
  await expect(page.locator(".character-portrait")).toHaveAttribute("src", /mocking\.png/);
});

for (const width of [320, 390, 1280]) test(`五位 AI 大厅与 Boss 挑战显示已通过的 cover ${width}`, async ({ page }, info) => {
  await installBossTrialPackage(page);
  await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => { await dialog.getByRole("button", { name: "我已成年并继续" }).click(); });
  await openHall(page, true, false);
  for (const id of ["chatgpt", "claude", "gemini", "deepseek", "llama"]) {
    const image = page.locator(`.character-card[data-character-id="${id}"] .portrait img`).first();
    await expect(image).toHaveAttribute("src", new RegExp(`/characters/${id}/cover\\.png`));
    await expect.poll(() => image.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1254);
  }
  const boss = page.locator('.boss-character-card[data-character-id="claude"]');
  await expect(boss.locator(".portrait img")).toHaveAttribute("src", /claude\/cover\.png/);
  await page.screenshot({ path: info.outputPath(`ai-cover-lobby-${width}.png`), fullPage: true });
  await boss.locator(".lobby-boss-entry").click();
  await expect(page.locator("#profile .profile-portrait")).toHaveAttribute("src", /claude\/cover\.png/);
  await page.locator("[data-profile-start]").click();
  for (const id of ["chatgpt", "llama", "gemini", "deepseek"]) {
    await expect(page.locator(`[data-encounter="${id}"] img`)).toHaveAttribute("src", new RegExp(`/characters/${id}/cover\\.png`));
  }
  await expect(page.locator(".challenge-boss-action-portrait")).toHaveCount(0);
  await expect.poll(() => page.locator(".challenge-guard-portrait").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 1254))).toBe(true);
  await page.screenshot({ path: info.outputPath(`ai-cover-challenge-${width}.png`), fullPage: true });
});

test("换装独立切换 cover 与焦点，重载和 Boss 挑战保留选择，缺项逐资源回退", async ({ page }, info) => {
  const index = await installSkinFixture(page, { characterId: "claude", covers: true });
  await installBossTrialPackage(page, index);
  await openHall(page, true, false);
  const boss = page.locator('.boss-character-card[data-character-id="claude"]');
  const image = boss.locator(".portrait img");
  const choose = async (name: string) => {
    await boss.locator("[data-change-skin]").click();
    const dialog = page.getByRole("dialog", { name: "选择服装" });
    await dialog.getByRole("radio", { name: new RegExp(name) }).click();
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  await expect(image).toHaveAttribute("src", /claude\/cover\.png/);
  await choose("晚礼服");
  await expect(image).toHaveAttribute("src", /alternate-cover\.png/);
  await expect(image).toHaveAttribute("style", /--character-preview-x:48%;--character-preview-y:40%/);
  await openHall(page, false, false);
  await expect(image).toHaveAttribute("src", /alternate-cover\.png/);
  await choose("旅行装");
  await expect(image).toHaveAttribute("src", /claude\/cover\.png/);
  await expect(image).toHaveAttribute("style", /--character-preview-x:50%;--character-preview-y:32\.5%/);
  await choose("晚礼服");
  await boss.locator(".lobby-boss-entry").click();
  await expect(page.locator("#profile .profile-portrait")).toHaveAttribute("src", /alternate-cover\.png/);
  await page.locator("[data-profile-start]").click();
  await expect(page.locator(".challenge-boss-action-portrait")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("boss-selected-skin-cover-390.png"), fullPage: true });
});

for (const width of [320, 390, 1280]) test(`真实五套 AI 皮肤的 cover、换装与重载 ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
  await page.addInitScript(() => { (globalThis as any).__BLACKJACK_E2E_EMBEDDED__ = true; });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => { await dialog.getByRole("button", { name: "我已成年并继续" }).click(); });
  await openHall(page);
  for (const id of ["chatgpt", "claude", "gemini", "deepseek", "llama"]) {
    const card = page.locator(`.character-card[data-character-id="${id}"]`);
    await card.locator("[data-change-skin]").scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    await card.locator("[data-change-skin]").click();
    const dialog = page.getByRole("dialog", { name: "选择服装" });
    await expect(dialog.getByRole("radio")).toHaveCount(2);
    await expect(dialog.locator(".skin-preview-cover")).toHaveCount(2);
    await expect.poll(() => dialog.locator("img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 1254))).toBe(true);
    await expect(dialog.getByRole("radio").nth(1).locator("img")).toHaveAttribute("src", /skins\/.+\/cover\.png/);
    await dialog.getByRole("radio").nth(1).click();
    await page.screenshot({ path: info.outputPath(`real-skin-${id}-${width}.png`) });
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.locator(".portrait img")).toHaveAttribute("src", new RegExp(`/characters/${id}/skins/.+/cover\\.png`));
    expect(await page.evaluate(() => scrollY)).toBeCloseTo(before, 0);
  }
  await openHall(page, false);
  for (const id of ["chatgpt", "claude", "gemini", "deepseek", "llama"]) {
    await expect(page.locator(`.character-card[data-character-id="${id}"] .portrait img`)).toHaveAttribute("src", new RegExp(`/characters/${id}/skins/.+/cover\\.png`));
  }
  await page.locator('[data-invite-character="chatgpt"]').click();
  await page.locator('[data-profile-start="chatgpt"]').click();
  await expect(page.locator(".character-portrait")).toHaveAttribute("src", /chatgpt\/skins\/moonwhite-concierge\/(relaxed|conflicted|mocking|threatened)\.png/);
  await page.screenshot({ path: info.outputPath(`real-skin-table-${width}.png`) });
});

test("换装 cover 解码失败时显示兜底立绘，仍可选择服装", async ({ page }) => {
  await installSkinFixture(page, { covers: true });
  await page.route("**/alternate-cover.png", route => route.fulfill({ body: "invalid PNG", contentType: "image/png" }));
  await openHall(page);
  await page.locator('[data-change-skin="chatgpt"]').click();
  const choice = page.locator('[data-skin-id="b"]');
  await expect(choice.locator("img")).toHaveAttribute("src", /mocking\.png/);
  await expect(choice).toBeEnabled();
  await choice.click();
  await expect(page.locator("[data-skin-confirm]")).toBeEnabled();
});
