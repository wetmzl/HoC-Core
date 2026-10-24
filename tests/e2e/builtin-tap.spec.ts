import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mountBuiltinTap } from "./builtin-tap-fixture";
for (const id of ["chatgpt", "claude", "gemini", "deepseek", "llama"]) test(`内嵌角色 ${id} 未标定立绘触发全立绘`, async ({ page }, testInfo) => {
  const dialogue = JSON.parse(readFileSync(`public/characters/${id}/resources/dialogue.json`, "utf8"));
  const rule = dialogue.rules.find((r: { id: string }) => r.id === "character-tap");
  await mountBuiltinTap(page, id);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : width === 390 ? 844 : 720 });
    await expect.poll(() => page.locator(".character-portrait").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const point = await page.locator(".character-portrait").evaluate(async (img: HTMLImageElement) => {
      const { imageContentBox } = await import(/* @vite-ignore */ "/src/presentation/character-interaction.ts");
      const style = getComputedStyle(img), box = imageContentBox(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight, style.objectFit, style.objectPosition, img.clientWidth, img.clientHeight);
      return { x: box!.left + box!.width * .5, y: box!.top + box!.height * .25 };
    });
    const previousText = await page.locator("#dialogue-text").elementHandle();
    await page.mouse.click(point.x, point.y);
    // The portrait/line commit replaces the table DOM, even when the selected art repeats.
    await expect.poll(() => previousText!.evaluate(node => node.isConnected)).toBe(false);
    await expect(page.locator(".character-portrait")).toHaveAttribute("alt", rule.portrait.alt);
    await expect.poll(async () => dialogue.pools.CHARACTER_TAP.includes(await page.locator("#dialogue-text").textContent())).toBe(true);
    const current = await page.locator("#dialogue-text").textContent(); await page.clock.runFor(100);
    await expect(page.locator("#dialogue-text")).toHaveText(current!);
    await page.screenshot({ path: testInfo.outputPath(`${id}-tap-table-${width}.png`), fullPage: true });
    await page.locator(".character-portrait").screenshot({ path: testInfo.outputPath(`${id}-tap-crop-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "Hit 要牌", exact: true }).click();
  await expect(page.locator(".character-portrait")).not.toHaveAttribute("alt", rule.portrait.alt);
});
