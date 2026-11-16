import { skipStory } from "./story-platform-fixture";
import { expect, test, type Page, type Route } from "@playwright/test";
import { respondToOfficialPlaylistCopy } from "./playlist-fixture";

const defaultId = "d47c1184-7f10-4f45-9d67-dc24f7f9a7e1";
const storyId = "hoc-core/official-story";
const openingId = `${storyId}#opening`;
const defaultPaths = ["**/embedded/default-playlist.json", "**/characters/default-playlist.json"];

/** Model the prior shipped template through the same runtime JSON endpoint. */
async function oldTemplate(page: Page) {
  let observed = 0;
  const intercept = async (route: Route) => {
    const response = await route.fetch();
    if (!response.headers()["content-type"]?.includes("application/json")) {
      await route.fulfill({ response }); return;
    }
    const document = await response.json();
    document.packages = document.packages.filter((entry: any) => entry.packageId !== storyId);
    observed++;
    await route.fulfill({ response, json: document });
  };
  for (const path of defaultPaths) await page.route(path, intercept);
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 90_000 });
  expect(observed).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave("2026-11-14T00:00:00.000Z");
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await (await load("/src/persistence/factory.ts")).createPersistenceService().projectSnapshot((current: any) => ({ ...current, longTerm: save, runtime: null, story: null, notebook: null }), { notebookReplacement: true });
  });
  return async () => { for (const path of defaultPaths) await page.unroute(path, intercept); };
}

async function playlists(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const host = await new (await load("/src/content/storage/opfs-host.ts")).OpfsContentHostProvider().open();
    const store = new (await load("/src/content/playlists/store.ts")).PlaylistStore(host.fileSystem);
    return { currentId: await store.currentId(), entries: await store.list() };
  });
}

async function contentState(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const host = await new (await load("/src/content/storage/opfs-host.ts")).OpfsContentHostProvider().open();
    const { decodeText } = await load("/src/content/storage/encoding.ts");
    return Promise.all(["content/v1/catalog-a.json", "content/v1/catalog-b.json", "content/v1/playlists-a.json", "content/v1/playlists-b.json"].map(async path => {
      const bytes = await host.fileSystem.read(path);
      return [path, bytes ? decodeText(bytes) : null];
    }));
  });
}

async function currentTemplate(page: Page): Promise<void> {
  const useCurrentTemplate = await oldTemplate(page);
  await useCurrentTemplate(); await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
}

async function openPackages(page: Page, name: string, enabled: boolean) {
  await page.locator("[data-open-packages]").click();
  if (name === "官方播放集") {
    await expect(page.locator(".playlist-current-name[data-embedded-default-playlist] > span")).toHaveText("官方播放器（只读）");
    await expect(page.locator(".playlist-current-name > small")).toHaveText("随游戏更新");
    await expect(page.locator(".playlist-current-name")).toContainText("只读");
  } else {
    await expect(page.locator(".playlist-current-name")).toHaveText(name);
    await expect(page.locator(".playlist-current-name[data-embedded-default-playlist]")).toHaveCount(0);
  }
  await expect(page.locator(`.package-card[data-package-id="${storyId}"]`)).toHaveAttribute("data-package-state", enabled ? "enabled" : "disabled");
}

async function chooseDefault(page: Page) {
  await page.locator("[data-toggle-playlist-menu]").click();
  await page.locator(`[data-load-playlist="${defaultId}"]`).click();
  await expect(page.locator(".playlist-current-name[data-embedded-default-playlist] > span")).toHaveText("官方播放器（只读）");
  await expect(page.locator(".playlist-current-name > small")).toHaveText("随游戏更新");
  await expect(page.locator(".playlist-current-name")).toContainText("只读");
  await expect(page.locator(`.package-card[data-package-id="${storyId}"]`)).toHaveAttribute("data-package-state", "enabled");
}

async function expectOpening(page: Page) {
  await page.locator("[data-close-packages]").click();
  await page.locator("[data-start-game]").click();
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator("[data-story-player]")).toBeVisible();
  const scene = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await (await load("/src/persistence/factory.ts")).createPersistenceService().readSnapshot()).story.active.request.sceneId;
  });
  expect(scene).toBe(openingId);
}

test.beforeEach(async ({ page }) => {

  for (const selector of ["[data-acknowledge-third-party-content]", "[data-acknowledge-adult-content]", "[data-tutorial-skip]"]) {
    await page.addLocatorHandler(page.locator(selector).first(), async button => { await button.click(); }, { noWaitAfter: true });
  }
});

test("legacy default selection remains intact and the embedded Core default can add the new story", async ({ page }) => {
  test.setTimeout(120_000);
  const useCurrentTemplate = await oldTemplate(page);
  const legacyId = await page.evaluate(async managedId => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const host = await new (await load("/src/content/storage/opfs-host.ts")).OpfsContentHostProvider().open();
    const { decodeText, encodeText, stableJson, sha256Json } = await load("/src/content/storage/encoding.ts");
    const legacyId = crypto.randomUUID();
    for (const path of ["content/v1/playlists-a.json", "content/v1/playlists-b.json"]) {
      const { checksum: _checksum, ...body } = JSON.parse(decodeText(await host.fileSystem.read(path)));
      body.playlists = body.playlists.map((entry: any) => entry.id === managedId
        ? { id: legacyId, document: { ...entry.document, name: "默认播放集" } } : entry);
      body.currentId = legacyId;
      await host.fileSystem.write(path, encodeText(stableJson({ ...body, checksum: await sha256Json(body) })));
    }
    return legacyId;
  }, defaultId);
  await useCurrentTemplate(); await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  const stored = await playlists(page);
  expect(stored.currentId).toBe(legacyId);
  expect(stored.entries.find((entry: any) => entry.id === legacyId).document.packages.some((entry: any) => entry.packageId === storyId)).toBe(false);
  expect(stored.entries.find((entry: any) => entry.id === defaultId).document.packages.some((entry: any) => entry.packageId === storyId)).toBe(true);
  await openPackages(page, "默认播放集", false);
  await chooseDefault(page);
  await expectOpening(page);
});

test("the official playlist receives new members and disabling forks only after confirmation", async ({ page }) => {
  test.setTimeout(120_000);
  const useCurrentTemplate = await oldTemplate(page);
  await openPackages(page, "官方播放集", false);
  await page.locator("[data-close-packages]").click();
  await useCurrentTemplate(); await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  expect((await playlists(page)).currentId).toBe(defaultId);
  await openPackages(page, "官方播放集", true);
  await expectOpening(page);
  await skipStory(page);
  await page.locator("[data-lobby-home]").click();
  await page.locator("[data-exit-launcher]").click();
  await page.locator("[data-open-packages]").click();
  const before = await playlists(page), beforeFiles = await contentState(page);
  const official = before.entries.find((entry: any) => entry.id === defaultId).document;
  await page.locator(`.package-card[data-package-id="${storyId}"] [data-package-action="disable"]`).click();
  await respondToOfficialPlaylistCopy(page, "cancel");
  expect(await contentState(page)).toEqual(beforeFiles);
  expect(await playlists(page)).toEqual(before);
  await expect(page.locator(`.package-card[data-package-id="${storyId}"]`)).toHaveAttribute("data-package-state", "enabled");
  await page.locator(`.package-card[data-package-id="${storyId}"] [data-package-action="disable"]`).click();
  await respondToOfficialPlaylistCopy(page, "confirm");
  await expect(page.locator(`.package-card[data-package-id="${storyId}"]`)).toHaveAttribute("data-package-state", "disabled");
  const forked = await playlists(page);
  expect(forked.currentId).not.toBe(defaultId);
  expect(forked.entries).toHaveLength(before.entries.length + 1);
  expect(forked.entries.find((entry: any) => entry.id === defaultId).document).toEqual(official);
  const copy = forked.entries.find((entry: any) => entry.id === forked.currentId);
  expect(copy.document.name).toMatch(/^官方播放集（副本 \d+）$/);
  expect(copy.document.packages.some((entry: any) => entry.packageId === storyId)).toBe(false);
  await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await openPackages(page, copy.document.name, false);
  const reloaded = await playlists(page);
  expect(reloaded.currentId).toBe(copy.id);
  expect(reloaded.entries.find((entry: any) => entry.id === defaultId).document).toEqual(official);
});

test("custom selection stays unchanged while the unselected Core default updates", async ({ page }) => {
  test.setTimeout(120_000);
  const useCurrentTemplate = await oldTemplate(page);
  const customId = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const host = await new (await load("/src/content/storage/opfs-host.ts")).OpfsContentHostProvider().open();
    const { PlaylistStore } = await load("/src/content/playlists/store.ts");
    const store = new PlaylistStore(host.fileSystem);
    const currentId = await store.currentId();
    const current = (await store.list()).find((entry: any) => entry.id === currentId);
    const custom = await store.save({ ...current.document, name: "自定义旧播放集" });
    await store.select(custom.id);
    return custom.id;
  });
  await useCurrentTemplate(); await page.reload();
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  const stored = await playlists(page);
  expect(stored.currentId).toBe(customId);
  expect(stored.entries.find((entry: any) => entry.id === customId).document.packages.some((entry: any) => entry.packageId === storyId)).toBe(false);
  expect(stored.entries.find((entry: any) => entry.id === defaultId).document.packages.some((entry: any) => entry.packageId === storyId)).toBe(true);
  await openPackages(page, "自定义旧播放集", false);
  await chooseDefault(page);
  await expectOpening(page);
});

test("renaming the official playlist cancels cleanly or creates a selected named copy", async ({ page }) => {
  test.setTimeout(120_000);
  await currentTemplate(page);
  await openPackages(page, "官方播放集", true);
  const before = await playlists(page), beforeFiles = await contentState(page);
  const official = before.entries.find((entry: any) => entry.id === defaultId).document;
  await page.locator("[data-open-playlist-manager]").click();
  await expect(page.locator(`[data-manage-playlist="${defaultId}"] [data-delete-playlist]`)).toBeDisabled();
  const input = page.locator(`[data-playlist-rename-input="${defaultId}"]`);
  await input.fill("我的夜场"); await input.press("Enter");
  await respondToOfficialPlaylistCopy(page, "cancel");
  expect(await contentState(page)).toEqual(beforeFiles);
  expect(await playlists(page)).toEqual(before);
  await expect(input).toHaveValue("官方播放集");
  await input.fill("我的夜场"); await input.press("Enter");
  await respondToOfficialPlaylistCopy(page, "confirm");
  await expect(page.locator(".playlist-current-name")).toHaveText("我的夜场");
  const forked = await playlists(page);
  expect(forked.currentId).not.toBe(defaultId);
  expect(forked.entries).toHaveLength(before.entries.length + 1);
  expect(forked.entries.find((entry: any) => entry.id === defaultId).document).toEqual(official);
  expect(forked.entries.find((entry: any) => entry.id === forked.currentId).document).toEqual({ ...official, name: "我的夜场" });
});

test("reordering official plugins changes a copy while its original order stays intact", async ({ page }) => {
  test.setTimeout(120_000);
  await currentTemplate(page);
  await openPackages(page, "官方播放集", true);
  const before = await playlists(page), beforeFiles = await contentState(page);
  const official = before.entries.find((entry: any) => entry.id === defaultId).document;
  expect(official.pluginOrder.length).toBeGreaterThanOrEqual(2);
  const move = page.locator(`.package-card[data-package-id="${official.pluginOrder[0]}"] [data-plugin-move="down"]`);
  await move.click(); await respondToOfficialPlaylistCopy(page, "cancel");
  expect(await contentState(page)).toEqual(beforeFiles);
  expect(await playlists(page)).toEqual(before);
  await move.click(); await respondToOfficialPlaylistCopy(page, "confirm");
  await expect.poll(async () => (await playlists(page)).currentId).not.toBe(defaultId);
  const reordered = [...official.pluginOrder];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await expect.poll(async () => {
    const current = await playlists(page);
    return current.entries.find((entry: any) => entry.id === current.currentId).document.pluginOrder;
  }).toEqual(reordered);
  const forked = await playlists(page);
  expect(forked.entries).toHaveLength(before.entries.length + 1);
  expect(forked.entries.find((entry: any) => entry.id === defaultId).document).toEqual(official);
  await expect(page.locator(".playlist-current-name")).toHaveText(/^官方播放集（副本 \d+）$/);
});
