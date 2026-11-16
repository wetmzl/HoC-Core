import { skipStory } from "./story-platform-fixture";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { respondToOfficialPlaylistCopy } from "./playlist-fixture";

const openingId = "hoc-core/official-story#opening";
const secondId = "hoc-core/official-story#after-deepseek";
const opening: { nodes: { id: string; type: string; speaker?: string; segments?: { text?: string }[] }[] } = JSON.parse(readFileSync(new URL("../../public/characters/official-story/resources/opening.json", import.meta.url), "utf8"));
const story = (page: Page) => page.locator("[data-story-player]");
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await load("/src/persistence/factory.ts")).createPersistenceService().readSnapshot();
  });
}
async function seed(page: Page, records = false) {
  await page.evaluate(async records => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave("2026-11-14T00:00:00.000Z");
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    let notebook = null;
    if (records) {
      const history = (id: string, opponentId: string, winner: string | null, escaped: boolean) => ({ id, opponentId, winner, escaped,
        timestamp: "2026-11-14T00:00:00.000Z", finalRoulette: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
        busts: { player: 0, opponent: 0 }, blackjacks: { player: 0, opponent: 0 } });
      // Controlled pre-existing records, not a claim of naturally playing these games.
      save.history = [history("legacy-loss", "llama", "opponent", false), history("legacy-escape", "deepseek", null, true)];
      save.defeats = [{ opponentId: "gemini", timestamp: "2026-11-14T00:00:00.000Z" }];
      notebook = { format: "hoc-notebook-save", schemaVersion: 1, characters: [
        { characterId: "qwen", endings: ["playerVictory", "playerDefeat", "escaped"] },
        { characterId: "absent/visitor", endings: ["playerDefeat"] }
      ] };
    }
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    await repository.projectSnapshot((current: any) => ({ ...current, longTerm: save, runtime: null, story: null, notebook }), { notebookReplacement: true });
  }, records);
}
async function start(page: Page) {
  await page.locator("[data-start-game]").click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
}
async function openNotebook(page: Page, section?: "stories" | "records") {
  const entry = page.locator("[data-open-notebook]");
  await expect(entry).toHaveAccessibleName(/笔记本/);
  await expect(entry.locator("svg")).toHaveCount(1);
  await entry.click();
  await expect(page.locator('[data-notebook-page="home"]')).toBeVisible();
  if (section) await page.locator(`[data-notebook-section="${section}"]`).click();
}
async function expectNoOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const shell = (await page.locator(".notebook-shell").boundingBox())!;
  expect(shell.x).toBeGreaterThanOrEqual(-1);
  expect(shell.x + shell.width).toBeLessThanOrEqual(width + 1);
  expect(shell.width).toBeLessThanOrEqual(Math.min(width, 390) + 1);
  expect(Math.abs(shell.x + shell.width / 2 - width / 2)).toBeLessThanOrEqual(1);
}
/** Inspect the visible alpha silhouette; transparent image-canvas overflow is intentional. */
async function artGeometry(page: Page, selector: string) {
  const frames = page.locator(selector);
  for (const frame of await frames.all()) await expect(frame).toHaveAttribute("data-notebook-art-ready", /^(trimmed|full)$/);
  const geometry = await frames.evaluateAll(nodes => nodes.map(frame => {
    const image = frame.querySelector<HTMLImageElement>("img")!;
    const outer = frame.getBoundingClientRect(), canvas = image.getBoundingClientRect();
    const bounds = JSON.parse((frame as HTMLElement).dataset.notebookArtBounds!);
    const scale = canvas.width / image.naturalWidth;
    return { frame: { x: outer.x, y: outer.y, width: outer.width, height: outer.height },
      body: { x: canvas.x + bounds.x * scale, y: canvas.y + bounds.y * scale, width: bounds.width * scale, height: bounds.height * scale },
      scale, containScale: Math.min(outer.width / image.naturalWidth, outer.height / image.naturalHeight) };
  }));
  for (const { frame, body, scale, containScale } of geometry) {
    expect(body.x).toBeGreaterThanOrEqual(frame.x - 1);
    expect(body.y).toBeGreaterThanOrEqual(frame.y - 1);
    expect(body.x + body.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
    expect(body.y + body.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
    expect(Math.abs(body.x + body.width / 2 - frame.x - frame.width / 2)).toBeLessThanOrEqual(1.1);
    expect(Math.abs(body.y + body.height / 2 - frame.y - frame.height / 2)).toBeLessThanOrEqual(1.1);
    expect(scale).toBeGreaterThanOrEqual(containScale - 0.01);
  }
  return geometry;
}
async function back(page: Page) { await page.locator("[data-notebook-back]").click(); }

test.beforeEach(async ({ page }) => {

  await page.addLocatorHandler(page.locator("[data-acknowledge-third-party-content]"), async button => { await button.click(); });
  await page.addLocatorHandler(page.locator("[data-acknowledge-adult-content]"), async button => { await button.click(); });
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled({ timeout: 90_000 });
  await seed(page);
});

test("an imported legacy Claude victory unlocks all five stories without autoplay, ledger writes or gameplay effects", async ({ page }, info) => {
  test.setTimeout(180_000);
  const legacy = (await snapshot(page)).longTerm;
  legacy.defeats = [{ opponentId: "claude", timestamp: "2026-11-14T00:00:00.000Z" }];
  // Public legacy import has neither a story ledger nor explicit flow-completion records.
  delete legacy.completedFlows; delete legacy.completedChallenges;
  await page.locator("[data-open-launcher-settings]").click();
  await page.locator("[data-launcher-save-file]").setInputFiles({ name: "legacy-claude.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy)) });
  await page.locator('[data-game-dialog-choice="confirm"]').click();
  await expect(page.locator("[data-launcher-save-status]")).toContainText("存档已导入");
  await page.locator("[data-close-launcher-settings]").click();
  await start(page); await openNotebook(page, "stories");
  await expect(story(page)).toHaveCount(0);
  const ids = ["opening", "after-deepseek", "after-chatgpt", "claude-invitation", "after-claude"].map(id => `hoc-core/official-story#${id}`);
  expect(await page.locator("[data-notebook-play]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.notebookPlay))).toEqual(ids);
  const before = await snapshot(page);
  expect(before.story?.active ?? null).toBeNull(); expect(before.story?.queue ?? []).toEqual([]);
  expect(before.story?.once ?? []).toEqual([]); expect(before.story?.completed ?? []).toEqual([]);
  await page.screenshot({ path: info.outputPath("legacy-chapter-archive.png"), animations: "disabled" });
  for (const id of ids) {
    await page.locator(`[data-notebook-play="${id}"]`).click();
    await expect(story(page)).toBeVisible(); await skipStory(page);
    await expect(story(page)).toHaveCount(0);
    await expect(page.locator('[data-notebook-page="stories"]')).toBeVisible();
    await expect(page.locator(".table-bottom")).toHaveCount(0);
    const after = await snapshot(page);
    for (const key of ["longTerm", "runtime", "story", "notebook"]) expect(after[key]).toEqual(before[key]);
  }
  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-open-packages]").click();
  const card = page.locator('.package-card[data-package-id="hoc-core/official-story"]');
  await card.locator('[data-package-action="disable"]').click();
  await respondToOfficialPlaylistCopy(page, "confirm");
  await expect(card).toHaveAttribute("data-package-state", "disabled");
  await page.locator("[data-close-packages]").click();
  await start(page); await openNotebook(page, "stories");
  await expect(page.locator("[data-notebook-play]")).toHaveCount(0);
  await expect(story(page)).toHaveCount(0);
  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.locator("[data-open-packages]").click();
  await card.locator('[data-package-action="enable"]').click();
  await expect(card).toHaveAttribute("data-package-state", "enabled");
  await page.locator("[data-close-packages]").click();
  await start(page); await openNotebook(page, "stories");
  await expect(page.locator("[data-notebook-play]")).toHaveCount(5);
  await expect(story(page)).toHaveCount(0);
  const restored = await snapshot(page);
  expect(restored.story).toEqual(before.story);
  expect(restored.longTerm.defeats).toEqual(legacy.defeats);
});

for (const [defeated, count] of [[['llama'], 1], [['deepseek'], 2], [['chatgpt'], 3], [['grok', 'gemini', 'qwen', 'glm'], 4]] as const) {
  test(`existing progress ${defeated.join(",")} exposes ${count} chapters without automatically playing`, async ({ page }) => {
    await page.evaluate(async defeated => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
      await repository.projectSnapshot((current: any) => ({ ...current,
        longTerm: { ...current.longTerm, defeats: defeated.map(opponentId => ({ opponentId, timestamp: "2026-11-14T00:00:00.000Z" })) }
      }));
    }, defeated);
    await start(page); await openNotebook(page, "stories");
    await expect(page.locator("[data-notebook-play]")).toHaveCount(count);
    await expect(page.locator('[data-notebook-play="hoc-core/official-story#after-claude"]')).toHaveCount(0);
    await expect(story(page)).toHaveCount(0);
    const stored = await snapshot(page);
    expect(stored.story?.once ?? []).toEqual([]); expect(stored.story?.completed ?? []).toEqual([]);
  });
}

test("fresh notebook has a vector icon beside Settings, two submenus and no untriggered story entries", async ({ page }, info) => {
  await start(page);
  const notebookIcon = page.locator('[data-open-notebook]');
  await expect(notebookIcon).toHaveCount(1);
  await expect(page.locator('.lobby-header-tools [data-open-notebook]')).toHaveCount(1);
  await expect(page.locator('[data-ui-slot="main-menu.secondary"] [data-open-notebook]')).toHaveCount(0);
  await expect(notebookIcon).toHaveClass(/lobby-round-button/);
  for (const width of [320, 390, 630, 1280]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    const iconBox = (await notebookIcon.boundingBox())!, headerBox = (await page.locator(".lobby-invitation").boundingBox())!;
    const settingsBox = (await page.locator('.lobby-header-tools [data-open="settings"]').boundingBox())!;
    expect(iconBox.width).toBe(settingsBox.width);
    expect(Math.abs(iconBox.width - iconBox.height)).toBeLessThanOrEqual(1);
    expect(iconBox.y).toBeGreaterThanOrEqual(headerBox.y);
    expect(iconBox.y + iconBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
    expect(Math.abs(iconBox.y - settingsBox.y)).toBeLessThanOrEqual(1);
    expect(iconBox.x).toBeGreaterThan(settingsBox.x + settingsBox.width);
    const toolRows = await page.locator('.lobby-header-tools > button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    expect(Math.max(...toolRows) - Math.min(...toolRows)).toBeLessThanOrEqual(1);
    await expect(notebookIcon).toHaveCSS("border-radius", "50%");
    await expect(notebookIcon.locator("svg")).toHaveCSS("width", "18px");
    await expect(notebookIcon.locator("svg")).toHaveCSS("height", "18px");
    await expect(notebookIcon.locator("svg")).toHaveCSS("fill", "none");
    const vectorBox = (await notebookIcon.locator("svg").boundingBox())!;
    expect(Math.abs(vectorBox.x + vectorBox.width / 2 - iconBox.x - iconBox.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(vectorBox.y + vectorBox.height / 2 - iconBox.y - iconBox.height / 2)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await notebookIcon.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: info.outputPath(`notebook-toolbar-${width}.png`), animations: "disabled" });
  }
  await openNotebook(page);
  await expect(page.locator("[data-notebook-section]")).toHaveCount(2);
  await expect(page.locator('[data-notebook-section="stories"]')).toContainText("剧情档案馆");
  await expect(page.locator('[data-notebook-section="records"]')).toContainText("个人记录");
  await page.locator('[data-notebook-section="stories"]').click();
  await expect(page.locator(".notebook-story-card")).toHaveCount(0);
  await expect(page.locator("[data-notebook-play]")).toHaveCount(0);
  await expect(page.getByText("还没有剧情记录", { exact: true })).toBeVisible();
  await back(page); await page.locator('[data-notebook-section="records"]').click();
  await expect(page.getByText("还没有人物记录", { exact: true })).toBeVisible();
  await expect(page.locator("[data-notebook-character]")).toHaveCount(0);
  await back(page); await back(page);
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  await expect(story(page)).toHaveCount(0);
});

for (const ending of ["completed", "skipped", "interrupted"] as const) {
  test(`replay ${ending} returns to story archive without writing true progress or opening a table`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await start(page);
    await page.locator("[data-enter-duel]").click();
    await expect(story(page)).toBeVisible();
    await skipStory(page);
    await expect(story(page)).toHaveCount(0);
    await page.locator("[data-lobby-home]").click();
    await openNotebook(page, "stories");
    await expect(page.locator(`[data-notebook-play="${openingId}"]`)).toBeEnabled();
    await expect(page.locator(`[data-notebook-play="${secondId}"]`)).toHaveCount(0);
    await expect(page.locator(".notebook-story-card")).toHaveCount(1);
    const archiveCard = page.locator(".notebook-story-card");
    await expect(archiveCard.locator("h2")).toHaveText("从现在开始慢慢记录");
    await expect(archiveCard.locator("p")).not.toHaveText("");
    await archiveCard.locator("img").scrollIntoViewIfNeeded();
    await expect.poll(() => archiveCard.locator("img").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const imageShape = await archiveCard.locator("img").evaluate(async node => {
      const image = node as HTMLImageElement;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, source: image.getAttribute("src") };
    });
    expect(imageShape.source).not.toContain("gambling-table");
    const characterCover = await sharp(readFileSync(new URL("../../public/characters/deepseek/cover.png", import.meta.url))).metadata();
    expect(imageShape.width).toBe(characterCover.width);
    expect(imageShape.height).toBe(characterCover.height);
    const before = await snapshot(page);
    expect(before.story.completed.find((entry: any) => entry.sceneId === openingId).status).toBe("skipped");
    if (ending === "completed") await page.setViewportSize({ width: 1280, height: 844 });
    await page.locator(`[data-notebook-play="${openingId}"]`).click();
    await expect(story(page)).toBeVisible();
    if (ending === "completed") {
      const modal = await story(page).evaluate(node => {
        const color = (value: string) => {
          const channels = value.match(/[\d.]+/g)!.map(Number);
          return { rgb: channels.slice(0, 3), alpha: channels[3] ?? 1 };
        };
        return { isModal: node.matches(":modal"),
          background: color(getComputedStyle(node).backgroundColor),
          backdrop: color(getComputedStyle(node, "::backdrop").backgroundColor) };
      });
      expect(modal.isModal).toBe(true);
      expect(modal.background.alpha).toBe(1);
      expect(modal.backdrop.alpha).toBe(1);
      const playerBox = (await story(page).boundingBox())!;
      expect(playerBox.width).toBeLessThanOrEqual(390);
      expect(Math.abs(playerBox.x + playerBox.width / 2 - 640)).toBeLessThanOrEqual(1);
      // Screenshot pixels outside the portrait canvas must be the opaque modal
      // backdrop, with none of the still-mounted archive/menu showing through.
      const screenshot = await page.screenshot({ path: info.outputPath("story-backdrop-desktop.png") });
      const pixels = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (const x of [Math.floor(pixels.info.width * .1), Math.floor(pixels.info.width * .9)]) {
        for (const y of [.1, .5, .9].map(ratio => Math.floor(pixels.info.height * ratio))) {
          const offset = (y * pixels.info.width + x) * pixels.info.channels;
          expect([...pixels.data.subarray(offset, offset + 3)]).toEqual(modal.backdrop.rgb);
        }
      }
      await page.clock.install();
      for (const line of opening.nodes.filter(node => node.type === "say")) {
        await page.clock.fastForward(10000);
        await expect(story(page).locator(".story-text")).toHaveText(line.segments!.map(segment => segment.text ?? "").join(""));
        await expect(story(page).locator(".story-speaker")).toHaveText(line.speaker ?? "");
        if (line.speaker === "DeepSeek" || line.speaker === "Llama") {
          const actor = story(page).locator(`[data-story-actor="${line.speaker === "DeepSeek" ? "deepseek" : "llama"}"]`);
          await expect(actor).toBeVisible();
          await expect.poll(() => actor.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
        {
          const backdrop = story(page).locator(".story-stage-background");
          await expect(backdrop).toHaveCSS("background-image", /url\(.+\)/);
          const loaded = await backdrop.evaluate(async node => {
            const css = getComputedStyle(node).backgroundImage;
            const src = css.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
            if (!src) return false;
            const image = new Image(); image.src = src;
            try { await image.decode(); return image.naturalWidth > 0; } catch { return false; }
          });
          expect(loaded).toBe(true);
        }
        await story(page).locator(".story-text").click();
      }
    } else if (ending === "skipped") await skipStory(page);
    else {
      await page.keyboard.press("Escape");
      await story(page).getByRole("button", { name: "退出剧情", exact: true }).click();
    }
    await expect(story(page)).toHaveCount(0);
    await expect(page.locator('[data-notebook-page="stories"]')).toBeVisible();
    await expect(page.locator(`[data-notebook-play="${openingId}"]`)).toBeEnabled();
    await expect(page.locator(".table-bottom")).toHaveCount(0);
    const after = await snapshot(page);
    expect(after.story).toEqual(before.story);
    expect(after.longTerm).toEqual(before.longTerm);
    expect(after.notebook).toEqual(before.notebook);
    expect(after.runtime).toEqual(before.runtime);
    expect(after.runtime?.activeMatch ?? null).toBeNull();
    await back(page); await back(page);
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
    await page.locator("[data-enter-duel]").click();
    await expect(page.locator(".lobby-character-shell")).toBeVisible();
    await expect(story(page)).toHaveCount(0);
  });
}

for (const width of [320, 390, 1280]) {
  test(`personal records read old losses, old victories and sidecar endings with no overflow at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    await seed(page, true); await start(page); await openNotebook(page, "records");
    await expectNoOverflow(page, width);
    for (const id of ["llama", "deepseek", "gemini", "qwen"]) await expect(page.locator(`[data-notebook-character="${id}"]`)).toBeVisible();
    await expect(page.locator(".notebook-record-list")).toContainText("absent/visitor");
    await expect(page.locator(".notebook-record-list")).toContainText("资源不可用");
    await page.locator('[data-notebook-character="llama"]').click();
    await expect(page.locator(".notebook-character-heading h1")).toHaveText("Llama");
    const authored = await page.evaluate(async () => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const character = await (await load("/src/content/characters/loader.ts")).loadCharacter("llama");
      return { dialogue: [...new Set(Object.values(character.dialogue.pools).flat())], table: character.tablePortrait.images.map((image: any) => image.image), defeat: character.matchSummary.playerDefeat };
    });
    await expect(page.locator(".notebook-dialogue-list li")).toHaveCount(authored.dialogue.length);
    await expectNoOverflow(page, width);
    await page.locator('[data-notebook-tab="portraits"]').click();
    for (const card of await page.locator(".notebook-portrait-card").all()) {
      await card.scrollIntoViewIfNeeded();
      await expect.poll(() => card.locator("img").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    const shown = await page.locator(".notebook-portrait-card img").evaluateAll(nodes => nodes.map(node => node.getAttribute("src")));
    for (const image of authored.table) expect(shown).toContain(image);
    const grid = (await page.locator(".notebook-portrait-grid").boundingBox())!;
    const portraits = await artGeometry(page, '.notebook-portrait-grid [data-notebook-art-frame]');
    for (const { frame } of portraits) expect(frame.width).toBeGreaterThanOrEqual(grid.width * 0.9);
    expect(await page.locator(".notebook-portrait-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(1);
    // Llama's first authored PNG has transparent margins; the visible figure must grow.
    expect(portraits[0].scale).toBeGreaterThan(portraits[0].containScale * 1.1);
    await expectNoOverflow(page, width);
    await page.locator(".notebook-portrait-card").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`notebook-portraits-${width}.png`) });
    await page.locator(".notebook-portrait-card").first().click();
    await expect(page.locator("[data-notebook-image-dialog]")).toBeVisible();
    await expect(page.locator("[data-notebook-image-dialog]")).toHaveCSS("opacity", "1");
    await artGeometry(page, '[data-notebook-image-dialog] [data-notebook-art-frame]');
    await page.getByRole("button", { name: "关闭立绘", exact: true }).click();
    await page.locator('[data-notebook-tab="endings"]').click();
    await expect(page.locator("[data-notebook-ending]")).toHaveCount(3);
    await expect(page.locator('[data-notebook-ending="playerDefeat"] p')).toHaveText(authored.defeat);
    await expect(page.locator('[data-notebook-ending="playerDefeat"] img')).toBeVisible();
    for (const id of ["playerVictory", "escaped"]) {
      const card = page.locator(`[data-notebook-ending="${id}"]`);
      await expect(card).toHaveClass(/is-locked/);
      await expect(card.locator("img")).toHaveCount(0);
      await expect(card).toContainText("尚未收录");
    }
    await expectNoOverflow(page, width);
    await back(page); await page.locator('[data-notebook-character="qwen"]').click();
    await expect(page.locator(".notebook-character-heading h1")).toHaveText("Qwen");
    await page.locator('[data-notebook-tab="endings"]').click();
    await expect(page.locator(".notebook-ending-card.is-locked")).toHaveCount(0);
    await expect(page.locator(".notebook-ending-card img")).toHaveCount(3);
    for (const image of await page.locator(".notebook-ending-card img").all()) {
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    await expectNoOverflow(page, width);
    const endings = await artGeometry(page, '.notebook-ending-list [data-notebook-art-frame]');
    const endingList = (await page.locator(".notebook-ending-list").boundingBox())!;
    for (const { frame } of endings) expect(frame.width).toBeGreaterThanOrEqual(endingList.width * 0.9);
    await page.screenshot({ path: info.outputPath(`notebook-endings-${width}.png`) });
    await back(page);
    for (const [id, unlocked] of [["gemini", "playerVictory"], ["deepseek", "escaped"]] as const) {
      await page.locator(`[data-notebook-character="${id}"]`).click();
      await page.locator('[data-notebook-tab="endings"]').click();
      await expect(page.locator(`[data-notebook-ending="${unlocked}"] img`)).toBeVisible();
      await expect(page.locator(".notebook-ending-card.is-locked")).toHaveCount(2);
      await back(page);
    }
    await back(page); await back(page);
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  });
}


test("notebook preserves the phone canvas and typography when opened on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, true); await start(page); await openNotebook(page, "records");
  await page.locator('[data-notebook-character="llama"]').click();
  await page.locator('[data-notebook-tab="portraits"]').click();
  const metrics = () => page.locator(".notebook-shell").evaluate(shell => {
    const box = shell.getBoundingClientRect(), heading = shell.querySelector("h1")!, tab = shell.querySelector(".notebook-tabs button")!, frame = shell.querySelector("[data-notebook-art-frame]")!;
    return { width: box.width, heading: getComputedStyle(heading).fontSize, tab: getComputedStyle(tab).fontSize,
      padding: getComputedStyle(shell).paddingLeft, artWidth: frame.getBoundingClientRect().width,
      columns: getComputedStyle(shell.querySelector(".notebook-portrait-grid")!).gridTemplateColumns.split(" ").length };
  });
  const mobile = await metrics();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect.poll(metrics).toEqual(mobile);
  expect(mobile.width).toBeLessThanOrEqual(390); expect(mobile.columns).toBe(1);
  await expectNoOverflow(page, 1280);
});
