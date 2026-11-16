import { expect, test, type Page } from "@playwright/test";

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__pulses = [];
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern: number | number[]) => {
      if (Array.isArray(pattern) && pattern.some(value => value > 0)) (window as any).__pulses.push(pattern);
      return true;
    } });
  });
  await page.goto("/?ui-feedback-e2e=1");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
}

async function pulses(page: Page): Promise<number[][]> { return page.evaluate(() => (window as any).__pulses); }
async function clearPulses(page: Page): Promise<void> { await page.evaluate(() => { (window as any).__pulses = []; }); }
async function neutralControls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.createElement("section");
    host.id = "feedback-fixture";
    host.style.cssText = "position:fixed;inset:10px 10px auto;z-index:1000;background:#172333;padding:10px;display:grid;gap:8px";
    host.innerHTML = '<button class="secondary-button" id="ordinary">普通操作</button><button id="own" data-own-haptic>专属反馈</button><button id="disabled" disabled>禁用</button><button id="aria-disabled" aria-disabled="true">不可用</button><label class="secondary-button" id="file-label">文件<input type="file" hidden></label>';
    host.querySelector("input")!.addEventListener("click", event => event.preventDefault());
    document.body.append(host);
  });
}

test("启动页按住轻压、释放回弹，布局和配色保持，点击只有一次轻震动", async ({ page }) => {
  await boot(page);
  const button = page.locator("[data-open-launcher-settings]");
  const before = await button.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, background: getComputedStyle(element).background }));
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute("data-ui-pressed", "");
  await expect.poll(() => button.evaluate(element => Number.parseFloat(getComputedStyle(element).scale))).toBeLessThan(.99);
  expect(await button.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, background: getComputedStyle(element).background }))).toEqual(before);
  await page.mouse.up();
  await expect(page.locator("[data-launcher-settings]")).toBeVisible();
  await expect.poll(() => pulses(page)).toEqual([[8]]);
  await expect(button).not.toHaveAttribute("data-ui-pressed");
  expect(await page.locator("[data-launcher-settings]").evaluate(element => element.getAnimations().some(animation => (animation as CSSAnimation).animationName === "ui-dialog-enter"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-launcher-settings]")).not.toBeVisible();
  await expect(button).toBeFocused();
});

test("取消按压、禁用、专属反馈和文件标签不会产生额外震动，键盘可用", async ({ page }) => {
  await boot(page); await neutralControls(page);
  const button = page.locator("#ordinary"), box = (await button.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await expect(button).toHaveAttribute("data-ui-pressed", "");
  await page.mouse.move(box.x + 40, box.y + 20); await page.mouse.up();
  await expect(button).not.toHaveAttribute("data-ui-pressed");
  expect(await pulses(page)).toEqual([]);
  await page.locator("#own").click();
  await page.locator("#aria-disabled").click({ force: true });
  const disabled = (await page.locator("#disabled").boundingBox())!;
  await page.mouse.click(disabled.x + 5, disabled.y + 5);
  expect(await pulses(page)).toEqual([]);
  await page.locator("#file-label").click();
  await expect.poll(() => pulses(page)).toEqual([[8]]);
  await clearPulses(page);
  await button.focus(); await page.keyboard.down(" ");
  await expect(button).toHaveAttribute("data-ui-pressed", "");
  await page.keyboard.up(" ");
  await expect.poll(() => pulses(page)).toEqual([[8]]);
  await expect.poll(() => button.evaluate(element => element.getAnimations().length)).toBe(0);
  await clearPulses(page);
  await button.evaluate(element => element.click());
  expect(await pulses(page)).toEqual([]);
});

test("按钮释放实际越过原尺寸一次并收稳，连点可以重新按下", async ({ page }) => {
  await boot(page); await neutralControls(page);
  const button = page.locator("#ordinary"), box = (await button.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.down();
  await expect.poll(() => button.evaluate(element => Number.parseFloat(getComputedStyle(element).scale))).toBeLessThan(.99);
  await page.evaluate(() => {
    (window as any).__scales = [];
    const until = performance.now() + 400;
    const sample = () => {
      (window as any).__scales.push(Number.parseFloat(getComputedStyle(document.querySelector("#ordinary")!).scale) || 1);
      if (performance.now() < until) requestAnimationFrame(sample);
      else (window as any).__samplingDone = true;
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__samplingDone)).toBe(true);
  const scales: number[] = await page.evaluate(() => (window as any).__scales);
  expect(Math.max(...scales)).toBeGreaterThan(1.001);
  expect(scales.at(-1)).toBe(1);
  await button.dblclick({ delay: 80 });
  await expect(button).not.toHaveAttribute("data-ui-pressed");
  await expect.poll(() => button.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect.poll(() => pulses(page)).toEqual([[8], [8], [8]]);
});

test("缩放不丢失原始按钮边缘的点击，移出取消不执行动作", async ({ page }) => {
  await boot(page); await neutralControls(page);
  await page.locator("#ordinary").evaluate(element => {
    (window as any).__actions = 0;
    element.addEventListener("click", () => { (window as any).__actions++; });
  });
  const button = page.locator("#ordinary"), box = (await button.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 20); await page.mouse.down();
  await expect.poll(() => button.evaluate(element => Number.parseFloat(getComputedStyle(element).scale))).toBeLessThan(.99);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__actions)).toBe(1);
  await expect.poll(() => button.evaluate(element => element.getAnimations().length)).toBe(0);
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 20); await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__actions)).toBe(1);
  await expect.poll(() => pulses(page)).toEqual([[8]]);
});

for (const ownership of ["prevent-default", "stop-propagation"] as const) {
  test(`自定义按钮手势先取得指针所有权并完整拖出边界：${ownership}`, async ({ page }) => {
    await boot(page); await neutralControls(page);
    const button = page.locator("#ordinary"), box = (await button.boundingBox())!;
    // Leave a cancelled ordinary press on this same element before a widget owns it.
    await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 20); await page.mouse.up();
    await expect(button).not.toHaveAttribute("data-ui-pressed");
    expect(await pulses(page)).toEqual([]);
    await page.locator("#ordinary").evaluate((element, ownership) => {
      const button = element as HTMLButtonElement;
      const state = { active: false, moves: 0, drops: 0, cancellations: 0, clicks: 0 };
      (window as any).__customDrag = state;
      button.addEventListener("pointerdown", event => {
        if (ownership === "prevent-default") event.preventDefault();
        else event.stopPropagation();
        state.active = true;
        button.setPointerCapture(event.pointerId);
      });
      button.addEventListener("pointermove", () => { if (state.active) state.moves++; });
      button.addEventListener("pointerup", () => {
        if (!state.active) return;
        state.active = false; state.drops++;
      });
      button.addEventListener("lostpointercapture", () => {
        if (state.active) { state.active = false; state.cancellations++; }
      });
      button.addEventListener("click", () => { state.clicks++; });
    }, ownership);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(button).not.toHaveAttribute("data-ui-pressed");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 70, { steps: 8 });
    expect(await page.evaluate(() => (window as any).__customDrag.active)).toBe(true);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).__customDrag.drops)).toBe(1);
    expect(await page.evaluate(() => (window as any).__customDrag.cancellations)).toBe(0);
    expect(await page.evaluate(() => (window as any).__customDrag.moves)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__customDrag.clicks)).toBe(1);
    expect(await pulses(page)).toEqual([]);
    expect(await button.evaluate(element => element.getAnimations().length)).toBe(0);
  });
}

test("弹窗退场保持模态隔离，重复关闭只提交一次，并允许中途重开", async ({ page }) => {
  await boot(page);
  await page.locator("[data-open-launcher-settings]").click();
  const dialog = page.locator("[data-launcher-settings]");
  await expect(dialog).toBeVisible();
  const result = await page.evaluate(async () => {
    const { closeUiDialog, openUiDialog } = await import(/* @vite-ignore */ "/src/presentation/dialog-motion.ts");
    const dialog = document.querySelector<HTMLDialogElement>("[data-launcher-settings]")!;
    const first = closeUiDialog(dialog, "first"), second = closeUiDialog(dialog, "second");
    const guarded = dialog.open && dialog.matches(":modal") && dialog.inert;
    openUiDialog(dialog);
    await first;
    return { guarded, shared: first === second, reopened: dialog.open && !dialog.inert };
  });
  expect(result).toEqual({ guarded: true, shared: true, reopened: true });
  await expect(dialog).toBeVisible();
  await page.locator("[data-close-launcher-settings]").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("[data-open-launcher-settings]")).toBeFocused();
  await page.locator("[data-open-launcher-settings]").click();
  expect(await page.evaluate(async () => {
    const { closeUiDialog } = await import(/* @vite-ignore */ "/src/presentation/dialog-motion.ts");
    const dialog = document.querySelector<HTMLDialogElement>("[data-launcher-settings]")!;
    dialog.close(); dialog.showModal();
    await closeUiDialog(dialog);
    return dialog.open;
  })).toBe(false);
});

test("确认弹窗在动画后只返回一次选择，取消保存仍由原有守卫处理", async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { chooseGameDialog } = await import(/* @vite-ignore */ "/src/game-dialog.ts");
    (window as any).__choices = [];
    void chooseGameDialog("测试确认", "中性操作", [{ value: "confirm", label: "确认" }]).then(value => (window as any).__choices.push(value));
  });
  const dialog = page.locator("[data-game-dialog]");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__choices)).toEqual(["confirm"]);
  await expect(dialog).toHaveCount(0);
  await page.locator("[data-open-launcher-settings]").click();
  await page.evaluate(() => document.querySelector("[data-launcher-settings]")!.addEventListener("cancel", event => event.preventDefault(), { once: true }));
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-launcher-settings]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-launcher-settings]")).not.toBeVisible();
});

test("系统减少动效立即停止按压动画和震动，关闭弹窗无需等待", async ({ page }) => {
  await boot(page); await neutralControls(page);
  const button = page.locator("#ordinary"), box = (await button.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await expect(button).toHaveAttribute("data-ui-pressed", "");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(button).not.toHaveAttribute("data-ui-pressed");
  await page.mouse.up(); await button.click();
  expect(await pulses(page)).toEqual([]);
  await page.locator("#feedback-fixture").evaluate(element => element.remove());
  await page.locator("[data-open-launcher-settings]").click();
  expect(await page.locator("[data-launcher-settings]").evaluate(element => element.getAnimations().length)).toBe(0);
  expect(await page.evaluate(async () => {
    const { closeUiDialog } = await import(/* @vite-ignore */ "/src/presentation/dialog-motion.ts");
    const dialog = document.querySelector<HTMLDialogElement>("[data-launcher-settings]")!;
    void closeUiDialog(dialog);
    return dialog.open;
  })).toBe(false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("[data-open-launcher-settings]").click();
  await expect.poll(() => pulses(page)).toEqual([[8]]);
});

test("反复进出游戏不重复绑定震动，存档偏好在启动器与刷新后仍生效", async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const save = (await load("/tests/e2e/runtime-fixture.ts")).createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = false;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await (await load("/src/persistence/factory.ts")).createPersistenceService().saveLongTerm(save);
  });
  for (let i = 0; i < 2; i++) {
    await page.locator("[data-start-game]").click();
    await expect(page.locator(".lobby-menu-shell")).toBeVisible();
    await clearPulses(page);
    await page.locator('[data-open="settings"]').click();
    await expect.poll(() => pulses(page)).toEqual([[8]]);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".launcher-shell")).toBeVisible();
    await clearPulses(page);
    await page.locator("[data-open-launcher-settings]").click();
    await expect.poll(() => pulses(page)).toEqual([[8]]);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  }
  await page.locator("[data-start-game]").click();
  await page.locator('[data-open="settings"]').click();
  await page.locator('[data-setting="reducedMotion"]').check();
  await expect(page.locator("body")).toHaveClass(/reduced-motion/);
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await expect(page.locator(".launcher-shell")).toBeVisible();
  await page.reload(); await expect(page.locator("[data-start-game]")).toBeEnabled();
  await clearPulses(page);
  await page.locator("[data-open-launcher-settings]").click();
  expect(await pulses(page)).toEqual([]);
  expect(await page.locator("[data-launcher-settings]").evaluate(element => element.getAnimations().length)).toBe(0);
});

for (const width of [320, 390, 1280]) test(`静态布局与嵌套面板在 ${width}px 下可用`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
  await boot(page);
  await page.locator("[data-open-packages]").click();
  await page.locator("[data-open-playlist-manager]").click();
  await expect(page.locator("[data-playlist-manager]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-playlist-manager]")).not.toBeVisible();
  await expect(page.locator("[data-package-drawer]")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `output/ui-feedback-${width}.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-package-drawer]")).not.toBeVisible();
});
