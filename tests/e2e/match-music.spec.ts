import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";

// Built-in, public-safe fixtures; all audio is generated for this test.
function musicPackage(name: "chatgpt" | "official-factions", withMusic = true) {
  const root = `public/characters/${name}`;
  const manifest = JSON.parse(readFileSync(`${root}/hocpkg-info.json`, "utf8"));
  manifest.identity.version = withMusic ? "1.99.0" : "1.99.1";
  const files: Record<string, Uint8Array> = {};
  for (const file of manifest.files) files[file.path] = readFileSync(`${root}/${file.path}`);
  const descriptor = manifest.resources.find((r: { type: string }) => r.type === (name === "chatgpt" ? "game.character-match" : "presentation.faction"));
  descriptor.apiVersion = Math.max(descriptor.apiVersion, name === "chatgpt" ? 8 : 2);
  const body = JSON.parse(Buffer.from(files[descriptor.entry]).toString());
  if (withMusic) {
    (name === "chatgpt" ? body.metadata : body).matchMusic = "bgm/test.wav";
    files["bgm/test.wav"] = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${name === "chatgpt" ? 440 : 660}:duration=1`, "-f", "wav", "pipe:1"]);
  }
  files[descriptor.entry] = Buffer.from(JSON.stringify(body));
  manifest.files = Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: path.endsWith(".wav") ? "audio/wav" : manifest.files.find((file: { path: string }) => file.path === path).mediaType }));
  return Buffer.from(zipSync({ ...files, "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)) }));
}
async function manager(page: Page) { await page.locator("[data-open-packages]").click(); }
async function install(page: Page, name: "chatgpt" | "official-factions", withMusic = true) {
  await page.locator("[data-import-file]").setInputFiles({ name: `${name}.hocpkg`, mimeType: "application/zip", buffer: musicPackage(name, withMusic) });
  await page.locator("[data-import-next]").click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
}
async function playing(page: Page, kind: "character" | "faction" | "default") {
  // A resumed runtime waits for its first table gesture before unlocking audio.
  await page.getByRole("heading", { name: "命运牌桌" }).click();
  await expect.poll(() => page.evaluate(async kind => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const character = await (await load("/src/content/characters/loader.ts")).loadCharacter("chatgpt");
    const sources = character.matchMusicSources;
    const url = kind === "default" ? (await load("/src/resources/cache-policy.ts")).TABLE_BGM_URL : sources[0];
    const track = (window as any).__musicElements.findLast((audio: HTMLAudioElement) => audio.src.endsWith(url));
    return (sources?.length ?? 0) === (kind === "character" ? 2 : kind === "faction" ? 1 : 0) && !!track && !track.paused && track.currentTime > 0 && Math.abs(track.volume - .32) < .001 && track.loop;
  }, kind)).toBe(true);
}

test("imported character and faction music plays, resumes, and falls back after disabling the faction", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => {
    await dialog.getByRole("button", { name: "我已成年并继续" }).click();
  });
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    (window as any).__musicElements = [];
    window.Audio = function (src?: string) {
      const audio = new NativeAudio(src); (window as any).__musicElements.push(audio); return audio;
    } as typeof Audio;
    window.Audio.prototype = NativeAudio.prototype;
  });
  await page.goto("/"); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async () => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = true; save.settings.musicVolume = .32;
    save.defeats = [{ opponentId: "chatgpt", timestamp: "2026-10-24T00:00:00.000Z" }];
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  });
  await manager(page); await install(page, "chatgpt"); await install(page, "official-factions");
  await page.locator("[data-close-packages]").click();
  await page.locator("[data-start-game]").click(); await page.locator("[data-enter-duel]").click();
  await page.locator('[data-invite-character="chatgpt"]').click(); await page.locator('[data-profile-start="chatgpt"]').click();
  await expect(page.locator(".table-bottom")).toBeVisible(); await playing(page, "character");
  await page.reload(); await page.locator("[data-start-game]").click();
  await expect(page.locator(".table-bottom")).toBeVisible(); await playing(page, "character");

  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await manager(page); await install(page, "chatgpt", false); await page.locator("[data-close-packages]").click();
  await page.locator("[data-start-game]").click(); await expect(page.locator(".table-bottom")).toBeVisible(); await playing(page, "faction");
  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled(); await manager(page);
  await page.locator('.package-card[data-package-id="hoc-core/official-factions"] [data-package-action="disable"]').click();
  await page.locator("[data-close-packages]").click(); await page.locator("[data-start-game]").click();
  await expect(page.locator(".table-bottom")).toBeVisible(); await playing(page, "default");
  expect(errors).toEqual([]);
});
