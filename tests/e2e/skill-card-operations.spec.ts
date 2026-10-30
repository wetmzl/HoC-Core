import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const registry = await load("/src/core/abilities/registry.ts");
    const status = { id: "neutral-browser-count", defaultDuration: "match", rules: [] };
    const filter = { tags: ["marked"] };
    const definition = { id: "neutral-browser-inventory", name: "卡槽观察", description: "通用卡槽操作样例。", sourceKind: "ai-skill", primaryDomain: "intelligence-officer", tags: ["neutral"], activation: { type: "automatic" },
      rules: [{ id: "remove", trigger: "on-round-end", effects: [
        { type: "remove-skill-cards", target: "rival", filter, resultKey: "removed" },
        { type: "assign-status-values", target: "owner", statusDefinitionId: status.id, values: { ["count"]: { type: "numeric", value: { type: "effect-result", key: "removed" } } } }
      ] }],
      displays: [{ id: "inventory", target: "owner", description: "按元数据筛选技能牌。", density: "compact", content: [
        { type: "meter", label: "已移除技能牌", value: { type: "status-number", target: "owner", statusDefinitionId: status.id, key: "count" }, max: 3 }
      ], skillCardMarkers: [
        { targets: ["rival"], filter, active: { type: "public-hand-card-suit-count", target: "owner", suit: "spades" }, type: "selection", label: "筛选目标" },
        { targets: ["rival"], filter, type: "attention", label: "附加标记" }
      ] }]
    };
    const skills = ["行动样例", "持续样例", "保留样例"].map((name, index) => ({ id: `neutral-browser-skill-${index}`, name, description: "中性测试技能", sourceKind: "player-skill", primaryDomain: "gambler", skillTags: ["gambler"], tags: index < 2 ? ["marked"] : ["neutral"],
      activation: index === 1 ? { type: "passive" } : { type: "action", consume: "card", windows: ["owner-turn"], uses: 3 },
      ...(index === 1 ? { ttl: { type: "rounds", amount: 5 } } : {}), rules: index === 1 ? [] : [{ id: "draw", trigger: "on-ability-played", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }], drop: { enabled: true, baseWeight: 1 }, stackable: false }));
    registry.installAbilityRegistry([...registry.ABILITY_DEFINITIONS, definition, ...skills], [...registry.STATUS_DEFINITIONS, status], registry.ABILITY_CATALOG_VERSION);
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const { addAbilityInstance } = await load("/src/core/abilities/runtime.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const base = createMatch("neutral-inventory-browser", { opponentId: "claude", skillDeckIds: [], unlockedPlayerSkillIds: skills.map(skill => skill.id), opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
    let runtime = base.abilities;
    const cards = skills.map((skill, index) => {
      const instanceId = `neutral-slot-${index}`;
      runtime = addAbilityInstance(runtime, registry.instantiateAbility({ definitionId: skill.id, enabled: true, parameters: {} }, "player", instanceId, runtime.sequence + 1));
      return { kind: "player-skill", definitionId: skill.id, level: 1, owner: "player", instanceId };
    });
    const publicCard = createCard("spades", "2", base.opponent.hand.cards[0].id);
    const opponent = { ...base.opponent, hand: { cards: [publicCard, ...base.opponent.hand.cards.slice(1)] } };
    const match = { ...base, opponent, abilities: runtime, playerSkills: { ...base.playerSkills, cards }, roulette: { ...base.roulette, opponent: { capacity: 6, bullets: 0 } },
      round: { ...base.round, opponent, phase: "roulette-trigger", currentActor: null, outcome: { reason: "comparison", winner: "player", penaltyTarget: "opponent", bulletsAdded: 1 } } };
    const { createDefaultSave, createRuntimeSave } = await load("/src/persistence/boot.ts");
    const repo = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repo.saveLongTerm(save); await repo.saveRuntime(createRuntimeSave(match));
    (window as any).__inventoryRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  });
}

for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }]) {
  test(`通用技能牌多标记及回合末批量撤除 ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await mount(page);
    await page.locator(".skill-drawer-toggle").click();
    const active = page.locator('[data-skill-instance="neutral-slot-0"]');
    const passive = page.locator('[data-skill-instance="neutral-slot-1"]');
    const retained = page.locator('[data-skill-instance="neutral-slot-2"]');
    for (const tile of [active, passive]) {
      await expect(tile.locator(".card-marker")).toHaveCount(2);
      await expect(tile.locator(".skill-card")).toHaveAttribute("aria-label", /筛选目标、附加标记/);
      for (const marker of await tile.locator(".card-marker").all()) {
        const outer = (await tile.locator(".skill-card").boundingBox())!, inner = (await marker.boundingBox())!;
        expect(inner.x).toBeGreaterThanOrEqual(outer.x); expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
        expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
        expect(await marker.evaluate(node => getComputedStyle(node).pointerEvents)).toBe("none");
      }
    }
    await expect(retained.locator(".card-marker")).toHaveCount(0);
    await active.locator("button.skill-info").click();
    await expect(page.locator(".skill-info-modal")).toBeVisible();
    await page.getByRole("button", { name: "关闭技能说明", exact: true }).click();
    await page.screenshot({ path: info.outputPath(`skill-markers-${viewport.width}.png`) });
    await page.getByRole("button", { name: "静观好戏", exact: true }).click();
    await page.getByRole("button", { name: "下一轮", exact: true }).click();
    await expect(active).toHaveCount(0); await expect(passive).toHaveCount(0); await expect(retained).toBeVisible();
    await expect(page.getByRole("meter", { name: "已移除技能牌", exact: true })).toHaveAttribute("aria-valuenow", "2");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`skill-removal-${viewport.width}.png`) });
  });
}
