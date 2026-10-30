import { afterEach, describe, expect, it } from "vitest";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, installCharacterCatalog } from "../content/characters";
import { DEFAULT_AI_PROFILE } from "../core/ai/types";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createProgramRun, programMatchId, programMatchInit } from "../core/flow/program-engine";
import { ProgramDefinitionSchema } from "../core/flow/program";
import { resolveMatchInit } from "../core/flow/initialization";
import { clearMatchHistory, createDefaultSave } from "../persistence/boot";
import { exportSaveJson, importSave } from "../persistence/json";
import { MemorySaveRepository } from "../persistence/memory-repository";
import { PersistenceService } from "../persistence/save-service";
import { CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT } from "../persistence/schema";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import { ProgramSession, programSnapshot } from "./program-session";

const builtinCatalog = CHARACTER_CATALOG, builtinDefaultCharacter = DEFAULT_CHARACTER_ID;
afterEach(() => installCharacterCatalog(builtinCatalog, builtinDefaultCharacter));

function definition() {
  return ProgramDefinitionSchema.parse({ version: 2, id: "session-program", start: "init", defaults: {
    skillPool: { source: "fixed", ids: [] }, playerSkills: { mode: "inherit", openingCards: 0 }
  }, nodes: [
    { id: "init", type: "initialize", resources: { gun: { capacity: 8, bullets: 2 }, comparisonBonus: 3 }, next: "select" },
    { id: "select", type: "choice", options: [{ id: "guard", to: "guard" }, { id: "finish", to: "end" }] },
    { id: "guard", type: "match", opponentId: "llama", routes: { victory: "settle", defeat: "select", escaped: "select" } },
    { id: "settle", type: "settlement", source: "guard", rewards: [
      { id: "draws", label: "抽数", effects: [{ id: "grant", type: "resource", resource: "skillDraws", operation: "add", value: 2 }] },
      { id: "advantage", label: "优势", effects: [{ id: "grant", type: "resource", resource: "comparisonBonus", operation: "add", value: 1 }] }
    ], effects: [{ id: "record", type: "record-result", source: "guard" }], next: "select" },
    { id: "end", type: "end", result: "victory", effects: [{ id: "completed", type: "complete-flow" }] }
  ] });
}
function harness(telemetry?: import("../telemetry/types").EncounterTelemetry) {
  let save = createDefaultSave();
  const repository = new MemorySaveRepository({ longTerm: save });
  const saves = { get: () => save, set: (next: typeof save) => { save = next; } };
  return { repository, saves, session: new ProgramSession(repository, saves, telemetry) };
}
async function openGuard(session: ProgramSession) {
  await session.choose("guard", session.run!);
  const run = session.run!;
  if (session.node?.type !== "match" || !run.resources) throw new Error("expected a ready match");
  const plan = resolveMatchInit({ id: programMatchId(run), seed: `${run.seed}:${run.visitIndex}`, opponentId: session.node.opponentId,
    defaults: run.definition.defaults, init: programMatchInit(run), resources: run.resources,
    context: { profile: { unlockedPlayerSkillIds: [], skillDeckIds: [], talentIds: [] }, character: { ai: DEFAULT_AI_PROFILE, aiSkills: [] } } });
  const match = createMatch(plan.seed, plan.options);
  const handle = await session.attach(run, match);
  return { match, handle };
}
async function winGuard(session: ProgramSession) {
  const { match } = await openGuard(session);
  const pending = { ...match, roulette: { ...match.roulette, opponent: { ...match.roulette.opponent, bullets: match.roulette.opponent.capacity } },
    round: { ...match.round, phase: "roulette-trigger" as const, currentActor: null, outcome: {
      winner: "player" as const, reason: "comparison" as const, penaltyTarget: "opponent" as const, bulletsAdded: 1
    } } };
  const won = gameReducer(gameReducer(pending, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
  await session.replace(programSnapshot(session.run!, won));
  return won;
}

describe("declarative program transactions", () => {
  it("reports encounter order independently of initialization and choice visits, including restoration", async () => {
    const observations: { matchId: string; index: number; restored: boolean }[] = [];
    const telemetry: import("../telemetry/types").EncounterTelemetry = { observe: async (match, run, observation) => {
      observations.push({ matchId: match.id, index: run.encounterIndex, restored: observation?.restored ?? false });
    } };
    const { session, repository, saves } = harness(telemetry);
    await session.begin(createProgramRun("telemetry-run", "seed", definition()));
    const first = await openGuard(session);
    expect(session.run!.visitIndex).toBeGreaterThan(1);
    await session.completeMatch(true);
    const second = await openGuard(session);
    expect(session.run!.visitIndex).toBeGreaterThan(2);
    const restored = new ProgramSession(repository, saves, telemetry);
    restored.restore((await repository.loadRuntime())!);
    await restored.flush();
    expect(observations.filter(item => item.matchId === first.match.id).map(item => item.index)).toEqual([1, 1]);
    expect(observations.filter(item => item.matchId === second.match.id)).toEqual([
      { matchId: second.match.id, index: 2, restored: false },
      { matchId: second.match.id, index: 2, restored: true }
    ]);
  });

  it("rolls back failed result transitions, restores settlement and commits history together with its next node", async () => {
    const { session, repository, saves } = harness();
    await session.begin(createProgramRun("run", "seed", definition()));
    const won = await winGuard(session);
    const before = session.snapshot!;
    const commit = repository.commitMatchResult.bind(repository);
    repository.commitMatchResult = async () => { throw new Error("disk full"); };
    await expect(session.completeMatch()).rejects.toThrow("disk full");
    expect(session.snapshot).toBe(before);
    expect(await repository.loadRuntime()).toEqual(before);
    expect(session.match?.scene).not.toBe("lobby");
    expect(saves.get().characterDefeatProgress).toBeUndefined();
    expect(session.durableEffectsRevision).toBe(0);
    repository.commitMatchResult = commit;
    await session.completeMatch();
    expect(session.match).toBeNull();
    expect(session.node?.type).toBe("settlement");
    expect(saves.get().characterDefeatProgress).toEqual({ counts: { llama: 1 }, matchIds: [won.id] });
    expect(saves.get().matchResultReceipts).toEqual([]);
    expect(saves.get().history).toEqual([]);
    expect(session.durableEffectsRevision).toBe(1);
    await session.claim("draws");
    await session.claim("advantage");
    const ready = session.snapshot!;
    repository.commitMatchResult = async () => { throw new Error("commit unavailable"); };
    await expect(session.confirm()).rejects.toThrow("commit unavailable");
    expect(session.snapshot).toBe(ready);
    expect(saves.get().history).toEqual([]);
    expect((await repository.loadRuntime())!.activeProgram!.cursor).toBe("settle");
    repository.commitMatchResult = commit;
    const restored = new ProgramSession(repository, saves);
    restored.restore((await repository.loadRuntime())!);
    await restored.confirm();
    expect(saves.get().history).toHaveLength(1);
    expect(saves.get().profile).toMatchObject({ matchesPlayed: 1, wins: 1 });
    expect(saves.get().characterDefeatProgress?.counts.llama).toBe(1);
    expect(saves.get().matchResultReceipts).toEqual([won.id]);
    expect(restored.run!.cursor).toBe("select");
    expect(restored.run!.resources!.player!.inventory.drawCount).toBe(2);
    expect(restored.run!.resources!.comparisonBonus).toBe(4);
    expect((await repository.loadRuntime())!.activeProgram!.pendingWrites).toEqual([]);
    expect(repository.runtimeWrites.every(snapshot => !snapshot.activeMatch || snapshot.activeMatch.scene !== "lobby")).toBe(true);
    saves.set(await importSave(exportSaveJson(clearMatchHistory(saves.get()))));
    await repository.saveLongTerm(saves.get());
    // Replaying even an older settlement cannot recreate cleared history or totals.
    restored.restore(ready);
    await restored.confirm();
    expect(saves.get().history).toEqual([]);
    expect(saves.get().profile).toMatchObject({ matchesPlayed: 1, wins: 1 });
    expect(saves.get().characterDefeatProgress?.counts.llama).toBe(1);
    await restored.choose("finish", restored.run!);
    expect(saves.get().completedFlows).toEqual(["session-program"]);
    expect(await repository.loadRuntime()).toBeNull();
  });

  it("grants victory and flow skins even when the program never records local history", async () => {
    const key = "neutral/progress#match";
    installCharacterCatalog([{ id: "llama", name: "中性角色", subtitle: "进度测试", tier: "D", tags: [], previewImage: "original.png", portraitScales: { selection: 1, table: 1 },
      appearance: { key, skinId: "initial", skins: [
        { id: "initial", name: "初始" }, { id: "blue", name: "蓝色", unlock: { type: "defeat-character", count: 1 } },
        { id: "green", name: "绿色", unlock: { type: "completed-challenge", challengeId: "trial" } }
      ] } }], "llama");
    const program = definition();
    program.nodes = program.nodes.map(node => node.id === "settle" ? { ...node, rewards: [], effects: [], next: "end" }
      : node.id === "end" ? { ...node, effects: [{ id: "completed", type: "complete-flow", legacyChallengeId: "trial" }] } : node);
    const { session, repository, saves } = harness();
    await session.begin(createProgramRun("no-history", "seed", program));
    const won = await winGuard(session);
    await session.completeMatch();
    expect((await repository.loadLongTerm())?.characterDefeatProgress).toEqual({ counts: { llama: 1 }, matchIds: [won.id] });
    expect(saves.get().characterSkinUnlocks?.[key]).toEqual({ blue: true });
    expect(saves.get().history).toEqual([]);
    expect(saves.get().profile).toMatchObject({ matchesPlayed: 0, wins: 0 });
    expect(session.durableEffectsRevision).toBe(1);
    const restored = new ProgramSession(repository, saves);
    restored.restore((await repository.loadRuntime())!);
    await restored.confirm();
    expect(saves.get().characterSkinUnlocks?.[key]).toEqual({ blue: true, green: true });
    expect(saves.get().history).toEqual([]);
    expect(saves.get().characterDefeatProgress?.counts.llama).toBe(1);
    expect(saves.get().completedFlows).toEqual(["session-program"]);
    expect(saves.get().completedChallenges).toEqual(["trial"]);
    expect(await repository.loadRuntime()).toBeNull();
  });

  it("publishes no failed reward, serializes double clicks once and retains receipts after restoration", async () => {
    const { session, repository, saves } = harness();
    await session.begin(createProgramRun("run", "seed", definition()));
    await winGuard(session);
    await session.completeMatch();
    await expect(session.confirm()).rejects.toThrow("请先领取");
    const before = session.snapshot!;
    const write = repository.saveRuntime.bind(repository);
    repository.saveRuntime = async () => { throw new Error("reward unavailable"); };
    await expect(session.claim("draws")).rejects.toThrow("reward unavailable");
    expect(session.snapshot).toBe(before);
    expect(session.run!.resources!.player!.inventory.drawCount).toBe(0);
    repository.saveRuntime = write;
    await Promise.all([session.claim("draws"), session.claim("draws")]);
    expect(session.run!.resources!.player!.inventory.drawCount).toBe(2);
    const restored = new ProgramSession(repository, saves);
    restored.restore((await repository.loadRuntime())!);
    await restored.claim("draws");
    expect(restored.run!.resources!.player!.inventory.drawCount).toBe(2);
    await restored.claim("advantage");
    await restored.confirm();
    const { match } = await openGuard(restored);
    expect(match.playerSkills.drawCount).toBe(2);
    expect(match.comparisonBonuses?.player).toBe(4);
    expect(match.playerSkills.cards).toEqual([]);
  });

  it("keeps failed escape playable and returns actual resources without granting new opening cards", async () => {
    const { session, repository } = harness();
    await session.begin(createProgramRun("run", "seed", definition()));
    const { match, handle } = await openGuard(session);
    expect(handle.dispatch({ type: "ACK_MATCH_RESULT" })).toBe(match);
    const write = repository.saveRuntime.bind(repository);
    repository.saveRuntime = async () => { throw new Error("escape unavailable"); };
    await expect(session.completeMatch(true)).rejects.toThrow("escape unavailable");
    expect(handle.getState()).toBe(match);
    expect(handle.getState().status).toBe("active");
    repository.saveRuntime = write;
    await session.completeMatch(true);
    expect(() => handle.getState()).toThrow("牌局已结束");
    expect(session.run!.resources!.gun).toEqual(match.roulette.player);
    expect(session.run!.resources!.player!.inventory.cards).toEqual(match.playerSkills.cards);
    expect(session.run!.resources!.player!.lootRng).toEqual(match.rng.loot);
    expect(session.run!.completed).not.toContain("guard");
    const again = await openGuard(session);
    expect(again.match.id).not.toBe(match.id);
    expect(again.match.playerSkills.cards).toEqual([]);
    expect(again.match.playerSkills.drawCount).toBe(0);
    expect(again.match.roulette.player).toEqual({ capacity: 8, bullets: 2 });
    expect(repository.commits).toEqual([]);
  });

  it("drops only an older active run and never publishes cleanup after a failed durable write", async () => {
    const save = { ...createDefaultSave(), completedFlows: ["previous-completion"] };
    let raw: RawSaveSnapshot = { longTerm: save, runtime: { format: RUNTIME_SAVE_FORMAT, schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION - 1, marker: "legacy-run" } };
    const before = structuredClone(raw);
    let fail = true;
    const repository = new PersistenceService({ readSnapshot: async () => structuredClone(raw), writeSnapshot: async next => {
      if (fail) throw new Error("cleanup unavailable");
      raw = structuredClone(next);
    } });
    await expect(repository.loadRuntime()).rejects.toThrow("cleanup unavailable");
    expect(raw).toEqual(before);
    fail = false;
    expect(await repository.loadRuntime()).toBeNull();
    expect(raw).toEqual({ longTerm: save, runtime: null });
    expect(await repository.loadLongTerm()).toEqual(save);
  });
});
