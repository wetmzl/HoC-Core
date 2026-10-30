import { expect, type Locator } from "@playwright/test";

/** Check the shared disclosure in its real host, including narrow-screen typography. */
export async function expectSkillSheet(sheet: Locator): Promise<void> {
  await expect(sheet.locator(".skill-sheet-brief")).toBeVisible();
  await expect(sheet.locator(".skill-sheet-expanded")).toBeHidden();
  await expect(sheet).not.toContainText("详细规则");
  await expect(sheet).not.toContainText("技能故事");
  await sheet.locator("summary").click();
  await expect(sheet.locator(".skill-sheet-expanded")).toBeVisible();
  const layout = await sheet.evaluate(element => {
    const title = element.querySelector("strong")!;
    const rules = element.querySelector<HTMLElement>(".skill-sheet-rules p");
    const lore = element.querySelector<HTMLElement>(".skill-sheet-lore");
    return { titleX: title.getBoundingClientRect().x, rulesX: rules?.getBoundingClientRect().x,
      loreX: lore?.getBoundingClientRect().x, loreStyle: lore && getComputedStyle(lore.querySelector("em")!).fontStyle };
  });
  if (layout.rulesX !== undefined) expect(layout.rulesX).toBeGreaterThan(layout.titleX);
  if (layout.loreX !== undefined) {
    expect(layout.loreX).toBeGreaterThan(layout.rulesX ?? layout.titleX);
    expect(layout.loreStyle).toBe("italic");
  }
  await sheet.locator("summary").click();
  await expect(sheet.locator(".skill-sheet-expanded")).toBeHidden();
}
