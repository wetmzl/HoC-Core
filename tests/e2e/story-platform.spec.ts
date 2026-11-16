import { test, expect, type Locator, type Page } from "@playwright/test";
import { skipStory, readStoryComposition, STORY_FIXTURE_TEXT, storyPlatformPackage, tapStory } from "./story-platform-fixture";
import { respondToOfficialPlaylistCopy } from "./playlist-fixture";

const STORY_VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 720 }];

async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  const innerBox = (await inner.boundingBox())!, outerBox = (await outer.boundingBox())!;
  expect(innerBox.x).toBeGreaterThanOrEqual(outerBox.x - 1);
  expect(innerBox.y).toBeGreaterThanOrEqual(outerBox.y - 1);
  expect(innerBox.x + innerBox.width).toBeLessThanOrEqual(outerBox.x + outerBox.width + 1);
  expect(innerBox.y + innerBox.height).toBeLessThanOrEqual(outerBox.y + outerBox.height + 1);
}

/** Check rendered geometry and usable controls rather than duplicating CSS declarations. */
async function expectNarrowStoryLayout(page: Page): Promise<void> {
  const player = page.locator("[data-story-player]"), viewport = page.viewportSize()!;
  const box = (await player.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(Math.min(390, viewport.width));
  expect(Math.abs(box.x - (viewport.width - box.width) / 2)).toBeLessThanOrEqual(1);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dialogue = player.locator(".story-dialogue");
  await expectInside(dialogue, player);
  const dialogueBox = (await dialogue.boundingBox())!;
  expect(box.y + box.height - dialogueBox.y - dialogueBox.height).toBeGreaterThanOrEqual(12);
  await expectInside(player.locator(".story-text"), dialogue);
  for (const button of await player.locator(".story-player-controls button").all()) {
    await expectInside(button, player);
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const actors = player.locator(".story-stage-actors"), actorsBox = (await actors.boundingBox())!;
  expect(actorsBox.height).toBeGreaterThan(0);
  expect(actorsBox.y + actorsBox.height).toBeGreaterThan((await dialogue.boundingBox())!.y);
  for (const actor of await actors.locator(".story-actor:visible").all()) await expectInside(actor, actors);
}

async function install(page: Page, startup = false): Promise<void> {
  await page.locator("[data-open-packages]").click();
  await page.locator("[data-import-file]").setInputFiles({ name: "story-platform.hocpkg", mimeType: "application/zip", buffer: storyPlatformPackage(startup) });
  await page.locator("[data-import-next]").click();
  await expect(page.locator("[data-import-dialog]")).toHaveCount(0);
  const card = page.locator('.package-card[data-package-id="test/story-platform"]');
  if (await card.getAttribute("data-package-state") === "disabled") {
    await card.locator('[data-package-action="enable"]').click();
    await respondToOfficialPlaylistCopy(page, "confirm");
  }
  await expect(card).toHaveAttribute("data-package-state", "enabled");
  await page.locator("[data-close-packages]").click();
}
async function start(page: Page): Promise<void> {
  await page.locator("[data-start-game]").click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__storyProbe?.context.stories))).toBe(true);
}
async function play(page: Page, scene: string): Promise<void> { await page.evaluate(id => (window as any).__storyProbe.play(id), scene); }
async function state(page: Page): Promise<any> { return page.evaluate(() => (window as any).__storyProbe.state()); }
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    return (await load("/src/persistence/factory.ts")).createPersistenceService().readSnapshot();
  });
}

test.beforeEach(async ({ page }) => {

  await page.addLocatorHandler(page.locator("#third-party-content-warning"), async dialog => { await dialog.locator("[data-acknowledge-third-party-content]").click(); });
  await page.addLocatorHandler(page.locator("#adult-content-warning"), async dialog => { await dialog.locator("[data-acknowledge-adult-content]").click(); });
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const save = (await load("/src/persistence/boot.ts")).createDefaultSave(); save.skipTutorial = true;
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  });
});

test("package event starts a story; skip retains required choice and durable legal reward through reload", async ({ page }) => {
  await install(page, true); await start(page);
  const player = page.locator("[data-story-player]");
  await expect(player).toBeVisible();
  expect(await player.evaluate(element => element.matches(":modal"))).toBe(true);
  const actor = player.locator('[data-story-actor="guide"]');
  await expect.poll(() => actor.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
  await expect.poll(async () => (await snapshot(page)).story?.active?.run.stage.actors.guide?.x).toBe(70);
  await expect(player.locator(".story-speaker")).toHaveText("引导员");
  await expect(player).toHaveAttribute("data-story-typing", "true");
  const typing = (await state(page)).run;
  const readingArea = (await player.locator(".story-stage-actors").boundingBox())!;
  await page.mouse.click(readingArea.x + 4, readingArea.y + readingArea.height / 2);
  await expect(player.locator(".story-text")).toHaveText(STORY_FIXTURE_TEXT);
  expect((await state(page)).run.sequence).toBe(typing.sequence);
  for (const viewport of STORY_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectNarrowStoryLayout(page);
    const stageBox = (await player.locator(".story-stage-actors").boundingBox())!, actorBox = (await actor.boundingBox())!;
    expect(Math.abs(actorBox.x + actorBox.width / 2 - stageBox.x - stageBox.width / 2)).toBeLessThanOrEqual(1);
  }
  await player.getByRole("button", { name: "回看", exact: true }).click();
  await expect(player.locator(".story-log")).toContainText(STORY_FIXTURE_TEXT);
  await page.keyboard.press("Escape"); await expect(player.locator(".story-log")).toBeHidden();
  await page.keyboard.press("Escape"); await expect(player.locator(".story-exit")).toBeVisible();
  await player.getByRole("button", { name: "继续播放", exact: true }).click();
  await skipStory(page);
  await expect(player.locator(".story-text")).toHaveText("请选择演示路径");
  await expect(player.getByRole("button", { name: "尚不可用" })).toBeDisabled();
  await expect(player).toContainText("需要先满足测试条件");
  await expect(player.locator(".story-status")).toContainText("跳过已暂停");
  for (const viewport of STORY_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectNarrowStoryLayout(page);
    const choices = player.locator(".story-choices"), locked = player.getByRole("button", { name: "尚不可用" });
    await locked.scrollIntoViewIfNeeded();
    await expectInside(locked, choices);
    const earn = player.getByRole("button", { name: "解锁测试服装", exact: true });
    await earn.scrollIntoViewIfNeeded();
    await expectInside(earn, choices);
    await expect(earn).toBeEnabled();
  }
  const runId = (await state(page)).run.id;
  await page.reload(); await start(page);
  await expect(player.getByRole("button", { name: "解锁测试服装", exact: true })).toBeVisible();
  expect((await state(page)).run.id).toBe(runId);
  await player.getByRole("button", { name: "解锁测试服装", exact: true }).click();
  await expect(player).toHaveCount(0);
  await expect.poll(async () => {
    const save = await snapshot(page);
    return Object.values(save.longTerm.characterSkinUnlocks ?? {}).some((skins: any) => skins["cloud-traveler"] === true);
  }).toBe(true);
  await expect.poll(async () => (await snapshot(page)).story.active).toBeNull();
  const saved = await snapshot(page);
  expect(saved.story.active).toBeNull();
  expect(saved.story.completed.filter((entry: any) => entry.id === runId)).toHaveLength(1);
  expect(saved.story.completed.find((entry: any) => entry.id === runId).status).toBe("skipped");
  await page.reload(); await start(page);
  await expect(player).toHaveCount(0);
});

test("coordinate-free actors arrange automatically, stay together while speaking and recenter after exits", async ({ page }) => {
  test.setTimeout(90_000);
  await install(page); await start(page); await play(page, "composition");
  const player = page.locator("[data-story-player]"), actors = player.locator(".story-stage-actors");
  const line = async (cursor: string, text: string) => {
    await expect.poll(async () => (await state(page)).run?.cursor).toBe(cursor);
    await expect(player.locator(".story-text")).toHaveText(text);
  };
  const next = async () => { await tapStory(page); };
  const check = async (count: number, focused?: string, foreground = focused, mode: "say" | "stage" = "say") => {
    await expect(actors).toHaveAttribute("data-layout", "auto");
    await expect(actors.locator(".story-actor:visible")).toHaveCount(count);
    await expectNarrowStoryLayout(page);
    const reading = await readStoryComposition(page), visible = reading.actors.filter(actor => actor.visible);
    const authoredActors = (await snapshot(page)).story.active.run.stage.actors;
    expect(visible.filter(actor => actor.focused).map(actor => actor.id)).toEqual(focused ? [focused] : []);
    expect(visible.filter(actor => actor.foreground).map(actor => actor.id)).toEqual(foreground ? [foreground] : []);
    if (foreground) expect((await state(page)).run.lastSpeaker).toEqual({ sceneId: "test/story-platform#composition", actorId: foreground });
    for (const actor of visible) {
      expect(actor.fit).toBe("contain");
      expect(actor.scale).toBeCloseTo(authoredActors[actor.id].scale, 2);
      expect(Math.abs(actor.height - actor.layoutHeight * authoredActors[actor.id].scale)).toBeLessThanOrEqual(1);
      if (actor.id === foreground) expect(actor.layer).toBeGreaterThan(Math.max(...Object.values(authoredActors).map((value: any) => value.layer)));
      else expect(actor.layer).toBe(authoredActors[actor.id].layer);
      expect(actor.width / actor.height).toBeCloseTo(actor.naturalWidth / actor.naturalHeight, 2);
      expect(actor.brightness).toBe(mode === "stage" ? 1 : focused ? actor.id === focused ? 1 : .65 : .8);
    }
    return visible;
  };
  await expect(actors).toHaveAttribute("data-layout", "auto");
  await expect(actors.locator(".story-actor:visible")).toHaveCount(2);
  await line("narration", "两位演员正在候场。");
  const authored = (await snapshot(page)).story.active.run.stage;
  // The scene supplied no positions; engine defaults stay unchanged in the checkpoint.
  expect(authored.actors.guide.x).toBe(50); expect(authored.actors.guest.x).toBe(50);
  expect(authored.actors.guide.scale).toBe(.65);
  expect(authored.actors.guest.scale).toBe(.8);
  const ambient = new Map<number, Awaited<ReturnType<typeof check>>>();
  for (const viewport of STORY_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const visible = await check(2);
    expect(visible[0].x + visible[0].width / 2).toBeLessThan(visible[1].x + visible[1].width / 2);
    ambient.set(viewport.width, visible);
  }
  await next(); await line("key", "用演员键发言。");
  for (const viewport of STORY_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const visible = await check(2, "guide"), previous = ambient.get(viewport.width)!;
    expect(visible.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual(previous.map(({ x, y, width, height }) => ({ x, y, width, height })));
    expect((await snapshot(page)).story.active.run.stage).toEqual(authored);
  }
  await next(); await line("after-key", "引导员说完，大家安静了一会儿。"); await check(2, undefined, "guide");
  const narrated = (await snapshot(page)).story.active.run, narratedView = await readStoryComposition(page);
  await page.reload(); await start(page); await line("after-key", "引导员说完，大家安静了一会儿。"); await check(2, undefined, "guide");
  expect((await snapshot(page)).story.active.run).toEqual(narrated);
  expect(await readStoryComposition(page)).toEqual(narratedView);
  await next(); await line("offscreen", "让我想一想。"); await check(2, undefined, "guide");
  await page.clock.install({ time: new Date("2026-11-15T20:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-15T20:00:01Z"));
  await next();
  await expect.poll(async () => (await state(page)).run.cursor).toBe("name");
  expect((await snapshot(page)).story.active.run.stage).toEqual(authored);
  await page.clock.resume();
  await line("name", "用显示名发言。"); await check(2, "guest");
  const before = (await snapshot(page)).story.active.run, beforeView = await readStoryComposition(page);
  await page.reload(); await start(page); await line("name", "用显示名发言。"); await check(2, "guest");
  expect(await readStoryComposition(page)).toEqual(beforeView);
  expect((await snapshot(page)).story.active.run).toEqual(before);
  await next(); await line("hidden-name", "隐藏演员没有登场。"); await check(2, undefined, "guest");
  await expect(actors.locator('[data-story-actor="hidden"]')).toBeHidden();
  await next(); await line("collision-key", "隐藏演员键不能借名登场。"); await check(2, undefined, "guest");
  await expect(actors.locator('[data-story-actor="collision"]')).toBeHidden();
  await next(); await line("guest-away", "访客暂时离开了舞台。"); await check(1);
  await expect(actors.locator('[data-story-actor="guest"]')).toBeHidden();
  expect((await state(page)).run.lastSpeaker).toBeUndefined();
  await next(); await line("ambiguous", "同名不能替演员选边。"); await check(3);
  await next(); await line("shared-key", "同名时演员键仍然明确。"); await check(3, "guide");
  await next(); await line("alone", "宾客离开后回到中央。");
  const [alone] = await check(1, "guide"), reading = await readStoryComposition(page);
  expect(Math.abs(alone.x + alone.width / 2 - reading.width / 2)).toBeLessThanOrEqual(1);
  await next(); await player.getByRole("button", { name: "结束布局检查", exact: true }).click(); await expect(player).toHaveCount(0);
});

test("auto, escaped text, mobile layout, focus and cancellation use the same modal", async ({ page }, testInfo) => {
  await install(page); await start(page);
  const player = page.locator("[data-story-player]");
  await play(page, "auto"); await expect(player).toBeVisible();
  await tapStory(page);
  await player.getByRole("button", { name: "自动", exact: true }).click();
  await expect(player.locator(".story-text")).toContainText("自动播放第二句");
  await expect(player).toHaveCount(0);
  for (const viewport of STORY_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.locator("[data-enter-duel]").focus();
    await play(page, "long"); await expect(player).toBeVisible();
    // Auto is sticky as a player preference; pause it for geometry assertions.
    const auto = player.getByRole("button", { name: "自动", exact: true });
    if (await auto.getAttribute("aria-pressed") === "true") await auto.click();
    await tapStory(page);
    await expect(player.locator(".story-text")).toContainText('<img src=x onerror="window.__storyInjection=true">');
    expect(await page.evaluate(() => (window as any).__storyInjection)).toBeUndefined();
    await expect(player.locator("script, .story-text img")).toHaveCount(0);
    await expectNarrowStoryLayout(page);
    expect(await player.evaluate(element => element.contains(document.activeElement))).toBe(true);
    const box = (await player.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.width).toBeLessThanOrEqual(viewport.width);
    await expect(player.getByRole("button", { name: /^(继续|显示全文)$/ })).toHaveCount(0);
    const reading = player.locator(".story-dialogue");
    await reading.focus(); await expect(reading).toBeFocused();
    expect(await player.locator(".story-text").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await player.locator(".story-text").evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await player.locator(".story-text").evaluate(element => element.scrollTop)).toBeGreaterThan(0);

    if (viewport.width === 320 || viewport.width === 390) await page.screenshot({ path: testInfo.outputPath(`story-platform-${viewport.width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await player.getByRole("button", { name: "退出剧情", exact: true }).click();
    await expect(player).toHaveCount(0);
    await expect(page.locator("[data-enter-duel]")).toBeFocused();
  }
});

test("presentation waits and animations complete without clock ticks and taps reach the next line immediately", async ({ page }) => {
  await install(page); await start(page);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await play(page, "timing");
  const player = page.locator("[data-story-player]"); const actor = player.locator('[data-story-actor="guide"]');
  await expect(player).toBeVisible(); await tapStory(page);
  await expect(player.locator(".story-text")).toHaveText("点击后立即进入下一句。");
  await page.evaluate(() => {
    const probe = (window as any).__storyProbe; probe.presentationFrames = [];
    const text = document.querySelector(".story-text")!;
    const observer = new MutationObserver(() => {
      if (probe.state().run?.waiting?.type === "presentation") probe.presentationFrames.push(text.textContent);
    });
    observer.observe(text, { subtree: true, characterData: true, childList: true });
  });
  await tapStory(page);
  await expect.poll(async () => (await state(page)).run?.cursor, { timeout: 1500 }).toBe("say");
  expect((await state(page)).run.stage.actors.guide.x).toBe(100);
  await expect(actor).toBeVisible();
  expect((await state(page)).run.skipping).toBe(false);
  expect(await page.evaluate(() => (window as any).__storyProbe.presentationFrames)).not.toContain("");
  await expect(player.locator(".story-status")).not.toContainText("正在演出");
  await page.clock.runFor(500);
  await expect(player.locator(".story-text")).toHaveText("计时完成。");
  await expect(player).toHaveAttribute("data-story-typing", "false");
  await tapStory(page);
  await expect(player.getByRole("button", { name: "完成检查", exact: true })).toBeVisible();
  await tapStory(page); expect((await state(page)).run.waiting.type).toBe("choice");
  await player.getByRole("button", { name: "完成检查", exact: true }).click();
  await expect(player).toHaveCount(0);
  await expect(page.locator("[data-enter-duel]")).toBeEnabled();
  expect((await state(page)).blocking).toBe(false);
  expect(await page.evaluate(() => (window as any).__storyProbe.results.at(-1).status)).toBe("completed");
});

for (const viewport of STORY_VIEWPORTS) {
  test(`screen taps advance once while toolbar, drags, panels and choices stay protected ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
      const { longTerm } = await repo.readSnapshot();
      await repo.saveLongTerm({ ...longTerm, settings: { ...longTerm.settings, reducedMotion: true, soundEnabled: false } });
    });
    await install(page); await start(page); await play(page, "composition");
    const player = page.locator("[data-story-player]"), toolbar = player.locator(".story-player-controls");
    await expect(player.locator(".story-text")).toHaveText("两位演员正在候场。");
    await expect(player.locator(".story-speaker")).toBeHidden();
    await expect(toolbar.locator("button svg")).toHaveCount(4);
    expect(await toolbar.locator("button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")))).toEqual(["倍速", "自动", "回看", "跳过"]);
    for (const label of ["倍速", "自动", "回看", "跳过"]) {
      const button = toolbar.getByRole("button", { name: label, exact: true });
      expect((await button.textContent())!.trim()).toBe(label === "倍速" ? "1×" : "");
      expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(44);
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const bounds = (await player.boundingBox())!, top = (await toolbar.boundingBox())!;
    const point = { x: bounds.x + 5, y: top.y + top.height + 24 };
    const initial = (await state(page)).run;
    // The full top strip is protected, including space to the left of the icons.
    await page.mouse.click(bounds.x + 5, top.y + 10);
    expect((await state(page)).run.sequence).toBe(initial.sequence);
    await page.mouse.click(point.x, point.y);
    await expect.poll(async () => (await state(page)).run.cursor).toBe("key");
    expect((await state(page)).run.sequence).toBe(initial.sequence + 1);
    const key = (await state(page)).run;
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 20, point.y + 70, { steps: 8 }); await page.mouse.up();
    expect((await state(page)).run.sequence).toBe(key.sequence);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await toolbar.getByRole("button", { name: "回看", exact: true }).click();
    const log = player.locator(".story-log");
    await expect(log).toBeVisible();
    await expect(log.locator("li").first().locator("strong")).toHaveCount(0);
    await log.locator("h2").click();
    expect((await state(page)).run.sequence).toBe(key.sequence);
    await log.getByRole("button", { name: "返回剧情", exact: true }).click();
    expect((await state(page)).run.sequence).toBe(key.sequence);
    await page.keyboard.press("Escape");
    await expect(player.locator(".story-exit")).toBeVisible();
    await page.mouse.click(point.x, point.y);
    expect((await state(page)).run.sequence).toBe(key.sequence);
    await player.getByRole("button", { name: "继续播放", exact: true }).click();
    // Keyboard reading and text taps still dispatch exactly one advance.
    await expect(player.getByRole("button", { name: /^(继续|显示全文)$/ })).toHaveCount(0);
    await player.locator(".story-dialogue").focus();
    await page.keyboard.press(viewport.width === 320 ? "Enter" : "Space");
    await expect.poll(async () => (await state(page)).run.cursor).toBe("after-key");
    expect((await state(page)).run.sequence).toBe(key.sequence + 1);
    await player.locator(".story-text").click();
    await expect.poll(async () => (await state(page)).run.cursor).toBe("offscreen");
    // On desktop, the modal backdrop below the toolbar is part of the reading area.
    if (viewport.width > 390) {
      await page.mouse.click(10, point.y);
      await expect.poll(async () => (await state(page)).run.cursor).toBe("name");
    }
    await skipStory(page);
    const choice = player.getByRole("button", { name: "结束布局检查", exact: true });
    await expect(choice).toBeVisible();
    const waiting = (await state(page)).run;
    await page.mouse.click(point.x, point.y);
    expect((await state(page)).run.sequence).toBe(waiting.sequence);
    await choice.click(); await expect(player).toHaveCount(0);
  });
}


test("speed changes active typing without advancing, and skip confirmation pauses and cancels safely", async ({ page }, info) => {
  await install(page); await start(page);
  await page.clock.install(); await play(page, "speed");
  const player = page.locator("[data-story-player]"), text = player.locator(".story-text");
  const speed = player.getByRole("button", { name: "倍速", exact: true });
  await expect(player).toBeVisible();
  const initial = (await state(page)).run;
  const length = async () => (await text.textContent())!.length;
  const startLength = await length();
  await page.clock.runFor(2000); const normal = await length() - startLength;
  expect(normal).toBeGreaterThanOrEqual(19); expect(normal).toBeLessThanOrEqual(21);
  await speed.click(); await expect(speed).toHaveAttribute("aria-pressed", "true"); await expect(speed).toHaveText("2×");
  const beforeFast = await length(); await page.clock.runFor(1000); const fast = await length() - beforeFast;
  expect(fast).toBeGreaterThanOrEqual(19); expect(fast).toBeLessThanOrEqual(21);
  expect((await state(page)).run.sequence).toBe(initial.sequence);
  await speed.click(); await expect(speed).toHaveText("1×");
  const beforeNormal = await length(); await page.clock.runFor(1000);
  expect(await length() - beforeNormal).toBeGreaterThanOrEqual(9); expect(await length() - beforeNormal).toBeLessThanOrEqual(11);
  await player.getByRole("button", { name: "跳过", exact: true }).click();
  const confirmation = player.locator('[aria-label="跳过剧情确认"]');
  await expect(confirmation.getByRole("heading")).toHaveText("是否跳过剧情？");
  await expect(confirmation.getByRole("button", { name: "继续播放" })).toBeFocused();
  await expect(player.locator(".story-player-layout")).toHaveJSProperty("inert", true);
  const paused = await length(); await page.clock.runFor(3000);
  expect(await length()).toBe(paused); expect((await state(page)).run.sequence).toBe(initial.sequence);
  await page.screenshot({ path: info.outputPath("story-skip-confirmation.png") });
  await page.keyboard.press("Escape"); await expect(confirmation).toBeHidden();
  await expect(player.locator(".story-dialogue")).toBeFocused();
  await page.clock.runFor(500); expect(await length()).toBeGreaterThan(paused);
  await player.getByRole("button", { name: "跳过", exact: true }).click();
  await confirmation.getByRole("button", { name: "继续播放" }).click();
  await expect(confirmation).toBeHidden(); expect((await state(page)).run.sequence).toBe(initial.sequence);
  await skipStory(page); await expect(player).toHaveCount(0);
  await play(page, "auto"); await expect(player).toBeVisible(); await tapStory(page);
  await player.getByRole("button", { name: "自动", exact: true }).click();
  await player.getByRole("button", { name: "跳过", exact: true }).click();
  const autoSequence = (await state(page)).run.sequence;
  await page.clock.runFor(2000); expect((await state(page)).run.sequence).toBe(autoSequence);
  await confirmation.getByRole("button", { name: "继续播放" }).click(); await speed.click();
  await page.clock.runFor(800); await expect(text).toHaveText("自动播放第二句。");
  await page.clock.runFor(1000); await expect(player).toHaveCount(0);
});
