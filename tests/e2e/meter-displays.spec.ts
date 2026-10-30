import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const registry = await load("/src/core/abilities/registry.ts");
    const status = { id: "neutral-browser-reserve", defaultDuration: "match", rules: [] };
    const value = { type: "status-number", target: "owner", statusDefinitionId: status.id, key: "reserve" };
    const definition = { id: "neutral-browser-meter", name: "护盾储备", description: "消耗公共资源并更新声明式展示。",
      sourceKind: "ai-skill", primaryDomain: "gunslinger", tags: ["neutral"], activation: { type: "automatic" },
      rules: [
        { id: "initialize", trigger: "on-match-created", notify: false,
          effects: [{ type: "assign-status-values", target: "owner", statusDefinitionId: status.id, values: { ["reserve"]: { type: "numeric", value: 2 } } }] },
        { id: "consume", trigger: "before-defeat", conditions: [{ type: "pending-defeat-can-prevent", target: "owner" }],
          effects: [{ type: "prevent-pending-defeat", target: "owner" },
            { type: "assign-status-values", target: "owner", statusDefinitionId: status.id, values: { ["reserve"]: { type: "numeric", value: 0 } } }] }
      ],
      displays: [{ id: "reserve", target: "owner", density: "compact", description: "显示真实的剩余储备。",
        content: [{ type: "text", text: "储备 " }, { type: "meter", value, max: 2, label: "剩余储备" }] }]
    };
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, definition], [...registry.STATUS_DEFINITIONS, status], registry.ABILITY_CATALOG_VERSION);
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const base = createMatch("neutral-meter-browser", { opponentId: "claude", skillDeckIds: [],
      opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
    const match = { ...base, roulette: { ...base.roulette, opponent: { capacity: 6, bullets: 6 } },
      round: { ...base.round, phase: "roulette-trigger", currentActor: null,
        outcome: { reason: "comparison", winner: "player", penaltyTarget: "opponent", bulletsAdded: 1 } } };
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = false;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    (window as any).__meterRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({
      root: document.querySelector("#app"), onExitRequest: async () => {}
    });
  });
}

for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }]) {
  test(`紧凑储备条正常更新且旧轮盘装饰不渲染 ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await mount(page);
    const meter = page.getByRole("meter", { name: "剩余储备", exact: true });
    await expect(meter).toHaveAttribute("aria-valuenow", "2");
    await expect(meter).toHaveAttribute("aria-valuemax", "2");
    await expect(page.locator(".status-chip-compact")).toBeVisible();
    const effect = page.locator(".roulette-surface-effect, [data-roulette-effect]");
    await expect(effect).toHaveCount(0);
    await expect(page.locator("img.trigger-prop")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    expect((await page.locator(".status-chip-compact").boundingBox())!.height).toBeLessThan(28);
    await page.screenshot({ path: info.outputPath(`compact-reserve-ready-${viewport.width}.png`) });
    await page.getByRole("button", { name: "静观好戏", exact: true }).click();
    await expect(page.getByRole("button", { name: "下一轮", exact: true })).toBeVisible();
    await expect(meter).toHaveAttribute("aria-valuenow", "0");
    await expect(effect).toHaveCount(0);
    await expect(page.locator(".status-chip-compact")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`compact-reserve-empty-${viewport.width}.png`) });
    await page.getByRole("button", { name: "下一轮", exact: true }).click();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "turns");
    await expect(meter).toHaveAttribute("aria-valuenow", "0");
    await expect(effect).toHaveCount(0);
  });
}
