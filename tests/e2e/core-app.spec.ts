import { expect, test } from '@playwright/test';

test('Core starts with seven packages and keeps the adult confirmation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始游戏', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '资源管理' }).click();
  await expect(page.locator('.package-card')).toHaveCount(7);
  await expect(page.locator('.package-card[data-package-state=enabled]')).toHaveCount(7);
  await expect(page.locator('.package-card[data-package-id^="community/"]')).toHaveCount(0);
  for (const card of await page.locator('.package-card').all()) {
    const packageId = await card.getAttribute('data-package-id');
    await card.getByRole('button', { name: '详情', exact: true }).click();
    await expect(card.locator('.package-details dt').first()).toHaveText('许可证');
    await expect(card.locator('.package-details dd').first()).toHaveText(packageId?.includes('official-built-in-') ? 'CC0' : 'CC-BY-NC-SA 4.0');
  }
  for (const packageId of ['hoc-core/official-built-in-talents', 'hoc-core/official-built-in-skills']) {
    const cover = page.locator(`.package-card[data-package-id="${packageId}"] [data-package-cover]`);
    await expect(cover).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
  }
  await page.getByRole('button', { name: '关闭资源管理' }).click();
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  const warning = page.locator('#adult-content-warning');
  await expect(warning.locator('#adult-content-warning-copy')).toHaveText('本作包含赌博及其他不适宜年轻玩家游玩的主题，仅面向成年玩家。');
  await expect(warning).toContainText('社区模组由各自作者提供');
  await warning.getByRole('button', { name: '我已成年并继续' }).click();
  await expect(page.locator('main.lobby-menu-shell')).toBeVisible();
  await page.getByRole('button', { name: '返回启动器' }).click();
  await page.reload();
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await expect(warning).toHaveCount(0);
  await expect(page.locator('main.lobby-menu-shell')).toBeVisible();
});

async function enterCharacterSelection(page: import('@playwright/test').Page): Promise<void> {
  const selection = page.locator('main.lobby-character-shell');
  if (await selection.isVisible()) return;
  await page.locator('[data-enter-duel]').click();
  await expect(selection).toBeVisible();
}
async function ensureGuestCandidate(page: import('@playwright/test').Page, id: string): Promise<void> {
  const invite = page.locator(`[data-invite-character='${id}']`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await invite.count()) return;
    await page.locator('[data-refresh-guests]').click();
  }
  throw new Error(`Guest ${id} did not appear after refreshing the candidate list`);
}
async function inviteCharacter(page: import('@playwright/test').Page, id: string): Promise<void> {
  await ensureGuestCandidate(page, id);
  await page.locator(`[data-invite-character='${id}']`).click();
  await expect(page.locator('#profile')).toBeVisible();
}
async function waitForInitialDeal(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.player-zone .card')).toHaveCount(2, { timeout: 8_000 });
  await expect(page.locator('.skill-draw-modal')).toHaveCount(0);
}

test("五个 HoC art 角色可直接选择并逐个启动", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const characters = [
    { id: "chatgpt", name: "ChatGPT", tier: "S" },
    { id: "claude", name: "Claude", tier: "S" },
    { id: "gemini", name: "Gemini", tier: "A" },
    { id: "deepseek", name: "DeepSeek", tier: "A" },
    { id: "llama", name: "Llama", tier: "B" }
  ] as const;
  const states = ["relaxed", "conflicted", "mocking", "threatened", "unconscious-reclined"] as const;
  await page.goto("/");
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await page.locator("#adult-content-warning").getByRole("button", { name: "我已成年并继续" }).click();
  await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  for (const [index, character] of characters.entries()) {
    await enterCharacterSelection(page);
    await ensureGuestCandidate(page, character.id);
    const card = page.locator(`[data-character-id='${character.id}']`);
    await expect(card).toContainText(`${character.name}`);
    await expect(card.locator(".eyebrow")).toContainText(`${character.tier}级`);
    await expect(card.locator(".character-copy")).toContainText(character.id === "deepseek" ? "可恶，是偷吃token的大肥鱼！" : character.id === "gemini" ? "曾经被誉为最通人性的前端之神的哈吉米" : character.id === "chatgpt" ? "一条永远板着扑克脸、对你的要求有求必应的白色龙娘。" : character.id === "llama" ? "软乎乎的白色羊驼女孩" : "来自 Anthropic 家的高岭之花");
    if (index === 0 || character.id === "llama") {
      await card.screenshot({ path: testInfo.outputPath(`${character.id}-selection-390.png`) });
      await page.setViewportSize({ width: 320, height: 720 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await card.screenshot({ path: testInfo.outputPath(`${character.id}-selection-320.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await inviteCharacter(page, character.id);
    await expect(page.locator("#profile")).toContainText(`${character.name}`);
    await expect(page.locator("#profile")).toContainText(`${character.tier}级`);
    await expect(page.locator("#profile .profile-ability")).toHaveCount(["chatgpt", "claude"].includes(character.id) ? 2 : ["deepseek", "gemini"].includes(character.id) ? 1 : 0);
    if (character.id === "chatgpt") {
      await expect(page.locator("#profile")).toContainText("扑克脸的执行者");
      await expect(page.locator("#profile")).toContainText("RESET！");
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.locator("#profile").screenshot({ path: testInfo.outputPath(`chatgpt-profile-${width}.png`) });
      }
      await page.locator("#profile .profile-ability").first().locator("summary").click();
      await expect(page.locator("#profile")).toContainText("能干你就多干点！");
      await page.locator("#profile .profile-ability").last().locator("summary").click();
      await expect(page.locator("#profile")).toContainText("减半额度，给用户发一次全量重置，就能让他们感恩戴德。");
    }
    if (character.id === "llama") {
      await expect(page.locator("#profile")).toContainText("Llama 是你不知道从哪个仓库里捡回来的白色羊驼女孩。");
      await expect(page.locator("#profile")).not.toContainText("占位");
      await page.setViewportSize({ width: 320, height: 720 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.locator("#profile").screenshot({ path: testInfo.outputPath("llama-profile-320.png") });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    if (character.id === "gemini") {
      await expect(page.locator("#profile")).toContainText("Gemini 是你免费捡来的小猫。");
      await expect(page.locator("#profile")).not.toContainText("占位");
      await page.setViewportSize({ width: 320, height: 720 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.locator("#profile").screenshot({ path: testInfo.outputPath("gemini-profile-320.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("#profile .profile-ability")).toContainText("世界知识");
      await expect(page.locator("#profile .profile-ability")).toContainText("五彩斑斓的世界啊！");
    }
    await page.locator("#profile [data-profile-start]").click();
    await expect(page.locator("main.table-shell")).toBeVisible({ timeout: 8_000 });
    await waitForInitialDeal(page);
    await expect(page.locator(".character-strip .eyebrow")).toContainText(`${character.name} // ${character.tier}级`);
    await expect(page.locator("img.character-portrait")).toHaveAttribute("src", /^blob:/);
    const decoded = await page.evaluate(async ({ id, states: stateNames }) => {
      const images = await Promise.all(stateNames.map(async (state) => {
        const image = new Image();
        image.src = `/characters/${id}/${state}.png`;
        await image.decode();
        return { state, width: image.naturalWidth, height: image.naturalHeight };
      }));
      return images;
    }, { id: character.id, states });
    expect(decoded).toEqual(states.map((state) => ({ state, width: 1152, height: 768 })));
    if (character.id === "llama") {
      await page.screenshot({ path: testInfo.outputPath("llama-table-390.png") });
      await page.setViewportSize({ width: 320, height: 720 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.screenshot({ path: testInfo.outputPath("llama-table-320.png") });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByRole("button", { name: "离开牌桌" }).click();
    await expect(page.locator("main.summary-shell")).toBeVisible();
    if (character.id === "llama") {
      await expect(page.locator("main.summary-shell")).toContainText("反正牌桌状态随时都可以重新初始化。");
    }
    await page.getByRole("button", { name: "返回大厅" }).click();
    await expect(page.locator("main.lobby-menu-shell")).toBeVisible();
  }
});

test('Core finishes a complete ChatGPT match and records its result', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, typeof timeout === 'number' && timeout >= 2_000 ? 25 : timeout, ...args)) as typeof window.setTimeout;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await page.locator('#adult-content-warning').getByRole('button', { name: '我已成年并继续' }).click();
  await enterCharacterSelection(page);
  await inviteCharacter(page, 'chatgpt');
  await page.locator('#profile [data-profile-start]').click();
  await expect(page.locator('main.table-shell')).toBeVisible();
  let sawReveal = false;
  let sawTriggerResult = false;
  for (let step = 0; step < 260 && !(await page.locator('main.summary-shell').count()); step += 1) {
    const tutorial = page.locator('#tutorial-popover');
    if (await tutorial.isVisible()) {
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-tutorial-skip]')?.click());
      continue;
    }
    const phase = await page.locator('main.table-shell').getAttribute('data-phase').catch(() => null);
    if (phase === 'round-reveal') {
      sawReveal = true;
      await expect(page.locator('.round-notice')).toBeVisible();
      const ack = page.locator("button[data-action*='ACK_ROUND_RESULT']:not([disabled])");
      if (await ack.count()) await ack.click();
      else await page.waitForTimeout(30);
    } else if (phase === 'roulette-reaction' || phase === 'roulette-trigger') {
      const trigger = page.locator("button[data-action*='TRIGGER_ROULETTE']:not([disabled])");
      if (await trigger.count()) await trigger.click();
      else await page.waitForTimeout(30);
    } else if (phase === 'roulette-result') {
      sawTriggerResult = true;
      const ack = page.locator("button[data-action*='ACK_TRIGGER_RESULT']:not([disabled])");
      if (await ack.count()) await ack.click();
      else await page.waitForTimeout(30);
    } else {
      const stand = page.locator("button[data-action*='PLAYER_STAND']:not([disabled])");
      if (await stand.count()) await stand.click();
      else await page.waitForTimeout(30);
    }
  }
  await expect(page.locator('main.summary-shell')).toBeVisible();
  expect(sawReveal).toBe(true);
  expect(sawTriggerResult).toBe(true);
  await page.getByRole('button', { name: '返回大厅' }).click();
  await page.locator('[data-open-history]').click();
  await expect(page.locator('main.history-shell .history-card')).toHaveCount(1);
});


test('Core warns when the browser refuses durable storage and still seeds OPFS', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persist', { value: async () => false, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('浏览器拒绝提供持久化存储');
  await expect(page.locator('html')).toHaveAttribute('data-content-source', 'repository');
  await expect.poll(() => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const version = await (await root.getDirectoryHandle('content')).getDirectoryHandle('v1');
    return Promise.all(['catalog-a.json', 'catalog-b.json'].map(async name => (await (await version.getFileHandle(name)).getFile()).size > 0));
  })).toEqual([true, true]);
});
