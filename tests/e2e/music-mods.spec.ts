import { skipStory } from "./story-platform-fixture";
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { respondToOfficialPlaylistCopy } from "./playlist-fixture";

function musicPackage(name: "a" | "b", plugin = false) {
  const template = JSON.parse(readFileSync("public/characters/chatgpt/hocpkg-info.json", "utf8"));
  const files: Record<string, Uint8Array> = {};
  const tracks: Record<string, { path: string; name: string }> = {};
  for (const [index, id] of ["lobby", "match", "special", "stinger"].entries()) {
    tracks[id] = { path: `bgm/${id}.opus`, name: `${name.toUpperCase()} ${id}` };
    files[tracks[id].path] = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${330 + index * 110}:duration=${id === "stinger" ? 1.5 : 3}`, "-c:a", "libopus", "-b:a", "80k", "-f", "opus", "pipe:1"]);
  }
  files["music.json"] = Buffer.from(JSON.stringify({ tracks, rules: ["lobby", "match"].map(scene => ({ id: scene, scene, track: scene, priority: "override" })) }));
  template.identity = { authorId: "music-test", packageName: name, version: "1.0.0" };
  template.metadata = { title: `音乐${name.toUpperCase()}`, description: "中性生成音频测试", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] };
  template.resources = [{ id: "main", type: "presentation.music", apiVersion: 1, entry: "music.json", requires: [] }];
  template.extensions = {};
  if (plugin) {
    template.resources.push({ id: "module", type: "plugin.module", apiVersion: 13, entry: "plugin.json", requires: [] });
    files["plugin.json"] = Buffer.from(JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [] }));
    files["plugin.css"] = Buffer.from("/* neutral music fixture */");
    files["plugin.js"] = Buffer.from(`export function register() { return { handlers: [], createRuntime() { return { mountRuntime(context, signal) {
      const music = context.music;
      window.__musicSnapshots = [];
      music.subscribeContext(snapshot => {
        window.__musicSnapshots.push({events:snapshot.events.length, restored:snapshot.restored, scene:snapshot.scene});
        if(snapshot.scene === 'match' && snapshot.match) music.set('phase',{track:'music-test/a#main/special',priority:'conditional',scope:'match',transitionMs:0});
        else music.release('phase');
      },{signal});
      window.__musicTest = action => {
        if(action === 'stinger') music.set('stinger',{track:'music-test/a#main/stinger',priority:'temporary',scope:'runtime',loop:false,transitionMs:0});
        else music.release('phase');
      };
      signal.addEventListener('abort',()=>{delete window.__musicTest;},{once:true});
    } }; } }; }`);
  }
  template.files = Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: path.endsWith(".opus") ? "audio/ogg" : path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "application/json" }));
  return Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(template)) }));
}
async function install(page: Page, name: "a" | "b", plugin = false) {
  await page.locator("[data-import-file]").setInputFiles({ name: `${name}.hocpkg`, mimeType: "application/zip", buffer: musicPackage(name, plugin) });
  await page.locator("[data-import-next]").click(); await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  const card = page.locator(`.package-card[data-package-id="music-test/${name}"]`);
  if (await card.getAttribute("data-package-state") === "disabled") {
    const official = await page.locator("[data-embedded-default-playlist]").count();
    await card.locator('[data-package-action="enable"]').click();
    if (official) await respondToOfficialPlaylistCopy(page, "confirm");
  }
  await expect(card).toHaveAttribute("data-package-state", "enabled");
}
async function status(page: Page) {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await load("/src/audio/game-audio.ts")).gameAudio.musicDirector.status();
  });
}
async function playing(page: Page, track: string) {
  await expect.poll(async () => {
    const selected = (await status(page)).current;
    if (selected?.track !== track) return false;
    return page.evaluate(url => {
      const audio = (window as any).__musicElements.findLast((audio: HTMLAudioElement) => audio.src === url);
      return !!audio && !audio.paused && audio.currentTime > 0 && audio.volume > 0;
    }, selected.url);
  }).toBe(true);
}
test.beforeEach(async ({ page }) => {

  await page.addLocatorHandler(page.locator("#third-party-content-warning"), async dialog => { await dialog.locator('[data-acknowledge-third-party-content]').click(); });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => { await dialog.getByRole("button", { name: "我已成年并继续" }).click(); });
  await page.addInitScript(() => {
    const NativeAudio = window.Audio; (window as any).__musicElements = [];
    window.Audio = function (src?: string) { const audio = new NativeAudio(src); (window as any).__musicElements.push(audio); return audio; } as typeof Audio;
    window.Audio.prototype = NativeAudio.prototype;
  });
  await page.goto("/"); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave(); save.skipTutorial = true;
    // Music assertions need a stable invitation; the waiting list randomly shows three guests.
    save.defeats = [{ opponentId: "chatgpt", timestamp: "2026-10-24T00:00:00.000Z" }];
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  });
});

test("standalone music imports, replaces lobby and match, and persists package ordering", async ({ page }) => {
  await page.locator("[data-open-packages]").click(); await install(page, "b"); await install(page, "a");
  await page.locator("[data-close-packages]").click(); await page.locator("[data-start-game]").click();
  await page.locator('[data-open="settings"]').click();
  await page.getByText("音乐与音乐包", { exact: true }).click();
  await playing(page, "music-test/a#main/lobby");
  await page.getByRole("button", { name: "上移音乐B", exact: true }).click();
  await expect(page.getByText("音乐顺序已保存。", { exact: true })).toBeVisible();
  await playing(page, "music-test/b#main/lobby");
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.locator("#settings").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.locator("[data-music-package-order]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/music-mods-settings-320.png" });
  await page.reload(); await page.locator("[data-start-game]").click();
  await page.locator("[data-enter-duel]").click();
  await playing(page, "music-test/b#main/lobby");
  await page.locator('[data-invite-character="chatgpt"]').click(); await page.locator('[data-profile-start="chatgpt"]').click();
  await expect(page.locator(".table-bottom")).toBeVisible(); await playing(page, "music-test/b#main/match");
});

test("API 13 hooks switch on match entry, one-shots finish and restore conditions, and save restore sends no old events", async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator("[data-open-packages]").click(); await install(page, "a", true);
  await page.locator("[data-close-packages]").click(); await page.locator("[data-start-game]").click();
  await page.locator("[data-enter-duel]").click();
  await page.locator('[data-invite-character="chatgpt"]').click(); await page.locator('[data-profile-start="chatgpt"]').click();
  await expect(page.locator(".table-bottom")).toBeVisible(); await playing(page, "music-test/a#main/special");
  await page.evaluate(() => (window as any).__musicTest("stinger")); await playing(page, "music-test/a#main/stinger");
  await playing(page, "music-test/a#main/special");
  await page.evaluate(() => (window as any).__musicTest("release")); await playing(page, "music-test/a#main/match");
  await page.reload(); await page.locator("[data-start-game]").click(); await expect(page.locator(".table-bottom")).toBeVisible();
  await page.getByRole("heading", { name: "命运牌桌" }).click(); await playing(page, "music-test/a#main/special");
  expect(await page.evaluate(() => (window as any).__musicSnapshots.some((entry: any) => entry.restored && entry.events === 0))).toBe(true);
  expect(errors).toEqual([]);
});

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.locator("[data-story-player]"), async () => { await skipStory(page); });
});
