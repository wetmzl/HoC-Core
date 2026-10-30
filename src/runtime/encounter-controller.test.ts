import { describe, expect, it, vi } from "vitest";
import trial from "../core/challenge/fixtures/legacy-challenge.json";
import { loadCharacter } from "../content/characters";
import { standaloneFlowDefinition } from "../content/encounters";
import { challengeFlow } from "../core/challenge/flow";
import { ChallengeDefinitionSchema } from "../core/challenge/schema";
import { createMatch, gameReducer, type CreateMatchOptions } from "../core/match/reducer";
import { createProgramRun, chooseProgram, programMatchId } from "../core/flow/program-engine";
import { compileLegacyFlow } from "../core/flow/program-templates";
import { ProgramDefinitionSchema, type ProgramRun } from "../core/flow/program";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveRepository } from "../persistence/memory-repository";
import { EncounterController, type EncounterControllerDependencies } from "./encounter-controller";
import { programSnapshot } from "./program-session";
import type { EncounterPlan, MatchOwner } from "./match-owner";
import type { MatchState } from "../core/match/types";
import { projectSummaryView, type SummarySettlement } from "../screens/summary-view";
import type { RuntimeScreenLoader } from "./contracts";

vi.mock("../audio/game-audio", () => ({ gameAudio: { stopHeartbeat: vi.fn(), setBgmScene: vi.fn() } }));

const defaults = async (): Promise<CreateMatchOptions> => ({ unlockedPlayerSkillIds: [], skillDeckIds: [], talentIds: [], intrinsicAbilities: [] });
const root = () => ({ querySelectorAll: () => [], querySelector: () => null });
const stateRun = (controller: EncounterController): ProgramRun => Reflect.get(controller, "state").run;
const choose = (controller: EncounterController, optionId: string) =>
  (Reflect.get(controller, "choose") as (run: ProgramRun, id: string) => Promise<void>)(stateRun(controller), optionId);
function challengeSelection(seed: string) {
  const definition = ChallengeDefinitionSchema.parse(trial);
  return programSnapshot(createProgramRun(`run-${seed}`, seed, compileLegacyFlow(challengeFlow(definition))));
}

describe("challenge controller recovery", () => {
  it("defers the repository dependency until runtime mounting has initialized it", async () => {
    const selection = challengeSelection("lazy");
    let repository: MemorySaveRepository | undefined;
    const controller = new EncounterController({
      root: root(), invalidateProfile() {}, save: createDefaultSave(), get repository() { return repository; }, navigateScreen: async () => {},
      session: { getMatchDefaults: defaults, startEncounter: async (plan: EncounterPlan, owner: MatchOwner) => {
        expect(plan.match).toBeDefined();
        await owner.attach(plan.match!);
        return true;
      } }
    } as unknown as EncounterControllerDependencies);
    repository = new MemorySaveRepository();
    await controller.restore(selection);
    await choose(controller, "guard:llama");
    expect((await repository.loadRuntime())!.activeMatch!.opponentId).toBe("llama");
    await controller.dispose();
  });
  it("reattaches the durable table when opening fails after attach and the selection rollback also fails", async () => {
    const selection = challengeSelection("rollback"), repository = new MemorySaveRepository({ runtime: selection });
    const resume = vi.fn(async () => {}), clear = vi.fn();
    const controller = new EncounterController({
      root: root(), invalidateProfile() {}, save: createDefaultSave(), repository, navigateScreen: async () => {},
      session: { getMatchDefaults: defaults, resumeMatch: resume, clearActiveMatch: clear, startEncounter: async (plan: EncounterPlan, owner: MatchOwner) => {
        await owner.attach(plan.match!);
        throw new Error("screen failed after attachment");
      } }
    } as unknown as EncounterControllerDependencies);
    await controller.restore(selection);
    const write = repository.saveRuntime.bind(repository);
    repository.saveRuntime = async snapshot => { if (!snapshot.activeMatch && snapshot.activeProgram?.cursor === selection.activeProgram!.cursor) throw new Error("rollback write failed"); await write(snapshot); };
    await expect(choose(controller, "guard:llama")).rejects.toThrow("rollback write failed");
    const durable = (await repository.loadRuntime())!;
    expect(durable.activeProgram!.status).toBe("match");
    expect(durable.activeMatch!.status).toBe("active");
    expect(clear).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledExactlyOnceWith(durable.activeMatch, expect.any(Object));
    await controller.dispose();
  });

  it("rolls back a failed opening after an unrelated profile write without reverting that progress", async () => {
    const selection = challengeSelection("profile-write"), save = createDefaultSave();
    const repository = new MemorySaveRepository({ longTerm: save, runtime: selection });
    const deps = {
      root: root(), invalidateProfile() {}, save, repository, navigateScreen: async () => {},
      session: { clearActiveMatch: vi.fn(), startEncounter: async () => { throw new Error("opening unavailable"); },
        getMatchDefaults: async () => {
          deps.save = { ...deps.save, settings: { ...deps.save.settings, soundEnabled: false } };
          await repository.saveLongTerm(deps.save);
          return defaults();
        } }
    };
    const controller = new EncounterController(deps as unknown as EncounterControllerDependencies);
    await controller.restore(selection);
    await expect(choose(controller, "guard:llama")).rejects.toThrow("opening unavailable");
    expect((await repository.loadRuntime())!.activeProgram!.cursor).toBe(selection.activeProgram!.cursor);
    expect((await repository.loadRuntime())!.activeMatch).toBeNull();
    expect((await repository.loadLongTerm())!.settings.soundEnabled).toBe(false);
    expect(deps.save.settings.soundEnabled).toBe(false);
    await controller.dispose();
  });
});

/** A small screen host for testing real controller bindings; browser layout has separate E2E coverage. */
function screenRoot() {
  type Button = { attrs: string; disabled: boolean; isConnected: boolean; dataset: Record<string, string>; onclick?: () => void };
  let html = "", buttons: Button[] = [];
  const status = { textContent: "" }, main = { style: { backgroundImage: "" } };
  const matches = (button: Button, selector: string) => selector === "button" || button.attrs.includes(selector.slice(1, -1));
  return {
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      buttons.forEach(button => { button.isConnected = false; }); html = value;
      buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(match => ({ attrs: match[1], disabled: /\bdisabled\b/.test(match[1]), isConnected: true,
        dataset: Object.fromEntries([...match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1].replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()), attribute[2]])) }));
    },
    querySelectorAll(selector: string) { return buttons.filter(button => matches(button, selector)); },
    querySelector(selector: string) {
      if (selector === ".challenge-selection") return main;
      if (selector.includes("data-encounter-status")) return status;
      return buttons.find(button => matches(button, selector)) ?? null;
    },
    click(selector: string) {
      const button = buttons.find(item => matches(item, selector));
      if (!button?.onclick || button.disabled) throw new Error(`button unavailable: ${selector}`);
      button.onclick();
    }
  };
}
async function mountedController(repository: MemorySaveRepository) {
  const element = screenRoot(), save = (await repository.loadLongTerm()) ?? createDefaultSave();
  const renderSummary = vi.fn<(match: MatchState, settlement: SummarySettlement) => void>();
  const startEncounter = vi.fn(async (plan: EncounterPlan, owner: MatchOwner) => { await owner.attach(plan.match!); return true; });
  const controller = new EncounterController({ root: element, save, repository,
    invalidateProfile() {}, renderLobby: vi.fn(async () => {}), showHistory: vi.fn(async () => {}), renderSummary,
    navigateScreen: async (loader: RuntimeScreenLoader) => {
      await (await loader()).mount({ root: element as unknown as HTMLDivElement, getSave: () => save, navigate: async () => {}, reportNavigationError() {} }, new AbortController().signal);
    },
    session: { getMatchDefaults: defaults, startEncounter, clearActiveMatch() {},
      resumeMatch: async (match: MatchState, owner: MatchOwner) => { await owner.attach(match); if (match.status === "finished") owner.summary(match); } }
  } as unknown as EncounterControllerDependencies);
  return { controller, element, renderSummary, startEncounter };
}

it("restores custom presentation, choice and settlement nodes while distinct matches against one opponent share initialization", async () => {
  const definition = ProgramDefinitionSchema.parse({ version: 2, id: "custom-sequence", start: "story",
    defaults: { preset: "empty", playerSkills: { mode: "inherit", openingCards: 0 }, opponentAbilities: [] }, nodes: [
      { id: "story", type: "presentation", title: "开场", body: "确认后选择牌局", next: "selection" },
      { id: "selection", type: "choice", options: [{ id: "first", label: "开始第一场", to: "first" }] },
      { id: "first", type: "match", opponentId: "llama", init: { playerGun: { mode: "replace", value: { capacity: 3, bullets: 1 } } }, routes: { victory: "settlement", defeat: "end", escaped: "end" } },
      { id: "settlement", type: "settlement", source: "first", rewards: [{ id: "bonus", label: "下一场点数优势", effects: [
        { id: "grant", type: "resource", resource: "comparisonBonus", operation: "add", value: 2 }
      ] }], next: "second" },
      { id: "second", type: "match", opponentId: "llama", init: { opponentGun: { mode: "replace", value: { capacity: 5, bullets: 1 } } }, routes: { victory: "end", defeat: "end", escaped: "end" } },
      { id: "end", type: "end", result: "victory" }
    ] });
  const repository = new MemorySaveRepository({ longTerm: createDefaultSave() });
  let h = await mountedController(repository);
  await h.controller.startFlow(definition);
  expect(h.element.innerHTML).toContain("确认后选择牌局");
  expect(h.startEncounter).not.toHaveBeenCalled();
  await h.controller.dispose();
  h = await mountedController(repository);
  await h.controller.restore((await repository.loadRuntime())!);
  expect(h.element.innerHTML).toContain("确认后选择牌局");
  h.element.click("[data-program-confirm]"); await h.controller.flush();
  expect(h.element.innerHTML).toContain("开始第一场");
  await h.controller.dispose();
  h = await mountedController(repository);
  await h.controller.restore((await repository.loadRuntime())!);
  expect(h.element.innerHTML).toContain("开始第一场");
  h.element.click("[data-flow-node]"); await h.controller.flush();
  expect(h.startEncounter).toHaveBeenCalledOnce();
  const activeSnapshot = (await repository.loadRuntime())!, active = activeSnapshot.activeMatch!;
  expect(active.roulette.player).toEqual({ capacity: 3, bullets: 1 });
  const pending: MatchState = { ...active, roulette: { ...active.roulette, opponent: { ...active.roulette.opponent, bullets: active.roulette.opponent.capacity } },
    round: { ...active.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } } };
  const won = gameReducer(gameReducer(pending, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
  await repository.saveRuntime(programSnapshot(activeSnapshot.activeProgram!, won));
  await h.controller.dispose();
  h = await mountedController(repository);
  await h.controller.restore((await repository.loadRuntime())!);
  await vi.waitFor(() => expect(h.renderSummary).toHaveBeenCalledOnce());
  await h.controller.flush();
  expect(h.renderSummary.mock.calls[0][1].rewards).toEqual([{ id: "bonus", label: "下一场点数优势", claimed: false, amount: "+2", icon: "pointAdvantage", detail: "本次流程" }]);
  await h.controller.claimReward("bonus");
  await h.controller.dispose();
  h = await mountedController(repository);
  await h.controller.restore((await repository.loadRuntime())!);
  expect(h.renderSummary.mock.calls[0][1].rewards?.[0].claimed).toBe(true);
  expect(h.startEncounter).not.toHaveBeenCalled();
  await h.controller.claimReward("bonus");
  await h.controller.completeMatch("continue");
  const second = (await repository.loadRuntime())!.activeMatch!;
  expect(second.opponentId).toBe(active.opponentId);
  expect(second.id).not.toBe(active.id);
  expect(second.comparisonBonuses?.player).toBe(2);
  expect(second.roulette).toEqual({ player: { capacity: 3, bullets: 1 }, opponent: { capacity: 5, bullets: 1 } });
  expect((await repository.loadRuntime())!.activeProgram!.cursor).toBe("second");
  expect((await repository.loadLongTerm())!.history).toEqual([]);
  await h.controller.dispose();
});

async function ordinarySummary(winner: "player" | "opponent", resultActions?: "return") {
  const character = await loadCharacter("llama"), save = createDefaultSave();
  const source = standaloneFlowDefinition(character, save);
  const definition = resultActions ? { ...source, presentation: { ...source.presentation!, resultActions } } : source;
  const fresh = createProgramRun("ordinary-active-program", "ordinary-summary", compileLegacyFlow(definition));
  const run = chooseProgram(fresh, "match");
  const active = createMatch(run.seed, { id: programMatchId(run), opponentId: "llama", opponentAiSkills: [] });
  const actor = winner === "player" ? "opponent" : "player";
  const ready: MatchState = { ...active,
    roulette: { ...active.roulette, [actor]: { ...active.roulette[actor], bullets: active.roulette[actor].capacity } },
    round: { ...active.round, phase: "roulette-trigger", currentActor: null,
      outcome: { winner, reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } }
  };
  const match = gameReducer(gameReducer(ready, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
  const snapshot = programSnapshot({ ...run, resources: null }, match), repository = new MemorySaveRepository({ longTerm: save, runtime: snapshot });
  const showHistory = vi.fn(async () => {}), renderLobby = vi.fn(async () => {});
  const renderSummary = vi.fn<(match: MatchState, settlement: SummarySettlement) => void>();
  const startEncounter = vi.fn(async (next: EncounterPlan, owner: MatchOwner) => {
    expect(next.match).toBeDefined();
    await owner.attach(next.match!);
    return true;
  });
  const controller = new EncounterController({
    root: { querySelectorAll: () => [], querySelector: () => null },
    save, repository, invalidateProfile() {}, navigateScreen: async () => {}, showHistory, renderLobby, renderSummary,
    session: { getMatchDefaults: defaults, clearActiveMatch: vi.fn(), startEncounter, resumeMatch: async (restored: MatchState, owner: MatchOwner) => {
      await owner.attach(restored); owner.summary(restored);
    } }
  } as unknown as EncounterControllerDependencies);
  await controller.restore(snapshot);
  await vi.waitFor(() => expect(renderSummary).toHaveBeenCalledOnce());
  await controller.flush();
  const settlement = renderSummary.mock.calls.at(-1)![1];
  const view = projectSummaryView({ state: match, character, save, settlement });
  return { controller, repository, definition, match, settlement, view, showHistory, renderLobby, startEncounter };
}

describe("ordinary program result navigation", () => {
  it("keeps the victory history action and opens history only after the result is durable", async () => {
    const h = await ordinarySummary("player");
    expect(h.settlement.recordResult).toBe(true);
    expect(h.view.html).toContain('data-summary-action="history"');
    expect(h.view.html).toContain('data-summary-action="lobby"');
    expect((await h.repository.loadLongTerm())!.history).toEqual([]);
    await h.controller.completeMatch("history");
    expect(h.showHistory).toHaveBeenCalledOnce(); expect(h.renderLobby).not.toHaveBeenCalled();
    expect(await h.repository.loadRuntime()).toBeNull();
    expect((await h.repository.loadLongTerm())!.history.map(record => record.id)).toEqual([h.match.id]);
    expect(h.repository.commits).toHaveLength(2);
    await h.controller.dispose();
  });

  it("keeps the defeat rewind action and starts a new ordinary flow after recording the loss", async () => {
    const h = await ordinarySummary("opponent");
    expect(h.view.html).toContain('data-summary-action="rewind"');
    expect(h.view.html).toContain('data-summary-action="lobby"');
    await h.controller.completeMatch("rewind");
    expect(h.startEncounter).toHaveBeenCalledOnce(); expect(h.showHistory).not.toHaveBeenCalled();
    const restarted = (await h.repository.loadRuntime())!;
    expect(restarted.activeProgram).toBeDefined(); expect(restarted.activeMatch!.status).toBe("active");
    expect(restarted.activeMatch!.opponentId).toBe(h.match.opponentId);
    expect(restarted.activeMatch!.id).not.toBe(h.match.id);
    expect((await h.repository.loadLongTerm())!.history.map(record => record.id)).toEqual([h.match.id]);
    expect((await h.repository.loadLongTerm())!.profile).toMatchObject({ matchesPlayed: 1, wins: 0 });
    expect(h.repository.commits).toHaveLength(1);
    await h.controller.dispose();
  });

  it("returns to the lobby when saving the replacement flow fails after the loss was committed", async () => {
    const h = await ordinarySummary("opponent");
    h.repository.saveRuntime = async () => { throw new Error("replacement flow unavailable"); };
    await expect(h.controller.completeMatch("rewind")).rejects.toThrow("replacement flow unavailable");
    expect(h.renderLobby).toHaveBeenCalledOnce();
    expect(await h.repository.loadRuntime()).toBeNull();
    expect((await h.repository.loadLongTerm())!.history.map(record => record.id)).toEqual([h.match.id]);
    expect(h.repository.commits).toHaveLength(1);
    await h.controller.dispose();
  });

  it.each(["player", "opponent"] as const)("uses only lobby when the definition explicitly requests return actions after %s outcome", async winner => {
    const h = await ordinarySummary(winner, "return");
    expect(h.settlement.actions).toEqual([{ destination: "lobby", label: "返回大厅", primary: true }]);
    expect(h.view.html).not.toContain('data-summary-action="history"');
    expect(h.view.html).not.toContain('data-summary-action="rewind"');
    await h.controller.completeMatch("lobby");
    expect(h.renderLobby).toHaveBeenCalledOnce(); expect(h.startEncounter).not.toHaveBeenCalled();
    expect(await h.repository.loadRuntime()).toBeNull();
    await h.controller.dispose();
  });

  it("rejects an unavailable initial node without replacing the current runtime", async () => {
    const h = await ordinarySummary("player"), before = await h.repository.loadRuntime(), writes = h.repository.runtimeWrites.length;
    await expect(h.controller.startFlow(h.definition, "missing-node")).rejects.toThrow();
    expect(await h.repository.loadRuntime()).toEqual(before);
    expect(h.repository.runtimeWrites).toHaveLength(writes);
    expect(h.startEncounter).not.toHaveBeenCalled();
    await h.controller.dispose();
  });

  it("rejects a flow with no initially available node before changing the current runtime", async () => {
    const h = await ordinarySummary("player"), before = await h.repository.loadRuntime(), node = h.definition.nodes[0], writes = h.repository.runtimeWrites.length;
    const blocked = { ...h.definition, nodes: [
      { ...node, id: "first", requires: ["second"] },
      { ...node, id: "second", requires: ["first"] }
    ] };
    await expect(h.controller.startFlow(blocked)).rejects.toThrow();
    expect(await h.repository.loadRuntime()).toEqual(before);
    expect(h.repository.runtimeWrites).toHaveLength(writes);
    expect(h.startEncounter).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
});
