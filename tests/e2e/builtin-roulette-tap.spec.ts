import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mountBuiltinTap } from "./builtin-tap-fixture";

for (const id of ["chatgpt", "claude", "gemini", "deepseek", "llama"]) for (const [phase, actor] of [["roulette-reaction", "player"], ["roulette-trigger", "player"], ["roulette-trigger", "opponent"]] as const) test(`${id} ${phase} ${actor} 戳戳只换台词并保留轮盘立绘`, async ({ page }, testInfo) => {
  const lines = JSON.parse(readFileSync(`public/characters/${id}/resources/dialogue.json`, "utf8")).pools.CHARACTER_TAP_ROULETTE;
  await mountBuiltinTap(page, id, false, { phase, actor });
  const original = await page.locator(".character-portrait").getAttribute("src");
  const gun = await page.locator(".trigger-prop").count() ? await page.locator(".trigger-prop").getAttribute("style") : null;
  for (const width of actor === "opponent" ? [1280, 390, 320] : [390]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 390 ? 844 : 720 });
    await expect.poll(() => page.locator(".character-portrait").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const point = await page.locator(".character-portrait").evaluate(async (img: HTMLImageElement) => {
      const { imageContentBox, visibleCharacterImagePoint } = await import(/* @vite-ignore */ "/src/presentation/character-interaction.ts");
      const style = getComputedStyle(img), box = imageContentBox(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, style.objectFit, style.objectPosition, img.clientWidth, img.clientHeight)!;
      for (let y = .2; y < .8; y += .05) for (let x = .25; x < .8; x += .05) {
        const clientX = Math.round(box.left + box.width * x), clientY = Math.round(box.top + box.height * y);
        if (visibleCharacterImagePoint(img, clientX, clientY) && document.elementFromPoint(clientX, clientY) === img) return { x: clientX, y: clientY };
      }
      throw Error("No visible opaque point");
    });
    for (let count = 0; count < 3; count++) {
      await page.mouse.click(point.x, point.y);
      await expect.poll(async () => lines.includes(await page.locator("#dialogue-text").textContent())).toBe(true);
      await expect(page.locator(".character-portrait")).toHaveAttribute("src", original!);
    }
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", phase);
    if (gun !== null) await expect(page.locator(".trigger-prop")).toHaveAttribute("style", gun);
    await page.screenshot({ path: testInfo.outputPath(`${id}-${actor}-${phase}-${width}.png`), fullPage: true });
    await page.locator(".character-portrait").screenshot({ path: testInfo.outputPath(`${id}-${actor}-${phase}-${width}-portrait.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator(".character-portrait").focus(); await page.keyboard.press("Enter");
  await expect.poll(async () => lines.includes(await page.locator("#dialogue-text").textContent())).toBe(true);
  await expect(page.locator(".character-portrait")).toHaveAttribute("src", original!);
});
