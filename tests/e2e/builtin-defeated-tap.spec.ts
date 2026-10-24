import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mountBuiltinTap } from "./builtin-tap-fixture";

async function clickPortrait(page: Page) {
  await expect.poll(() => page.locator(".character-portrait").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const point = await page.locator(".character-portrait").evaluate(async (img: HTMLImageElement) => {
    const { imageContentBox } = await import(/* @vite-ignore */ "/src/presentation/character-interaction.ts");
    const style = getComputedStyle(img), box = imageContentBox(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, style.objectFit, style.objectPosition, img.clientWidth, img.clientHeight)!;
    const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(img, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let y = .2; y < .8; y += .05) for (let x = .25; x < .8; x += .05) {
      const clientX = box.left + box.width * x, clientY = box.top + box.height * y;
      if (pixels[(Math.floor(y * canvas.height) * canvas.width + Math.floor(x * canvas.width)) * 4 + 3] >= 16 && document.elementFromPoint(clientX, clientY) === img) return { x: clientX, y: clientY };
    }
    throw Error("No visible opaque portrait point");
  });
  await page.mouse.click(point.x, point.y);
}

for (const id of ["chatgpt", "claude", "gemini", "deepseek", "llama"]) test(`${id} 落败后戳戳使用专属台词及现有生气或害羞立绘`, async ({ page }, testInfo) => {
  const dialogue = JSON.parse(readFileSync(`public/characters/${id}/resources/dialogue.json`, "utf8"));
  const portrait = dialogue.rules.find((rule: { id: string }) => rule.id === "character-tap").portrait;
  await mountBuiltinTap(page, id, true);
  await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "roulette-result");
  const initialPortrait = await page.locator(".character-portrait").getAttribute("src");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 390 ? 844 : 720 });
    await clickPortrait(page);
    await expect(page.locator(".character-portrait")).toHaveAttribute("alt", portrait.alt);
    await expect(page.locator(".character-portrait")).not.toHaveAttribute("src", initialPortrait!);
    await expect.poll(async () => dialogue.pools.CHARACTER_TAP_DEFEATED.includes(await page.locator("#dialogue-text").textContent())).toBe(true);
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "roulette-result");
    await page.screenshot({ path: testInfo.outputPath(`${id}-defeated-tap-${width}.png`), fullPage: true });
    await page.locator(".character-portrait").screenshot({ path: testInfo.outputPath(`${id}-defeated-tap-portrait-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator(".character-portrait").focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".character-portrait")).toHaveAttribute("alt", portrait.alt);
  await expect.poll(async () => dialogue.pools.CHARACTER_TAP_DEFEATED.includes(await page.locator("#dialogue-text").textContent())).toBe(true);
  await page.locator("button[data-action*=ACK_TRIGGER_RESULT]").click();
  await expect(page.locator("main.summary-shell")).toBeVisible();
});
