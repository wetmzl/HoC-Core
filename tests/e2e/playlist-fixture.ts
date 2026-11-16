import { expect, type Page } from "@playwright/test";

/** Use the game's existing confirmation dialog, with an explicit test choice. */
export async function respondToOfficialPlaylistCopy(page: Page, choice: "confirm" | "cancel"): Promise<void> {
  const prompt = page.locator("[data-game-dialog]");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("官方播放集");
  await expect(prompt).toContainText("副本");
  await prompt.locator(`[data-game-dialog-choice="${choice}"]`).click();
  await expect(prompt).toHaveCount(0);
}

/** Sorting tests use an editable copy; the official read-only path is tested separately. */
export async function selectEditablePlaylistCopy(page: Page): Promise<void> {
  await page.locator("[data-open-playlist-manager]").click();
  const rows = page.locator("[data-manage-playlist]");
  await rows.locator("[data-copy-playlist]").first().click();
  await expect(rows).toHaveCount(2);
  const copyId = await rows.last().getAttribute("data-manage-playlist");
  await page.locator("[data-close-playlist-manager]").click();
  await page.locator("[data-toggle-playlist-menu]").click();
  await page.locator(`[data-load-playlist="${copyId}"]`).click();
  await expect(page.locator(".playlist-current-name[data-embedded-default-playlist]")).toHaveCount(0);
}
