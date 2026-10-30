import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

async function savedVolume(page: Page) {
  return page.evaluate(async () => {
    const url = "/src/persistence/factory.ts";
    const { createPersistenceService } = await import(/* @vite-ignore */ url);
    return (await createPersistenceService().loadLongTerm())?.settings.musicVolume;
  });
}

async function activeVolume(page: Page, scene: "lobby" | "match") {
  return page.evaluate(async scene => {
    const url = "/src/resources/cache-policy.ts";
    const sources = await import(/* @vite-ignore */ url);
    const source = scene === "lobby" ? sources.LOBBY_BGM_URL : sources.TABLE_BGM_URL;
    const track = (window as any).__volumeTracks.findLast((audio: HTMLAudioElement) => audio.src.endsWith(source));
    return track && !track.paused && track.currentTime > 0 ? track.volume : -1;
  }, scene);
}

test("music volume previews, saves, recovers failed writes and survives reload and match entry", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => {
    await dialog.locator("[data-acknowledge-adult-content]").click();
  });
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    (window as any).__volumeTracks = [];
    window.Audio = function (src?: string) {
      const audio = new NativeAudio(src); (window as any).__volumeTracks.push(audio); return audio;
    } as typeof Audio;
    window.Audio.prototype = NativeAudio.prototype;
  });
  await page.goto("/"); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    delete save.settings.musicVolume; // A valid older save remains readable without a rewrite.
    save.skipTutorial = true;
    save.defeats = [{ opponentId: "chatgpt", timestamp: "2026-10-28T00:00:00.000Z" }];
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  });
  const start = async () => {
    await page.locator("[data-start-game]").click();
    await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
    await page.locator('[data-open="settings"]').click();
  };
  await start();
  const slider = page.getByRole("slider", { name: "音乐音量", exact: true });
  const readout = page.locator("[data-music-volume-value]");
  await expect(slider).toHaveValue("0.18"); await expect(readout).toHaveText("18%");
  expect(await savedVolume(page)).toBeUndefined();
  await expect.poll(() => activeVolume(page, "lobby")).toBeCloseTo(.18);
  const preview = async (value: string) => {
    await slider.evaluate((node, value) => {
      (node as HTMLInputElement).value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  };
  const commit = async () => {
    await slider.dispatchEvent("change");
    await expect(slider).toBeEnabled(); await expect(page.locator("#lobby-status")).toContainText("已保存");
  };
  await preview("0.42"); await expect(readout).toHaveText("42%");
  await expect.poll(() => activeVolume(page, "lobby")).toBeCloseTo(.42);
  expect(await savedVolume(page)).toBeUndefined();
  await commit(); expect(await savedVolume(page)).toBe(.42);
  await page.locator('[data-setting="soundEnabled"]').uncheck();
  await expect(page.locator('[data-setting="soundEnabled"]')).toBeEnabled();
  await expect.poll(() => activeVolume(page, "lobby")).toBe(-1);
  await slider.press("Home"); await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue("0"); await expect(readout).toHaveText("0%");
  await page.locator('[data-setting="soundEnabled"]').check();
  await expect.poll(() => activeVolume(page, "lobby")).toBe(0);
  await slider.press("End"); await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue("1"); await expect(readout).toHaveText("100%");
  await slider.press("ArrowLeft"); await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue("0.99");
  await preview("0.37"); await commit();
  await page.evaluate(async () => {
    const url = "/src/persistence/save-service.ts";
    const { PersistenceService } = await import(/* @vite-ignore */ url);
    (window as any).__volumeSaveMethod = PersistenceService.prototype.saveLongTerm;
    PersistenceService.prototype.saveLongTerm = async () => { throw new Error("模拟写入失败"); };
  });
  await preview("0.8"); await slider.dispatchEvent("change");
  await expect(page.locator("#lobby-status")).toContainText("设置保存失败");
  await expect(slider).toBeEnabled(); await expect(slider).toHaveValue("0.37"); await expect(readout).toHaveText("37%");
  await expect.poll(() => activeVolume(page, "lobby")).toBeCloseTo(.37);
  expect(await savedVolume(page)).toBe(.37);
  await page.evaluate(async () => {
    const url = "/src/persistence/save-service.ts";
    const { PersistenceService } = await import(/* @vite-ignore */ url);
    PersistenceService.prototype.saveLongTerm = (window as any).__volumeSaveMethod;
  });
  await preview("0.38"); await commit(); await preview("0.37"); await commit();
  const output = resolve("output/music-volume"); mkdirSync(output, { recursive: true });
  for (const [size, width, height] of [["desktop", 1280, 800], ["390", 390, 844], ["320", 320, 720]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.locator("#settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, `settings-${size}.png`) });
  }
  await page.reload(); await start();
  await expect(slider).toHaveValue("0.37"); await expect(readout).toHaveText("37%");
  await expect.poll(() => activeVolume(page, "lobby")).toBeCloseTo(.37);
  await page.locator("#settings [data-close]").click(); await page.locator("[data-enter-duel]").click();
  await page.locator('[data-invite-character="chatgpt"]').click(); await page.locator('[data-profile-start="chatgpt"]').click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  await expect.poll(() => activeVolume(page, "match")).toBeCloseTo(.37);
  expect(errors).toEqual([]);
});
