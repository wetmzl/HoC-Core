import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, mode: "circuit" | "escape" | "custom" | "restore" = "circuit") {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async mode => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    if (mode !== "restore") {
      const save = (await load("/src/persistence/boot.ts")).createDefaultSave();
      save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
      save.tutorialProgress.completedIds.push("adult-content-warning");
      await repository.saveLongTerm(save);
      const { FlowDefinitionSchema } = await load("/src/core/flow/schema.ts");
      const { createProgramRun } = await load("/src/core/flow/program-engine.ts");
      const { compileLegacyFlow } = await load("/src/core/flow/program-templates.ts");
      const { ProgramDefinitionSchema } = await load("/src/core/flow/program.ts");
      const { programSnapshot } = await load("/src/runtime/program-session.ts");
      const definition = FlowDefinitionSchema.parse({
        id: "neutral-browser-circuit", completionId: "neutral-browser-complete", playerGun: { capacity: 3, bullets: 1 },
        presentation: { title: "三场邀请", description: "按节点继续牌局。", continueLabel: "继续对局", resultActions: "return" },
        nodes: [
          { id: "first", opponentId: "llama", opponentGun: { capacity: 3, bullets: 0 }, abilities: [],
            victoryRewards: { skillDraws: 2, removeBullets: 1, pointAdvantage: 2 },
            presentation: { tableTitle: "第一场", objective: "首次邀请 {name}", exit: { label: "换下一场", title: "保留资源，前往下一节点" } },
            routes: { victory: { type: "node", nodeId: "second" }, defeat: { type: "finish", result: "defeat" },
              escaped: mode === "escape" ? { type: "node", nodeId: "second" } : { type: "finish", result: "abandoned" } } },
          { id: "second", opponentId: "llama", requires: mode === "escape" ? [] : ["first"], opponentGun: { capacity: 5, bullets: 0 }, abilities: [],
            presentation: { tableTitle: "第二场", objective: "再次邀请 {name}" },
            routes: { victory: { type: "node", nodeId: "final" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } },
          { id: "final", opponentId: "chatgpt", requires: ["second"], opponentGun: { capacity: 9, bullets: 0 }, abilities: [],
            presentation: { tableTitle: "最后一场" },
            routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } }
        ]
      });
      const program = mode === "custom" ? ProgramDefinitionSchema.parse({ version: 2, id: "browser-declarative", start: "initialize",
        presentation: { title: "自由编排", resultActions: "return" }, nodes: [
          { id: "initialize", type: "initialize", resources: { gun: { capacity: 4, bullets: 1 }, player: "clear", comparisonBonus: 0 }, variables: { purchases: 0 }, next: "intro" },
          { id: "intro", type: "presentation", title: "开局说明", body: "选择准备方式，然后进入牌局。", next: "choose" },
          { id: "choose", type: "choice", title: "准备阶段", options: [
            { id: "bonus", label: "准备点数优势", to: "bonus-effect", when: { type: "variable", key: "purchases", operator: "eq", value: 0 } },
            { id: "locked", label: "尚未获得的选项", to: "table", when: { type: "variable", key: "purchases", operator: "gt", value: 0 } }
          ] },
          { id: "bonus-effect", type: "effect", effects: [{ id: "count", type: "add-variable", key: "purchases", value: 1 },
            { id: "bonus", type: "resource", resource: "comparisonBonus", operation: "add", value: 3 }], next: "table" },
          { id: "table", type: "match", opponentId: "llama", abilities: [], init: {
            playerGun: { mode: "inherit" }, opponentGun: { mode: "replace", value: { capacity: 7, bullets: 0 } },
            playerSkills: { mode: "reset", openingCards: 0, draws: 2 }
          }, routes: { victory: "settlement", defeat: "settlement", escaped: "settlement" } },
          { id: "settlement", type: "settlement", continueLabel: "继续查看说明", rewards: [
            { id: "extra-draws", label: "额外抽数", effects: [{ id: "draw", type: "resource", resource: "skillDraws", operation: "add", value: 2 }] }
          ], effects: [{ id: "record", type: "record-result", source: "table" }], next: "outro" },
          { id: "outro", type: "presentation", title: "结束说明", body: "战绩已经保存，确认后结束本次流程。", actionLabel: "完成流程", next: "end" },
          { id: "end", type: "end", result: "victory", effects: [{ id: "complete", type: "complete-flow" }] }
        ] }) : compileLegacyFlow(definition);
      await repository.saveRuntime(programSnapshot(createProgramRun("browser-circuit", "neutral-browser-seed", program)));
    }
    (window as any).__genericFlowRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({
      root: document.querySelector("#app"), onExitRequest: async () => {}
    });
  }, mode);
}

async function saved(page: Page) {
  return page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repository = createPersistenceService();
    return { runtime: await repository.loadRuntime(), save: await repository.loadLongTerm() };
  });
}

async function enterNode(page: Page, nodeId: string, name: string) {
  const before = (await saved(page)).runtime;
  await page.locator(`[data-flow-node="${nodeId}"]`).click();
  const profile = page.getByRole("dialog", { name: "个人档案" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("heading", { name, exact: true })).toBeVisible();
  expect((await saved(page)).runtime).toEqual(before);
  await profile.locator("[data-profile-start]").click();
  await expect(page.locator(".table-bottom")).toBeVisible();
}

/** End the real UI-created table deterministically, then restore its ordinary summary screen. */
async function finishTable(page: Page, winner: "player" | "opponent" = "player") {
  await page.evaluate(async winner => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const snapshot = await repository.loadRuntime();
    if (!snapshot?.activeMatch) throw new Error("Expected a live table");
    // Exiting the shell intentionally clears its runtime, so retain the fixture before disposal.
    await (window as any).__genericFlowRuntime.dispose();
    const { gameReducer } = await load("/src/core/match/reducer.ts");
    let match = snapshot.activeMatch;
    const actor = winner === "player" ? "opponent" : "player";
    match = { ...match, roulette: { ...match.roulette, [actor]: { ...match.roulette[actor], bullets: match.roulette[actor].capacity } },
      round: { ...match.round, phase: "roulette-trigger", currentActor: null,
        outcome: { winner, reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
    match = gameReducer(gameReducer(match, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
    if (match.status !== "finished") throw new Error("Deterministic result fixture did not finish");
    await repository.saveRuntime({ ...snapshot, activeMatch: match });
    (window as any).__genericFlowRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({
      root: document.querySelector("#app"), onExitRequest: async () => {}
    });
  }, winner);
  await expect(page.getByRole("heading", { name: winner === "player" ? "策展人胜利" : "策展人落败", exact: true })).toBeVisible();
}

test("three neutral nodes retain rewards across refresh and distinguish repeat opponents", async ({ page }, info) => {
  await mount(page);
  await expect(page.locator(".challenge-selection-heading h1")).toHaveText("三场邀请");
  await expect(page.locator('[data-flow-node="first"]')).toBeEnabled();
  await expect(page.locator('[data-flow-node="second"]')).toBeDisabled();
  await expect(page.locator('[data-flow-node="final"]')).toBeDisabled();
  await enterNode(page, "first", "Llama");
  const first = (await saved(page)).runtime!.activeMatch!;
  expect(first.roulette).toEqual({ player: { capacity: 3, bullets: 1 }, opponent: { capacity: 3, bullets: 0 } });
  expect(first.playerSkills.cards.length).toBeGreaterThan(0);
  await finishTable(page);
  const beforeRewards = (await saved(page)).runtime!.activeProgram!.results.at(-1)!.match;
  await expect(page.locator('[data-summary-action="continue"]')).toBeDisabled();
  await expect(page.locator(".unlock-panel")).toHaveCount(0);
  await page.locator('[data-claim-encounter-reward="removeBullets"]').click();
  await expect(page.locator('[data-claim-encounter-reward="removeBullets"]')).toBeDisabled();

  await expect.poll(async () => {
    const run = (await saved(page)).runtime?.activeProgram;
    return run?.claimed.includes(JSON.stringify([run.id, run.visitIndex, "reward", "removeBullets"]));
  }).toBe(true);
  await mount(page, "restore");
  await expect(page.locator('[data-claim-encounter-reward="removeBullets"]')).toBeDisabled();
  await expect(page.locator('[data-claim-encounter-reward="skillDraws"]')).toBeEnabled();
  await expect(page.locator('[data-summary-action="continue"]')).toBeDisabled();
  expect((await saved(page)).runtime!.activeProgram!.results.at(-1)!.id).toBe(first.id);
  expect((await saved(page)).runtime!.activeMatch).toBeNull();
  for (const kind of ["skillDraws", "pointAdvantage"]) {
    await page.locator(`[data-claim-encounter-reward="${kind}"]`).click();
    await expect(page.locator(`[data-claim-encounter-reward="${kind}"]`)).toBeDisabled();
  }
  const rewarded = (await saved(page)).runtime!.activeProgram!.resources!;
  expect(rewarded.player!.inventory.drawCount).toBe(beforeRewards.playerSkills.drawCount + 2);
  expect(rewarded.gun).toEqual({ capacity: 3, bullets: 0 });
  await page.locator('[data-summary-action="continue"]').click();
  await expect(page.locator('[data-flow-node="second"]')).toBeEnabled();
  const selection = (await saved(page)).runtime!;
  const selectedNode = selection.activeProgram!.definition.nodes.find(node => node.id === selection.activeProgram!.cursor)!;
  expect(selectedNode.type === "choice" && selectedNode.options.map(option => option.to)).toEqual(["second"]);
  expect(selection.activeProgram!.completed).toEqual(["first"]);
  expect(selection.activeProgram!.resources!.comparisonBonus).toBe(2);
  expect(selection.activeMatch).toBeNull();
  expect((await saved(page)).save!.history).toHaveLength(0);

  await mount(page, "restore");
  await expect(page.locator('[data-flow-node="first"]')).toHaveCount(0);
  await expect(page.locator('[data-flow-node="second"]')).toBeEnabled();
  await expect(page.locator('[data-flow-node="final"]')).toHaveCount(0);
  expect((await saved(page)).runtime).toEqual(selection);
  await page.screenshot({ path: info.outputPath("generic-directed-selection.png"), fullPage: true });
  await enterNode(page, "second", "Llama");
  const second = (await saved(page)).runtime!.activeMatch!;
  expect(second.id).not.toBe(first.id); expect(second.seed).not.toBe(first.seed);
  expect(second.opponentId).toBe(first.opponentId);
  expect(second.roulette).toEqual({ player: rewarded.gun, opponent: { capacity: 5, bullets: 0 } });
  expect(second.playerSkills.cards).toEqual(rewarded.player!.inventory.cards);
  expect(second.playerSkills.drawCount).toBe(rewarded.player!.inventory.drawCount);
  expect(second.comparisonBonuses).toEqual({ player: 2, opponent: 0 });
  expect((await saved(page)).runtime!.activeProgram!.cursor).toBe("second");
  await finishTable(page);
  await page.locator('[data-summary-action="continue"]').click();
  await expect(page.locator('[data-flow-node="final"]')).toBeEnabled();
  await enterNode(page, "final", "ChatGPT");
  const final = (await saved(page)).runtime!.activeMatch!;
  expect(final.roulette.opponent.capacity).toBe(9);
  expect(final.roulette.player).toEqual(rewarded.gun);
  expect(final.playerSkills.drawCount).toBe(rewarded.player!.inventory.drawCount);
  await finishTable(page);
  await expect(page.locator('[data-summary-action="continue"]')).toHaveCount(0);
  await page.locator('[data-summary-action="lobby"]').click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  const completed = await saved(page);
  expect(completed.runtime).toBeNull();
  expect(completed.save!.history.map(record => record.id)).toEqual([final.id]);
  expect(completed.save!.profile.matchesPlayed).toBe(1);
  expect(completed.save!.completedChallenges).toEqual(["neutral-browser-complete"]);
});

test("a defeat ends a node whose victory would continue and records the result only once", async ({ page }) => {
  await mount(page);
  await enterNode(page, "first", "Llama");
  const firstId = (await saved(page)).runtime!.activeMatch!.id;
  await finishTable(page, "opponent");
  await expect(page.locator('[data-summary-action="continue"], [data-claim-encounter-reward]')).toHaveCount(0);
  await expect(page.locator('[data-summary-action="lobby"]')).toBeEnabled();
  expect((await saved(page)).save!.history).toHaveLength(0);
  await mount(page, "restore");
  await expect(page.getByRole("heading", { name: "策展人落败", exact: true })).toBeVisible();
  await page.locator('[data-summary-action="lobby"]').click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  await mount(page, "restore");
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  const result = await saved(page);
  expect(result.runtime).toBeNull();
  expect(result.save!.history.map(record => record.id)).toEqual([firstId]);
  expect(result.save!.profile.matchesPlayed).toBe(1);
  expect(result.save!.profile.wins).toBe(0);
  expect(result.save!.completedChallenges ?? []).toEqual([]);
});

test("escaping can route directly to a different node without granting victory or resetting inventory", async ({ page }) => {
  await mount(page, "escape");
  await enterNode(page, "first", "Llama");
  const first = (await saved(page)).runtime!.activeMatch!;
  await page.locator("[data-exit-encounter]").click();
  await expect(page.locator(".challenge-selection")).toBeVisible();
  await expect(page.locator(".summary-shell")).toHaveCount(0);
  await expect(page.locator('[data-flow-node="first"]')).toHaveCount(0);
  await expect(page.locator('[data-flow-node="second"]')).toBeEnabled();
  const escaped = await saved(page);
  const escapedChoice = escaped.runtime!.activeProgram!.definition.nodes.find(node => node.id === escaped.runtime!.activeProgram!.cursor)!;
  expect(escapedChoice.type === "choice" && escapedChoice.options.map(option => option.to)).toEqual(["second"]);
  expect(escaped.runtime!.activeProgram!.completed).toEqual([]);
  expect(escaped.runtime!.activeProgram!.resources!.comparisonBonus).toBe(0);
  expect(escaped.runtime!.activeProgram!.resources!.player!.inventory.cards).toEqual(first.playerSkills.cards);
  expect(escaped.save!.history).toHaveLength(0);
  await mount(page, "restore");
  await expect(page.locator('[data-flow-node="first"]')).toHaveCount(0);
  await enterNode(page, "second", "Llama");
  const second = (await saved(page)).runtime!.activeMatch!;
  expect(second.id).not.toBe(first.id);
  expect(second.roulette.player).toEqual(first.roulette.player);
  expect(second.playerSkills.cards).toEqual(first.playerSkills.cards);
  expect(second.playerSkills.drawCount).toBe(first.playerSkills.drawCount);
  expect(second.roulette.opponent).toEqual({ capacity: 5, bullets: 0 });
});

test("authored display, choice, effects, initialization and settlement recover independently", async ({ page }, info) => {
  await mount(page, "custom");
  await expect(page.getByRole("heading", { name: "开局说明", exact: true })).toBeVisible();
  const intro = (await saved(page)).runtime!.activeProgram!;
  expect(intro.cursor).toBe("intro");
  await mount(page, "restore");
  await expect(page.getByRole("heading", { name: "开局说明", exact: true })).toBeVisible();
  expect((await saved(page)).runtime!.activeProgram).toEqual(intro);
  await page.locator("[data-program-confirm]").click();
  await expect(page.getByRole("heading", { name: "准备阶段", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "准备点数优势", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "尚未获得的选项", exact: true })).toBeDisabled();
  await mount(page, "restore");
  await expect(page.getByRole("heading", { name: "准备阶段", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "准备点数优势", exact: true }).click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  const created = (await saved(page)).runtime!;
  const match = created.activeMatch!;
  expect(created.activeProgram!.resources).toBeNull();
  expect(created.activeProgram!.variables.purchases).toBe(1);
  expect(created.activeProgram!.visits["bonus-effect"]).toBe(1);
  expect(match.roulette).toEqual({ player: { capacity: 4, bullets: 1 }, opponent: { capacity: 7, bullets: 0 } });
  expect(match.comparisonBonuses?.player).toBe(3);
  expect(match.playerSkills.cards).toEqual([]);
  expect(match.playerSkills.drawCount).toBe(2);
  await mount(page, "restore");
  await expect(page.locator(".table-bottom")).toBeVisible();
  expect((await saved(page)).runtime!.activeMatch!.id).toBe(match.id);
  expect((await saved(page)).runtime!.activeProgram!.variables.purchases).toBe(1);
  await finishTable(page);
  await expect(page.getByRole("button", { name: "领取额外抽数", exact: true })).toBeEnabled();
  await expect(page.locator('[data-summary-action="continue"]')).toBeDisabled();
  expect((await saved(page)).save!.history).toEqual([]);
  await page.getByRole("button", { name: "领取额外抽数", exact: true }).click();
  await expect(page.getByRole("button", { name: "已领取额外抽数", exact: true })).toBeDisabled();
  await mount(page, "restore");
  await expect(page.getByRole("button", { name: "已领取额外抽数", exact: true })).toBeDisabled();
  expect((await saved(page)).runtime!.activeProgram!.resources!.player!.inventory.drawCount).toBe(4);
  expect((await saved(page)).runtime!.activeProgram!.results.at(-1)!.match.playerSkills.drawCount).toBe(2);
  await page.locator('[data-summary-action="continue"]').click();
  await expect(page.getByRole("heading", { name: "结束说明", exact: true })).toBeVisible();
  expect((await saved(page)).save!.history.map(record => record.id)).toEqual([match.id]);
  expect((await saved(page)).save!.completedFlows ?? []).toEqual([]);
  await mount(page, "restore");
  await expect(page.getByRole("heading", { name: "结束说明", exact: true })).toBeVisible();
  expect((await saved(page)).save!.history.map(record => record.id)).toEqual([match.id]);
  await page.screenshot({ path: info.outputPath("declarative-independent-presentation.png"), fullPage: true });
  await page.getByRole("button", { name: "完成流程", exact: true }).click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  const finished = await saved(page);
  expect(finished.runtime).toBeNull();
  expect(finished.save!.history.map(record => record.id)).toEqual([match.id]);
  expect(finished.save!.completedFlows).toEqual(["browser-declarative"]);
});
