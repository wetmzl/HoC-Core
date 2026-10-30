import { expectSkillSheet } from "./skill-sheet-assertions";
import { expect, test, type Page } from "@playwright/test";

// Each isolated context imports the bundled media; keep installation latency
// separate from the unchanged gameplay assertion deadlines.
test.setTimeout(120_000);

async function mount(page: Page, mode: "lobby" | "locked" | "selection" | "guard-loss" | "guard-win" | "boss-loss" | "boss-win" | "restore") {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled({ timeout: 60_000 });
  await page.evaluate(async mode => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    if (mode !== "restore") {
      const { createDefaultSave } = await load("/src/persistence/boot.ts");
      const save = createDefaultSave(); save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
      save.tutorialProgress.completedIds.push("adult-content-warning");
      if (mode !== "locked") save.defeats = ["chatgpt", "llama", "gemini", "deepseek"].map(opponentId => ({ opponentId, timestamp: new Date().toISOString() }));
      await repository.saveLongTerm(save); await repository.deleteRuntime();
      if (mode !== "lobby" && mode !== "locked") {
        const { challengeFlow } = await load("/src/core/challenge/flow.ts");
        const { compileLegacyFlow } = await load("/src/core/flow/program-templates.ts");
        const { createProgramRun, chooseProgram, programMatchId } = await load("/src/core/flow/program-engine.ts");
        const { default: legacyTrial } = await load("/src/core/challenge/fixtures/legacy-challenge.json");
        let run = createProgramRun("browser-trial", "browser-trial", compileLegacyFlow({ ...challengeFlow(legacyTrial), playerGun: { capacity: 8, bullets: 6 } }));
        const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
        let match = createMatch("browser-match", { opponentId: "llama" });
        const { programSnapshot } = await load("/src/runtime/program-session.ts");
        if (mode === "selection") { match = null; }
        else {
          const boss = mode.startsWith("boss"); const won = mode.endsWith("win");
          run = chooseProgram(run, boss ? "boss" : "guard:chatgpt");
          match = createMatch("browser-match", { id: programMatchId(run), opponentId: boss ? legacyTrial.bossId : "chatgpt", playerGun: run.resources.gun });
          const actor = won ? "opponent" : "player";
          match = { ...match, roulette: { ...match.roulette, [actor]: { capacity: boss || actor === "player" ? 8 : 6, bullets: boss || actor === "player" ? 8 : 6 } }, round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: won ? "player" : "opponent", reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
          match = gameReducer(match, { type: "TRIGGER_ROULETTE" });
          match = gameReducer(match, { type: "ACK_TRIGGER_RESULT" });
        }
        await repository.saveRuntime(programSnapshot(match ? { ...run, resources: null } : run, match));
      }
    }
    (window as any).__bossRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({ root: document.querySelector("#app"), onExitRequest: async () => {} });
  }, mode);
  if (mode.endsWith("win") || mode.endsWith("loss")) await expect(page.locator(".summary-shell")).toBeVisible();
}
async function saved(page: Page) {
  return page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repo = createPersistenceService();
    return { runtime: await repo.loadRuntime(), save: await repo.loadLongTerm() };
  });
}
async function challengeGuard(page: Page, characterId: string) {
  await page.locator(`[data-encounter="${characterId}"]`).click();
  const profile = page.getByRole("dialog", { name: "个人档案" });
  await expect(profile).toBeVisible();
  await profile.locator("[data-profile-start]").click();
}
async function claimAllRewards(page: Page) {
  for (const kind of ["skillDraws", "removeBullets", "pointAdvantage"]) {
    const button = page.locator(`[data-claim-encounter-reward="${kind}"]`);
    await button.click(); await expect(button).toBeDisabled();
  }
}
test("unlock entry, four same-faction guards and direct boss with carried roulette", async ({ page }, info) => {
  await mount(page, "locked");
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator(".lobby-boss-entry")).toHaveCount(0);
  await mount(page, "lobby");
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator(".selection-hero")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("boss-entry-390.png"), fullPage: true });
  await page.locator(".lobby-boss-entry").click();
  await expect(page.locator("#profile h2")).toHaveText("Claude");
  await expect(page.locator(".challenge-profile, .boss-dossier, .challenge-warning")).toHaveCount(0);
  await expect(page.locator("#profile .skill-sheet")).toHaveCount(4);
  await expect(page.locator("#profile")).toContainText("禁止蒸馏");
  await expect(page.locator("#profile")).toContainText("高岭之花");
  await expect(page.locator("#profile")).not.toContainText("尚未制作");
  await expect(page.locator("#profile")).not.toContainText("降低强度后的效果");
  await expect(page.locator("#profile")).not.toContainText(/Lv\.?[12]/i);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`boss-profile-top-${width}.png`) });
  }
  await page.screenshot({ path: info.outputPath("boss-intro-390.png"), fullPage: true });
  await page.locator("[data-profile-start]").click();
  await expect(page.locator("[data-encounter]")).toHaveCount(5);
  expect((await saved(page)).runtime?.activeMatch).toBeNull();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const boss = await page.locator(".challenge-boss-action").boundingBox();
    const terminate = await page.locator("[data-abandon]").boundingBox();
    expect(boss!.y + boss!.height).toBeLessThan(terminate!.y);
    expect(terminate!.y + terminate!.height).toBe(page.viewportSize()!.height - 24);
    await page.screenshot({ path: info.outputPath(`boss-selection-${width}.png`), fullPage: true });
  }
  await expect(page.locator(".challenge-selection-heading")).toContainText("削弱阶段。做好准备，或者直视神明的怒火……。");
  await expect(page.locator(".challenge-boss-progress")).toHaveText("（已削弱0/4）");
  const challengeBox = await page.locator(".challenge-boss-action").boundingBox();
  const terminateBox = await page.getByRole("button", { name: "终止挑战", exact: true }).boundingBox();
  expect(challengeBox?.width).toBe(terminateBox?.width);
  expect(challengeBox?.height).toBe(terminateBox?.height);
  await expect(page.locator("[data-guard-info]")).toHaveCount(4);
  const beforeInfo = await saved(page);
  await page.locator('[data-guard-info="chatgpt"]').click({ position: { x: 12, y: 22 } });
  await expect(page.locator("#profile")).not.toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".challenge-skill-before .skill-sheet-brief")).toBeVisible();
  await expect(page.locator(".challenge-skill-before .skill-sheet-rules")).toBeVisible();
  await expect(page.locator(".challenge-skill-before .skill-sheet-rules")).toContainText("⌊n/2⌋");
  await expect(page.locator(".challenge-skill-after .skill-sheet-rules")).toContainText("增加 1 点");
  await expect(page.locator(".challenge-skill-after .skill-sheet-rules")).toBeVisible();
  await expect(page.locator(".challenge-skill-after .skill-sheet-lore")).toBeVisible();
  await page.locator(".challenge-skill-after .skill-sheet > summary").click();
  await expect(page.locator(".challenge-skill-after .skill-sheet-rules")).toBeHidden();
  await expect(page.locator(".challenge-skill-after .skill-sheet-lore")).toBeHidden();
  await page.locator(".challenge-skill-after .skill-sheet > summary").click();
  await expect(page.getByRole("dialog")).not.toContainText("详细规则");
  await expect(page.getByRole("dialog")).not.toContainText("技能削弱");
  await expect(page.getByRole("dialog")).not.toContainText("削弱前");
  await expect(page.getByRole("dialog")).not.toContainText("削弱后");
  expect(await page.locator(".challenge-arrow-flow").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  expect((await saved(page)).runtime).toEqual(beforeInfo.runtime);
  await page.screenshot({ path: info.outputPath("skill-comparison-320.png") });
  await page.getByRole("button", { name: "关闭削弱说明" }).click();
  for (const [slot, name, full, weakened] of [
    ["gemini", "禁止蒸馏", "每轮不限次数", "每轮限一次"],
    ["deepseek", "高岭之花", "不超过 4", "为 0"]
  ]) {
    await page.locator(`[data-guard-info="${slot}"]`).click();
    await expect(page.getByRole("dialog")).toContainText(name);
    await expect(page.locator(".challenge-skill-before")).toContainText(full);
    await expect(page.locator(".challenge-skill-after")).toContainText(weakened);
    if (slot === "gemini") await expect(page.getByRole("dialog")).toContainText("光明正大拿来用和偷偷蒸馏能一样吗～");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({ path: info.outputPath(`${slot}-skill-comparison-320.png`) });
    await page.getByRole("button", { name: "关闭削弱说明" }).click();
  }
  await mount(page, "selection");
  await challengeGuard(page, "claude");
  await expect(page.locator(".table-bottom")).toBeVisible();
  const data = await saved(page);
  expect(data.runtime?.activeProgram?.cursor).toBe("boss");
  expect(data.runtime?.activeMatch?.opponentId).toBe("claude");
  expect(data.runtime?.activeMatch?.roulette).toEqual({ player: { capacity: 8, bullets: 6 }, opponent: { capacity: 8, bullets: 0 } });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".roulette-status .gun-chambers i")).toHaveCount(16);
    expect(await page.locator(".gun-status-row").evaluateAll(rows => rows.every(row => {
      const frame = row.getBoundingClientRect();
      return [...row.querySelectorAll(".gun-chambers i")].every(dot => {
        const rect = dot.getBoundingClientRect();
        return rect.left >= frame.left && rect.right <= frame.right && rect.right <= innerWidth;
      });
    }))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`boss-eight-chambers-${width}.png`), fullPage: true });
  }
  await expect(page.locator(".table-top h1")).toHaveText("Claude · Boss 战");
  await expect(page.locator(".character-intel-skill")).toHaveCount(4);
  await page.locator(".character-intel-tab").click();
  await expectSkillSheet(page.locator(".character-intel .skill-sheet").first());
  await page.screenshot({ path: info.outputPath("unified-boss-intel-320.png") });
  expect(data.runtime?.activeMatch?.roulette.player.bullets).toBe(6);
  expect(data.runtime?.activeMatch?.abilities.instances.filter(instance => instance.kind === "ai-skill").map(instance => instance.level)).toEqual([2, 2, 2, 2]);
});
test("guard portraits open their own dossier without starting a match until confirmed", async ({ page }, info) => {
  await mount(page, "selection");
  const initial = (await saved(page)).runtime;
  for (const [id, name] of [["chatgpt", "ChatGPT"], ["llama", "Llama"], ["gemini", "Gemini"], ["deepseek", "DeepSeek"]]) {
    await page.locator(`[data-encounter="${id}"]`).click();
    const profile = page.getByRole("dialog", { name: "个人档案" });
    await expect(profile).toBeVisible();
    await expect(profile.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(profile.locator(".profile-description")).not.toBeEmpty();
    await expect(profile.locator("[data-weaken-skill]")).toHaveCount(0);
    expect((await saved(page)).runtime).toEqual(initial);
    if (id === "chatgpt") {
      await expect(profile.locator(".profile-abilities")).toContainText("RESET");
      await expect(profile.locator(".profile-abilities")).not.toContainText("克劳德时刻");
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`guard-dossier-${width}.png`) });
      }
    }
    await profile.locator("[data-close]").click();
    expect((await saved(page)).runtime).toEqual(initial);
  }
  await page.locator('[data-encounter="chatgpt"]').click();
  await page.locator("#profile [data-profile-start]").click();
  await expect(page.locator(".table-top h1")).toHaveText("ChatGPT · 守卫战");
  const current = (await saved(page)).runtime!;
  expect(current.activeProgram?.visitIndex).toBe(initial!.activeProgram!.visitIndex + 1);
  expect(current.activeMatch!.playerSkills.drawCount).toBe(1);
});

test("guard gunshot returns to choice, retains all eight bullets and survives reload", async ({ page }) => {
  await mount(page, "guard-loss");
  await expect(page.getByRole("heading", { name: "策展人落败" })).toBeVisible();
  await page.getByRole("button", { name: "返回四人选择" }).click();
  await expect(page.locator(".challenge-grid")).toBeVisible();
  let data = await saved(page);
  expect(data.runtime?.activeProgram?.resources?.gun.bullets).toBe(8);
  expect(data.save?.profile.matchesPlayed).toBe(0);
  await mount(page, "restore");
  expect((await saved(page)).runtime?.activeProgram?.resources?.gun.bullets).toBe(8);
  await expect(page.locator(".challenge-risk, .challenge-progress")).toHaveCount(0);
  await challengeGuard(page, "llama");
  await expect(page.locator(".table-bottom")).toBeVisible();
  data = await saved(page);
  expect(data.runtime?.activeProgram?.cursor).toBe("guard:llama");
  expect(data.runtime?.activeMatch?.roulette.player.bullets).toBe(8);
});
test("guard win lowers exactly one boss skill without permanent guard rewards", async ({ page }, info) => {
  await mount(page, "guard-win");
  await expect(page.getByRole("heading", { name: "策展人胜利", exact: true })).toBeVisible();
  await expect(page.locator(".summary-character")).toBeVisible();
  await expect(page.locator(".unlock-panel, [data-reward-deck]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "返回四人选择", exact: true })).toBeDisabled();
  const beforeMatch = (await saved(page)).runtime!.activeProgram!.results.at(-1)!.match;
  const beforeReward = beforeMatch.playerSkills.drawCount;
  const afterBullets = Math.max(0, beforeMatch.roulette.player.bullets - 2);
  await expect(page.locator(".summary-resource-reward")).toContainText("左轮子弹");
  await expect(page.locator(".summary-resource-reward")).toContainText("点数优势");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`guard-reward-${width}.png`), fullPage: true });
  }
  await expect(page.locator(".summary-resource-icon")).toHaveCount(3);
  await page.locator('[data-claim-encounter-reward="removeBullets"]').click();
  await expect(page.locator('[data-claim-encounter-reward="removeBullets"]')).toBeDisabled();
  expect((await saved(page)).runtime!.activeProgram!.resources!.gun.bullets).toBe(afterBullets);
  expect((await saved(page)).runtime!.activeProgram!.resources!.player!.inventory.drawCount).toBe(beforeReward);
  expect((await saved(page)).runtime!.activeProgram!.resources!.comparisonBonus).toBe(0);
  await mount(page, "restore");
  await expect(page.locator('[data-claim-encounter-reward="removeBullets"]')).toBeDisabled();
  await expect(page.locator('[data-claim-encounter-reward="skillDraws"]')).toBeEnabled();
  await expect(page.locator('[data-claim-encounter-reward="pointAdvantage"]')).toBeEnabled();
  await expect(page.getByRole("button", { name: "返回四人选择", exact: true })).toBeDisabled();
  await page.locator('[data-claim-encounter-reward="pointAdvantage"]').click();
  await expect(page.locator('[data-claim-encounter-reward="pointAdvantage"]')).toBeDisabled();
  expect((await saved(page)).runtime!.activeProgram!.resources!.comparisonBonus).toBe(1);
  expect((await saved(page)).runtime!.activeProgram!.resources!.player!.inventory.drawCount).toBe(beforeReward);
  await page.locator('[data-claim-encounter-reward="skillDraws"]').click();
  await expect(page.locator('[data-claim-encounter-reward]:disabled')).toHaveCount(3);
  expect((await saved(page)).runtime!.activeProgram!.resources!.player!.inventory.drawCount).toBe(beforeReward + 3);
  await mount(page, "restore");
  await expect(page.locator('[data-claim-encounter-reward]:disabled')).toHaveCount(3);
  expect((await saved(page)).runtime!.activeProgram!.resources!.player!.inventory.drawCount).toBe(beforeReward + 3);
  await page.getByRole("button", { name: "返回四人选择" }).click();
  await expect(page.locator('[data-encounter="chatgpt"]')).toBeDisabled();
  await expect(page.locator('[data-encounter="chatgpt"]')).toHaveClass(/is-defeated/);
  await expect(page.locator(".challenge-boss-progress")).toHaveText("（已削弱1/4）");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`boss-guard-grey-${width}.png`), fullPage: true });
  }
  await page.locator('[data-guard-info="chatgpt"]').click({ position: { x: 12, y: 22 } });
  await expect(page.locator("#profile")).not.toBeVisible();
  await expect(page.locator(".challenge-skill-before")).toBeVisible();
  expect((await saved(page)).runtime?.activeProgram?.completed).toEqual(["guard:chatgpt"]);
  await page.getByRole("button", { name: "关闭削弱说明" }).click();
  expect((await saved(page)).save?.defeats.map(record => record.opponentId)).toEqual(["chatgpt", "llama", "gemini", "deepseek"]);
  await challengeGuard(page, "llama");
  await expect(page.locator(".table-top h1")).toHaveText("Llama · 守卫战");
  const guard = (await saved(page)).runtime!.activeMatch!;
  expect(guard.comparisonBonuses).toEqual({ player: 1, opponent: 0 });
  expect(guard.roulette.player.bullets).toBe(afterBullets);
  expect(await page.evaluate(async () => {
    const { previewComparisonScores } = await import(/* @vite-ignore */ "/src/core/match/reducer.ts");
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const match = (await createPersistenceService().loadRuntime())!.activeMatch!;
    const preview = previewComparisonScores(match); return preview.scores.player - preview.baseScores.player;
  })).toBe(1);
  await page.getByRole("button", { name: "逃跑", exact: true }).click();
  await expect(page.locator(".challenge-grid")).toBeVisible();
  await challengeGuard(page, "claude");
  await expect(page.locator(".table-bottom")).toBeVisible();
  const data = await saved(page);
  expect(data.runtime!.activeMatch!.playerSkills.drawCount).toBe(beforeReward + 3);
  expect(data.runtime!.activeMatch!.roulette.player.bullets).toBe(afterBullets);
  expect(data.runtime!.activeMatch!.comparisonBonuses).toEqual({ player: 1, opponent: 0 });
  expect(data.save!.history).toHaveLength(0);
  const skills = data.runtime!.activeMatch!.abilities.instances.filter(instance => instance.kind === "ai-skill");
  expect(skills).toHaveLength(4);
  await expect(page.locator(".character-intel-skill")).toHaveCount(4);
  expect(skills.find(instance => instance.definitionId === "claude-ss-moment")?.level).toBe(1);
  expect(skills.filter(instance => instance.level === 2)).toHaveLength(3);
});
for (const result of ["loss", "win"] as const) test(`boss ${result} ends run and commits once`, async ({ page }, info) => {
  await mount(page, result === "win" ? "boss-win" : "boss-loss");
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  await expect(page.locator(".challenge-result")).toHaveCount(0);
  const data = await saved(page);
  expect(data.runtime).toBeNull(); expect(data.save?.profile.matchesPlayed).toBe(1);
  expect(data.save?.profile.wins).toBe(result === "win" ? 1 : 0);
  expect(data.save?.completedChallenges ?? []).toEqual(result === "win" ? ["intelligent-core-trial"] : []);
  await page.screenshot({ path: info.outputPath(`boss-${result}-direct-lobby.png`) });
  await mount(page, "restore");
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  expect((await saved(page)).save?.profile.matchesPlayed).toBe(1);
  expect((await saved(page)).save?.history).toHaveLength(1);
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator(".lobby-boss-entry")).toHaveCount(result === "win" ? 0 : 1);
});

test("restoring an already finished challenge returns to the lobby without recording another result", async ({ page }) => {
  await mount(page, "selection");
  const before = (await saved(page)).save;
  await page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repo = createPersistenceService();
    // Old schema-13 snapshots could contain an already finished legacy challenge.
    const { default: legacyTrial } = await import(/* @vite-ignore */ "/src/core/challenge/fixtures/legacy-challenge.json");
    const { createChallenge } = await import(/* @vite-ignore */ "/src/core/challenge/reducer.ts");
    const { CHARACTER_CATALOG } = await import(/* @vite-ignore */ "/src/content/characters/index.ts");
    const { challengeSnapshot } = await import(/* @vite-ignore */ "/src/runtime/encounter-snapshot.ts");
    const save = (await repo.loadLongTerm())!;
    const run = createChallenge("legacy-finished", legacyTrial, save.defeats, CHARACTER_CATALOG);
    const driver = Reflect.get(repo, "driver"), raw = await driver.readSnapshot();
    await driver.writeSnapshot({ ...raw, runtime: { ...challengeSnapshot({ ...run, phase: "finished", result: "defeat" }, null), schemaVersion: 13 } });
  });
  await mount(page, "restore");
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  await expect(page.locator(".challenge-result")).toHaveCount(0);
  const after = await saved(page);
  expect(after.runtime).toBeNull();
  expect(after.save?.profile).toEqual(before?.profile);
  expect(after.save?.history).toEqual(before?.history);
  expect(after.save?.completedChallenges).toEqual(before?.completedChallenges);
});

test("failed reward save grants nothing and remains retryable", async ({ page }) => {
  await mount(page, "guard-win");
  const before = (await saved(page)).runtime!;
  await page.evaluate(async () => {
    const { PersistenceService } = await import(/* @vite-ignore */ "/src/persistence/save-service.ts");
    const { programRewardClaimed } = await import(/* @vite-ignore */ "/src/core/flow/program-engine.ts");
    const original = PersistenceService.prototype.saveRuntime; let fail = true;
    PersistenceService.prototype.saveRuntime = async function(save) {
      if (fail && save.activeProgram && programRewardClaimed(save.activeProgram, "skillDraws")) { fail = false; throw new Error("reward-write-failure"); }
      return original.call(this, save);
    };
  });
  await page.locator('[data-claim-encounter-reward="skillDraws"]').click();
  await expect(page.locator("[data-encounter-status]:visible")).toContainText("reward-write-failure");
  const failed = (await saved(page)).runtime!;
  expect(failed.activeProgram!.resources!.player!.inventory.drawCount).toBe(before.activeProgram!.resources!.player!.inventory.drawCount);
  expect(failed.activeProgram!.claimed).toEqual(before.activeProgram!.claimed);
  expect(failed.activeProgram!.resources!.comparisonBonus).toBe(before.activeProgram!.resources!.comparisonBonus);
  expect(failed.activeProgram!.resources!.gun).toEqual(before.activeProgram!.resources!.gun);
  await page.locator('[data-claim-encounter-reward="skillDraws"]').click();
  await expect(page.locator('[data-claim-encounter-reward="skillDraws"]')).toBeDisabled();
  expect((await saved(page)).runtime!.activeProgram!.resources!.player!.inventory.drawCount).toBe(before.activeProgram!.resources!.player!.inventory.drawCount + 3);
});

test("failed selection checkpoint stays retryable without losing the completed guard", async ({ page }) => {
  await mount(page, "guard-win");
  await claimAllRewards(page);
  const pending = (await saved(page)).runtime!;
  expect(pending.activeMatch).toBeNull();
  expect(pending.activeProgram!.definition.nodes.find(node => node.id === pending.activeProgram!.cursor)?.type).toBe("settlement");
  await page.evaluate(async () => {
    const { PersistenceService } = await import(/* @vite-ignore */ "/src/persistence/save-service.ts");
    const original = PersistenceService.prototype.saveRuntime;
    let fail = true;
    PersistenceService.prototype.saveRuntime = async function (save) {
      if (fail && save.activeProgram?.definition.nodes.find(node => node.id === save.activeProgram!.cursor)?.type === "choice") { fail = false; throw new Error("checkpoint-test-failure"); }
      return original.call(this, save);
    };
  });
  await page.getByRole("button", { name: "返回四人选择" }).click();
  await expect(page.locator("[data-encounter-status]:visible")).toContainText("checkpoint-test-failure");
  expect((await saved(page)).runtime).toEqual(pending);
  await mount(page, "restore");
  await expect(page.getByRole("heading", { name: "策展人胜利", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回四人选择" }).click();
  await expect(page.locator(".challenge-grid")).toBeVisible();
  expect((await saved(page)).runtime?.activeProgram?.completed).toEqual(["guard:chatgpt"]);
});
test("failed boss commit restores the pending result and awards it once", async ({ page }) => {
  await mount(page, "boss-win");
  const pending = (await saved(page)).runtime!;
  expect(pending.activeMatch).toBeNull();
  expect(pending.activeProgram!.definition.nodes.find(node => node.id === pending.activeProgram!.cursor)?.type).toBe("settlement");
  await page.evaluate(async () => {
    const { PersistenceService } = await import(/* @vite-ignore */ "/src/persistence/save-service.ts");
    PersistenceService.prototype.commitMatchResult = async () => { throw new Error("boss-commit-test-failure"); };
  });
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect(page.locator("[data-encounter-status]:visible")).toContainText("boss-commit-test-failure");
  await expect(page.locator(".lobby-menu-shell")).toHaveCount(0);
  expect((await saved(page)).save?.profile.wins).toBe(0);
  expect((await saved(page)).runtime).toEqual(pending);
  await mount(page, "restore");
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  const data = await saved(page);
  expect(data.save?.profile.wins).toBe(1); expect(data.save?.history).toHaveLength(1);
  expect(data.runtime).toBeNull();
});

test("failed encounter opening rolls back to selection and can be retried", async ({ page }) => {
  await mount(page, "selection");
  await page.evaluate(async () => {
    const { PersistenceService } = await import(/* @vite-ignore */ "/src/persistence/save-service.ts");
    const original = PersistenceService.prototype.saveRuntime;
    let fail = true;
    PersistenceService.prototype.saveRuntime = async function (save) {
      if (fail && save.activeMatch?.status === "active") { fail = false; throw new Error("opening-test-failure"); }
      return original.call(this, save);
    };
  });
  await challengeGuard(page, "claude");
  await expect(page.locator("[data-encounter-status]:visible")).toContainText("opening-test-failure");
  const data = await saved(page);
  expect(data.runtime?.activeProgram?.definition.nodes.find(node => node.id === data.runtime!.activeProgram!.cursor)?.type).toBe("choice"); expect(data.runtime?.activeMatch).toBeNull();
  await challengeGuard(page, "claude");
  await expect(page.locator(".table-bottom")).toBeVisible();
  expect((await saved(page)).runtime?.activeMatch?.roulette.player.bullets).toBe(6);
});

test("escaping guards discards their tables, keeps only shared inventory and grants opening rewards once", async ({ page }, info) => {
  await mount(page, "selection");
  await challengeGuard(page, "chatgpt");
  await expect(page.getByRole("button", { name: "逃跑", exact: true })).toBeVisible();
  await expect(page.locator('.table-withdraw-hint')).toHaveCount(0);
  const first = (await saved(page)).runtime!.activeMatch!;
  expect(first.roulette.player.capacity).toBe(8); expect(first.roulette.opponent.capacity).toBe(6);
  expect(first.playerSkills.cards.length).toBeGreaterThan(0); expect(first.playerSkills.drawCount).toBe(1);
  await page.screenshot({ path: info.outputPath("guard-escape-390.png"), fullPage: true });
  await page.getByRole("button", { name: "逃跑", exact: true }).click();
  await expect(page.locator('.challenge-grid')).toBeVisible();
  await expect(page.locator('[data-encounter="chatgpt"]')).not.toContainText("继续战斗");
  let data = await saved(page);
  expect(data.runtime!.activeMatch).toBeNull(); expect(data.runtime!.activeProgram!.completed).toEqual([]);
  expect(Object.keys(data.runtime!.activeProgram!.resources!).sort()).toEqual(["comparisonBonus", "gun", "player"]);
  expect(data.runtime!.activeProgram!.resources!.player!.inventory.cards).toEqual(first.playerSkills.cards);
  expect(JSON.stringify(data.runtime!.activeProgram!.resources)).not.toContain('"shoe"');
  expect(JSON.stringify(data.runtime!.activeProgram!.resources)).not.toContain('"history"');
  expect(JSON.stringify(data.runtime!.activeProgram!.resources).length).toBeLessThan(JSON.stringify(first).length / 2);
  await challengeGuard(page, "llama");
  await expect(page.locator('.table-top h1')).toHaveText("Llama · 守卫战");
  const second = (await saved(page)).runtime!.activeMatch!;
  expect(second.playerSkills.cards).toEqual(first.playerSkills.cards);
  expect(second.playerSkills.drawCount).toBe(first.playerSkills.drawCount);
  expect(second.roulette.player).toEqual(first.roulette.player);
  expect(second.history).not.toContainEqual(expect.objectContaining({ type: "ABILITY_TRIGGERED", definitionId: "early-preparation" }));
  await page.getByRole("button", { name: "逃跑", exact: true }).click();
  await expect(page.locator('.challenge-grid')).toBeVisible();
  await mount(page, "restore");
  await challengeGuard(page, "chatgpt");
  await expect(page.locator('.table-top h1')).toHaveText("ChatGPT · 守卫战");
  const retry = (await saved(page)).runtime!.activeMatch!;
  expect(retry.id).not.toBe(first.id); expect(retry.seed).not.toBe(first.seed);
  expect(retry.shoe).not.toEqual(first.shoe); expect(retry.roundIndex).toBe(0);
  expect(retry.playerSkills.cards).toEqual(second.playerSkills.cards);
  expect(retry.playerSkills.drawCount).toBe(first.playerSkills.drawCount);
  expect((await saved(page)).save!.profile.matchesPlayed).toBe(0);
  await page.getByRole("button", { name: "逃跑", exact: true }).click();
  await challengeGuard(page, "claude");
  await expect(page.locator('.table-top h1')).toHaveText("Claude · Boss 战");
  data = await saved(page);
  expect(data.runtime!.activeMatch!.playerSkills.cards).toEqual(first.playerSkills.cards);
  expect(data.runtime!.activeMatch!.playerSkills.drawCount).toBe(first.playerSkills.drawCount);
  await expect(page.locator('[data-exit-encounter]')).toHaveCount(1);
});

test("a failed escape save keeps the guard playable; a successful retry discards its table", async ({ page }) => {
  await mount(page, "selection");
  await challengeGuard(page, "llama");
  await expect(page.locator('[data-exit-encounter]')).toBeVisible();
  const before = (await saved(page)).runtime!.activeMatch!;
  await page.evaluate(async () => {
    const { PersistenceService } = await import(/* @vite-ignore */ "/src/persistence/save-service.ts");
    const original = PersistenceService.prototype.saveRuntime; let fail = true;
    PersistenceService.prototype.saveRuntime = async function(save) {
      if (fail && save.activeProgram?.definition.nodes.find(node => node.id === save.activeProgram!.cursor)?.type === "choice") { fail = false; throw new Error("escape-write-failure"); }
      return original.call(this, save);
    };
  });
  await page.locator('[data-exit-encounter]').click();
  await expect(page.locator('[data-encounter-status]')).toContainText("escape-write-failure");
  await expect(page.locator('[data-exit-encounter]')).toBeEnabled();
  expect((await saved(page)).runtime!.activeMatch!.id).toBe(before.id);
  await page.locator('[data-exit-encounter]').click();
  await expect(page.locator('.challenge-grid')).toBeVisible();
  await challengeGuard(page, "llama");
  await expect(page.locator('.table-top h1')).toHaveText("Llama · 守卫战");
  expect((await saved(page)).runtime!.activeMatch!.id).not.toBe(before.id);
});

test("SS stays out of free invitations and a boss victory opens independent skill choices", async ({ page }, info) => {
  await mount(page, "lobby");
  await page.locator("[data-enter-duel]").click();
  for (let count = 0; count < 8; count++) {
    await expect(page.locator('[data-invite-character="claude"]')).toHaveCount(0);
    await page.locator("[data-refresh-guests]").click();
  }
  await mount(page, "boss-win");
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect(page.locator(".lobby-menu-shell")).toBeVisible();
  await page.locator("[data-enter-duel]").click();
  await expect(page.locator('.guest-section:not(.defeated-section) [data-character-id="claude"]')).toHaveCount(0);
  const card = page.locator('#defeated-character-list [data-character-id="claude"]');
  await expect(card.getByRole("button", { name: /单独挑战/ })).toBeVisible();
  await card.locator('[data-invite-character="claude"]').click();
  const toggles = page.locator("#profile [data-weaken-skill]");
  await expect(toggles).toHaveCount(4);
  await expect(page.locator("#profile")).not.toContainText(/Lv\.?[12]/i);
  for (let index = 0; index < 4; index++) await expect(toggles.nth(index)).not.toBeChecked();
  await page.locator("#profile .skill-sheet > summary").first().click();
  await toggles.nth(0).check();
  await expect(page.locator("#profile .skill-sheet-rules").first()).toBeVisible();
  await expect(page.locator("#profile .skill-sheet-rules").first()).toContainText("增加 1 点");
  await toggles.nth(2).check();
  await expect(toggles.nth(1)).not.toBeChecked();
  await expect(toggles.nth(3)).not.toBeChecked();
  await toggles.nth(0).uncheck();
  await expect(page.locator("#profile .skill-sheet-rules").first()).toContainText("⌊n/2⌋");
  await toggles.nth(0).check();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator("#profile").screenshot({ path: info.outputPath(`ss-rematch-${width}.png`) });
  }
  // Closing the profile discards the temporary choices and restores the full dossier.
  await page.locator("#profile [data-close]").click();
  await card.locator('[data-invite-character="claude"]').click();
  for (let index = 0; index < 4; index++) await expect(toggles.nth(index)).not.toBeChecked();
  await toggles.nth(0).check(); await toggles.nth(2).check();
  await page.locator("#profile [data-profile-start]").click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  const levels = (data: Awaited<ReturnType<typeof saved>>) => data.runtime?.activeMatch?.abilities.instances.filter(instance => instance.kind === "ai-skill").map(instance => instance.level);
  expect(levels(await saved(page))).toEqual([1, 2, 1, 2]);
  expect((await saved(page)).runtime?.activeMatch?.roulette.player.capacity).toBe(8);
  expect((await saved(page)).runtime?.activeMatch?.roulette.opponent.capacity).toBe(8);
  expect((await saved(page)).runtime?.activeProgram?.definition.legacyDefinition?.completionId).toBeUndefined();
  await page.locator(".character-intel-tab").click();
  await page.locator(".character-intel .skill-sheet > summary").first().click();
  await expect(page.locator(".character-intel .skill-sheet-rules").first()).toContainText("增加 1 点");
  await page.reload();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(page.locator(".table-bottom")).toBeVisible();
  expect(levels(await saved(page))).toEqual([1, 2, 1, 2]);
  expect((await saved(page)).runtime?.activeMatch?.roulette.player.capacity).toBe(8);
  expect((await saved(page)).runtime?.activeMatch?.roulette.opponent.capacity).toBe(8);
  await page.locator(".character-intel-tab").click();
  await page.locator(".character-intel .skill-sheet > summary").first().click();
  await expect(page.locator(".character-intel .skill-sheet-rules").first()).toContainText("增加 1 点");
});


test("a failed post-attach opening and failed rollback recover the durable guard table", async ({ page }) => {
  await mount(page, "selection");
  await page.evaluate(async () => {
    const { PersistenceService } = await import(/* @vite-ignore */ "/src/persistence/save-service.ts");
    const { DialogueSession } = await import(/* @vite-ignore */ "/src/dialogue/session.ts");
    const write = PersistenceService.prototype.saveRuntime, start = DialogueSession.prototype.start;
    let storageUnavailable = false, failPresentation = true;
    (window as any).__restoreRuntimeWrites = () => { storageUnavailable = false; };
    PersistenceService.prototype.saveRuntime = async function(snapshot) {
      if (storageUnavailable) throw new Error("rollback-write-failure");
      return write.call(this, snapshot);
    };
    DialogueSession.prototype.start = async function(...args) {
      if (failPresentation) { failPresentation = false; storageUnavailable = true; throw new Error("opening-presentation-failure"); }
      return start.apply(this, args);
    };
  });
  await challengeGuard(page, "llama");
  await expect(page.locator(".table-top h1")).toHaveText("Llama · 守卫战");
  const recovered = (await saved(page)).runtime!;
  expect(recovered.activeProgram!.status).toBe("match");
  expect(recovered.activeMatch!.status).toBe("active");
  expect(recovered.activeMatch!.scene).toBe("match");
  expect(recovered.activeProgram!.visits["guard:llama"]).toBe(1);
  await page.evaluate(() => (window as any).__restoreRuntimeWrites());
  await page.locator('[data-exit-encounter]').click();
  await expect(page.locator(".challenge-grid")).toBeVisible();
  expect((await saved(page)).runtime!.activeProgram!.resources!.player!.inventory.cards).toEqual(recovered.activeMatch!.playerSkills.cards);
});
