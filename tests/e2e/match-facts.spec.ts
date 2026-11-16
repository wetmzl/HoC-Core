import { expect, test } from "@playwright/test";

test("真实牌桌事实在保存失败后合并提交，观察者失败与恢复均不重放表现", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const { createDefaultSave, createRuntimeSave } = await load("/tests/e2e/runtime-fixture.ts");
    const { createMatch } = await load("/src/core/match/reducer.ts");
    const base = createMatch("browser-facts", { opponentId: "chatgpt", opponentAiSkills: [],
      skillDeckIds: ["critical-judgment"], unlockedPlayerSkillIds: ["critical-judgment"], openingSkillCards: 0, initialSkillDraws: 1 });
    const match = { ...base, round: { ...base.round, phase: "turns", currentActor: "player" } };
    const save = createDefaultSave();
    save.skipTutorial = true; save.settings.soundEnabled = false; save.settings.reducedMotion = true;
    save.tutorialProgress.completedIds.push("adult-content-warning");
    await repository.saveLongTerm(save); await repository.saveRuntime(createRuntimeSave(match));

    const probe = (window as any).__factProbe = { resolved: [] as any[], committed: [] as any[], audio: [] as string[], failedWrites: 0 };
    const { ProgramSession } = await load("/src/runtime/program-session.ts");
    const attach = ProgramSession.prototype.attach;
    const observed = new WeakSet<object>();
    ProgramSession.prototype.attach = function (...args: any[]) {
      if (!observed.has(this)) {
        observed.add(this);
        this.events.registerProjector((checkpoint: any, batch: any) => {
          if (!batch.facts.length) return checkpoint;
          const markers = batch.facts.map((fact: any) => `browser-fact:${fact.id}`);
          return { ...checkpoint, longTerm: { ...checkpoint.longTerm,
            completedFlows: [...new Set([...(checkpoint.longTerm.completedFlows ?? []), ...markers])] } };
        });
        this.events.subscribe("resolved", () => { throw new Error("expected-browser-observer-failure"); });
        this.events.subscribe("resolved", (batch: any) => { probe.resolved.push(batch); });
        this.events.subscribe("committed", (batch: any) => { probe.committed.push(batch); });
      }
      return attach.apply(this, args);
    };
    const { gameAudio } = await load("/src/audio/game-audio.ts");
    gameAudio.play = (cue: string) => { probe.audio.push(cue); };
    (window as any).__factRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({
      root: document.querySelector("#app"), onExitRequest: async () => {}
    });
    probe.committed.length = 0;
    const { PersistenceService } = await load("/src/persistence/save-service.ts");
    const commit = PersistenceService.prototype.commitMatchResult;
    PersistenceService.prototype.commitMatchResult = async function (...args: any[]) {
      if (probe.failedWrites === 0) { probe.failedWrites++; throw new Error("expected-browser-fact-save-failure"); }
      return commit.apply(this, args);
    };
  });
  await expect(page.locator(".table-bottom")).toBeVisible();
  await page.locator('[data-action*="OPEN_SKILL_DRAW"]').click();
  await expect(page.locator(".skill-draw-card")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).__factProbe.failedWrites)).toBe(1);
  const pending = await page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repository = createPersistenceService();
    return { save: await repository.loadLongTerm(), runtime: await repository.loadRuntime(),
      resolved: (window as any).__factProbe.resolved.length, committed: (window as any).__factProbe.committed.length };
  });
  expect(pending.resolved).toBe(1); expect(pending.committed).toBe(0);
  expect(pending.save!.completedFlows ?? []).toEqual([]);
  expect(pending.runtime!.activeMatch!.playerSkills.drawOffer).toBeNull();

  await page.locator(".skill-draw-card").click();
  await expect(page.locator(".skill-draw-modal")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__factProbe.committed.length)).toBe(1);
  const committed = await page.evaluate(async () => {
    const { createPersistenceService } = await import(/* @vite-ignore */ "/src/persistence/factory.ts");
    const repository = createPersistenceService(), probe = (window as any).__factProbe;
    return { save: await repository.loadLongTerm(), runtime: await repository.loadRuntime(), audio: probe.audio,
      resolved: probe.resolved.map((batch: any) => batch.facts.map((fact: any) => ({ id: fact.id, type: fact.type }))),
      committed: probe.committed[0].facts.map((fact: any) => ({ id: fact.id, type: fact.type })) };
  });
  expect(committed.resolved).toHaveLength(2);
  expect(committed.committed).toEqual(committed.resolved.flat());
  expect(committed.committed.map((fact: any) => fact.type)).toEqual(["SKILL_DRAW_OPENED", "SKILL_GAINED", "SKILL_DRAW_RESOLVED"]);
  expect(committed.save!.completedFlows).toEqual(committed.committed.map((fact: any) => `browser-fact:${fact.id}`));
  expect(committed.runtime!.activeMatch!.playerSkills.cards).toHaveLength(1);
  expect(committed.runtime!.activeMatch!.playerSkills.drawOffer).toBeNull();
  expect(committed.audio).toEqual(["skillDraw", "skillAcquire"]);

  const restored = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const repository = (await load("/src/persistence/factory.ts")).createPersistenceService();
    const snapshot = await repository.loadRuntime(), probe = (window as any).__factProbe;
    await (window as any).__factRuntime.dispose();
    await repository.saveRuntime(snapshot);
    probe.resolved.length = 0; probe.committed.length = 0; probe.audio.length = 0;
    (window as any).__factRuntime = await (await load("/src/match-screen.ts")).mountGameRuntime({
      root: document.querySelector("#app"), onExitRequest: async () => {}
    });
    return { save: await repository.loadLongTerm(), resolved: probe.resolved.length, audio: probe.audio,
      committed: probe.committed.map((batch: any) => ({ restored: batch.restored, facts: batch.facts, events: batch.events })) };
  });
  expect(restored.save!.completedFlows).toEqual(committed.save!.completedFlows);
  expect(restored.resolved).toBe(0); expect(restored.audio).toEqual([]);
  expect(restored.committed.length).toBeGreaterThan(0);
  expect(restored.committed.every((batch: any) => batch.restored && batch.facts.length === 0 && batch.events.length === 0)).toBe(true);
  expect(pageErrors).toEqual([]);
});
