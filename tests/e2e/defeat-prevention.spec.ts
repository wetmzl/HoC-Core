import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const registry = await load("/src/core/abilities/registry.ts");
    const stage = "neutral-encounter-stage";
    const value = { type: "status-number", target: "owner", statusDefinitionId: stage, key: "stage" };
    const definition = {
      id: "neutral-stage-transition", name: "阶段切换", description: "抵御一次致命一击，进入第二阶段。",
      sourceKind: "ai-skill", primaryDomain: "gunslinger", tags: ["neutral"], activation: { type: "automatic" },
      rules: [
        { id: "initialize", trigger: "on-match-created", notify: false, effects: [
          { type: "assign-status-values", target: "owner", statusDefinitionId: stage, values: { ["stage"]: { type: "numeric", value: 1 } } }
        ] },
        { id: "continue", trigger: "before-defeat", triggerNotice: "抵御致命一击，进入第二阶段。", conditions: [
          { type: "pending-defeat-can-prevent", target: "owner" },
          { type: "scalar-compare", left: value, operator: "eq", right: 1 }
        ], effects: [
          { type: "prevent-pending-defeat", target: "owner" },
          { type: "assign-status-values", target: "owner", statusDefinitionId: stage, values: { ["stage"]: { type: "numeric", value: 2 } } },
          { type: "remove-gun-bullets", target: "owner", amount: { type: "gun-bullets", target: "owner" } },
          { type: "add-gun-bullets", target: "owner", amount: 1 }
        ] },
        { id: "second-stage", trigger: "before-bust-check", conditions: [
          { type: "actor-is", actor: "owner" }, { type: "scalar-compare", left: value, operator: "eq", right: 2 }
        ], effects: [{ type: "add-to-pending-bust-limit", target: "owner", amount: 2 }] }
      ],
      displays: [{ id: "stage", target: "owner", description: "当前阶段", content: [
        { type: "text", text: "阶段 " }, { type: "number", value }
      ] }]
    };
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, definition], [
      ...registry.STATUS_DEFINITIONS, { id: stage, defaultDuration: "match", rules: [] }
    ], registry.ABILITY_CATALOG_VERSION);
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const base = createMatch("neutral-browser-stages", { opponentId: "claude", skillDeckIds: [],
      opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }],
      aiProfile: { P: 0, A: 0, B: 0, C: 0 }
    });
    const match = { ...base, roulette: { ...base.roulette, opponent: { capacity: 6, bullets: 6 } },
      round: { ...base.round, phase: "roulette-trigger", currentActor: null,
        outcome: { reason: "comparison", winner: "player", penaltyTarget: "opponent", bulletsAdded: 1 } }
    };
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    (window as any).__neutralRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({
      root: document.querySelector("#app"), onExitRequest: async () => {}
    });
  });
}

async function saved(page: Page) {
  return page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repo = createPersistenceService();
    return { match: (await repo.loadRuntime())?.activeMatch, save: await repo.loadLongTerm() };
  });
}

for (const width of [390, 320]) {
  test(`实弹后进入第二阶段并继续牌局 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await mount(page);
    await page.getByRole("button", { name: "静观好戏", exact: true }).click();
    await expect(page.getByRole("button", { name: "下一轮", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看结局", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await saved(page)).match?.history.some(e => e.type === "DEFEAT_PREVENTED")).toBe(true);
    const continued = await saved(page);
    expect(continued.match?.status).toBe("active");
    expect(continued.match?.history.some(e => e.type === "TRIGGER_PULLED" && e.fired)).toBe(true);
    expect(continued.match?.history.some(e => e.type === "MATCH_FINISHED")).toBe(false);
    expect(continued.match?.roulette.opponent.bullets).toBe(1);
    expect(continued.save?.defeats).toHaveLength(0);
    expect(continued.match?.abilities.statuses.find(s => s.statusDefinitionId === "neutral-encounter-stage")?.parameters.stage).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`shot-continued-${width}.png`) });
    await page.getByRole("button", { name: "下一轮", exact: true }).click();
    await expect(page.locator("main.table-shell")).toHaveAttribute("data-phase", "turns");
    await expect.poll(async () => (await saved(page)).match?.roundIndex).toBe(1);
    const next = (await saved(page)).match!;
    const limit = await page.evaluate(async () => {
      const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
      const { getActiveBustLimit } = await import(/* @vite-ignore */ "/src/core/match/reducer.ts");
      return getActiveBustLimit((await createPersistenceService().loadRuntime())!.activeMatch!, "opponent");
    });
    expect(limit).toBe(23);
    expect(next.abilities.statuses.find(s => s.statusDefinitionId === "neutral-encounter-stage")?.parameters.stage).toBe(2);
    await page.screenshot({ path: info.outputPath(`second-stage-${width}.png`) });
  });
}
