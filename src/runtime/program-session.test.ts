import { afterEach, describe, expect, it, vi } from "vitest";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, installCharacterCatalog } from "../content/characters";
import { DEFAULT_AI_PROFILE } from "../core/ai/types";
import { createMatch, gameReducer } from "../core/match/reducer";
import { createProgramRun, programMatchId, programMatchInit, chooseProgram } from "../core/flow/program-engine";
import { ProgramDefinitionSchema } from "../core/flow/program";
import { resolveMatchInit } from "../core/flow/initialization";
import { clearMatchHistory, createDefaultSave } from "../persistence/boot";
import { exportSaveJson, importSave } from "../persistence/json";
import { MemorySaveRepository } from "../persistence/memory-repository";
import { PersistenceService } from "../persistence/save-service";
import { CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT } from "../persistence/schema";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import { ProgramSession, programSnapshot } from "./program-session";
import { createMatchFactBatch, type MatchFactBatch } from "../core/events";
import { matchPublicEventBatch, type PublicEventBatch } from "../core/events/public-events";
import { RuntimeEventHub } from "./public-event-hub";

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
function harness(telemetry?: import("../telemetry/types").EncounterTelemetry, isDebugEnabled?: () => boolean, events?: RuntimeEventHub) {
  let save = createDefaultSave();
  const repository = new MemorySaveRepository({ longTerm: save });
  const saves = { get: () => save, set: (next: typeof save) => { save = next; } };
  return { repository, saves, session: new ProgramSession(repository, saves, telemetry, isDebugEnabled, events, { game: "test-game" }) };
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
  it.each([false, true])("reports the live runtime debug flag %s through attachment and withdrawal", async enabled => {
    const observations: boolean[] = [];
    let debugEnabled = enabled;
    const { session, saves } = harness({ observe: async (_match, _run, observation) => { observations.push(observation?.debugUsed ?? false); } }, () => debugEnabled);
    const save = saves.get();
    save.settings.debugEngineEnabled = !enabled;
    save.settings.pluginSettings = { "hoc-core/debug-engine": { version: 1, values: { enabled: !enabled } } };
    await session.begin(createProgramRun("debug-telemetry", "seed", definition()));
    await openGuard(session);
    debugEnabled = !enabled;
    await session.completeMatch(true);
    expect(observations).toEqual([enabled, !enabled]);
  });

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

describe("program fact checkpoint boundaries", () => {
  const recordFacts = (save: ReturnType<typeof createDefaultSave>, batch: MatchFactBatch) => ({
    ...save,
    tutorialProgress: { completedIds: [...save.tutorialProgress.completedIds, ...batch.facts.map(fact => fact.id)] }
  });

  it("projects initial facts atomically and never replays them when restoring a table", async () => {
    const { session, repository, saves } = harness();
    const observed: MatchFactBatch[] = [];
    session.events.registerProjector((checkpoint, batch) => ({ ...checkpoint, longTerm: recordFacts(checkpoint.longTerm, batch) }));
    session.events.subscribe("committed", batch => { observed.push(batch); });
    await session.begin(createProgramRun("facts-init", "seed", definition()));
    const { match } = await openGuard(session);
    expect(observed).toHaveLength(1);
    expect(observed[0].facts.map(fact => fact.event)).toEqual(match.history);
    expect((await repository.loadLongTerm())!.tutorialProgress.completedIds).toEqual(observed[0].facts.map(fact => fact.id));
    expect((await repository.loadRuntime())!.activeMatch!.history).toEqual(match.history);
    const restored = new ProgramSession(repository, saves);
    const projector = vi.fn();
    restored.events.registerProjector(projector);
    const replay: MatchFactBatch[] = [];
    restored.events.subscribe("committed", batch => { replay.push(batch); });
    restored.restore((await repository.loadRuntime())!);
    await restored.flush();
    expect(projector).not.toHaveBeenCalled();
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ restored: true, facts: [], fromIndex: match.history.length, toIndex: match.history.length });
    await restored.dispose();
    await session.dispose();
  });

  it("publishes committed facts only after both progress and gameplay are durable", async () => {
    const { session, repository } = harness();
    await session.begin(createProgramRun("facts-atomic", "seed", definition()));
    const { handle } = await openGuard(session);
    session.events.registerProjector((checkpoint, batch) => ({ ...checkpoint, longTerm: recordFacts(checkpoint.longTerm, batch) }));
    const observed: MatchFactBatch[] = [];
    session.events.subscribe("committed", batch => { observed.push(batch); });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = repository.commitMatchResult.bind(repository);
    repository.commitMatchResult = async (save, runtime) => { await blocked; await original(save, runtime); };
    const after = handle.dispatch({ type: "ESCAPE_MATCH" });
    await Promise.resolve();
    expect(observed).toEqual([]);
    expect((await repository.loadRuntime())!.activeMatch!.status).toBe("active");
    release();
    await handle.flush();
    expect(observed).toHaveLength(1);
    expect(observed[0].after).toBe(after);
    expect((await repository.loadLongTerm())!.tutorialProgress.completedIds).toEqual(observed[0].facts.map(fact => fact.id));
    expect((await repository.loadRuntime())!.activeMatch!.history).toEqual(after.history);
    await session.dispose();
  });

  it("includes unsaved facts from a failed action when a later action succeeds", async () => {
    const { session, repository, saves } = harness();
    await session.begin(createProgramRun("facts-retry", "seed", definition()));
    const { match, handle } = await openGuard(session);
    session.events.registerProjector((checkpoint, batch) => ({ ...checkpoint, longTerm: recordFacts(checkpoint.longTerm, batch) }));
    const observed: MatchFactBatch[] = [];
    session.events.subscribe("committed", batch => { observed.push(batch); });
    const original = repository.commitMatchResult.bind(repository);
    repository.commitMatchResult = async () => { throw new Error("disk full"); };
    const first = handle.dispatch({ type: "PLAYER_STAND" });
    expect(first).not.toBe(match);
    await expect(handle.flush()).rejects.toThrow("disk full");
    expect(observed).toEqual([]);
    expect(saves.get().tutorialProgress.completedIds).toEqual([]);
    repository.commitMatchResult = original;
    const after = handle.dispatch({ type: "ESCAPE_MATCH" });
    await handle.flush();
    expect(observed).toHaveLength(1);
    expect(observed[0].fromIndex).toBe(match.history.length);
    expect(observed[0].events).toEqual(after.history.slice(match.history.length));
    expect(observed[0].events.some(event => event.type === "PLAYER_STOOD")).toBe(true);
    expect(observed[0].events.some(event => event.type === "MATCH_ESCAPED")).toBe(true);
    const ids = saves.get().tutorialProgress.completedIds;
    expect(ids).toEqual(observed[0].facts.map(fact => fact.id));
    expect(new Set(ids).size).toBe(ids.length);
    await session.dispose();
  });

  it("rejects asynchronous or gameplay-replacing projections before writing or notifying", async () => {
    const { session, repository } = harness();
    await session.begin(createProgramRun("facts-bad-projector", "seed", definition()));
    const { handle } = await openGuard(session);
    const writes = repository.runtimeWrites.length;
    const observer = vi.fn();
    session.events.subscribe("committed", observer);
    const release = session.events.registerProjector(checkpoint => ({ ...checkpoint, runtime: { ...checkpoint.runtime! } }));
    handle.dispatch({ type: "PLAYER_STAND" });
    await expect(handle.flush()).rejects.toThrow("不得替换运行时存档");
    expect(repository.runtimeWrites).toHaveLength(writes);
    expect(observer).not.toHaveBeenCalled();
    release();
    session.events.registerProjector((async (checkpoint: import("./match-fact-runtime").FactCheckpoint) => checkpoint) as unknown as import("./match-fact-runtime").FactProjector);
    handle.dispatch({ type: "ESCAPE_MATCH" });
    await expect(handle.flush()).rejects.toThrow("必须同步返回");
    expect(repository.runtimeWrites).toHaveLength(writes);
    expect(observer).not.toHaveBeenCalled();
  });
});

describe("public program lifecycle events", () => {
  function terminalEvents(events: RuntimeEventHub) {
    const resolved: PublicEventBatch[] = [], committed: PublicEventBatch[] = [];
    const types = ["match.MATCH_ESCAPED", "match.MATCH_FINISHED", "match.MATCH_RESULT_ACKNOWLEDGED"];
    events.subscribe("resolved", batch => { resolved.push(batch); }, { types });
    events.subscribe("committed", batch => { committed.push(batch); }, { types });
    return { resolved, committed };
  }
  function eventHarness() {
    const events = new RuntimeEventHub();
    const committed: PublicEventBatch[] = [], resolved: PublicEventBatch[] = [];
    events.subscribe("committed", batch => { committed.push(batch); }, { types: ["program.started", "program.restored", "program.node-entered", "program.node-left", "program.choice-selected", "program.reward-claimed", "program.completed", "program.abandoned"] });
    events.subscribe("resolved", batch => { resolved.push(batch); }, { types: ["program.started", "program.restored", "program.node-entered", "program.node-left", "program.choice-selected", "program.reward-claimed", "program.completed", "program.abandoned"] });
    return { ...harness(undefined, undefined, events), events, committed, resolved,
      facts: () => committed.flatMap(batch => batch.facts) };
  }
  function pages() {
    return ProgramDefinitionSchema.parse({ version: 2, id: "pages", start: "first", nodes: [
      { id: "first", type: "presentation", body: "第一页", next: "second" },
      { id: "second", type: "presentation", body: "第二页", next: "end" },
      { id: "end", type: "end", result: "victory" }
    ] });
  }

  it("captures newly settled defeat progress in both the atomic checkpoint and committed lifecycle", async () => {
    const h = eventHarness();
    const save = h.saves.get();
    save.defeats = [{ opponentId: "neutral-prior", timestamp: "2026-11-15T00:00:00.000Z" }];
    await h.repository.saveLongTerm(save);
    const checkpoints: PublicEventBatch[] = [];
    h.repository.addCheckpointProjector((_previous, next, context) => {
      checkpoints.push(...(context.publicEvents ?? []).filter(batch => batch.facts.some(event => event.type.startsWith("program."))));
      return next;
    });
    await h.session.begin(createProgramRun("progress-run", "seed", definition()));
    const before = h.committed.at(-1)!;
    expect(before.context?.values).toEqual({ "progression.defeated.neutral-prior": true });
    await winGuard(h.session);
    await h.session.completeMatch();
    await h.session.claim("draws");
    await h.session.claim("advantage");
    const commit = h.repository.commitMatchResult.bind(h.repository);
    h.repository.commitMatchResult = async () => { throw new Error("disk full"); };
    const count = h.committed.length;
    await expect(h.session.confirm()).rejects.toThrow("disk full");
    expect(h.committed).toHaveLength(count);
    expect((await h.repository.loadLongTerm())!.defeats).toHaveLength(1);
    h.repository.commitMatchResult = commit;
    await h.session.confirm();
    const settled = h.committed.at(-1)!;
    expect(settled.context?.values).toEqual({ "progression.defeated.neutral-prior": true, "progression.defeated.llama": true });
    expect(checkpoints.at(-1)?.context?.values).toEqual(settled.context?.values);
    expect(before.context?.values).toEqual({ "progression.defeated.neutral-prior": true });
    expect(Object.isFrozen(settled.context?.values)).toBe(true);
  });

  it("publishes a match-free program only after persistence and shares event identities across stages", async () => {
    const h = eventHarness(), run = createProgramRun("pages-run", "seed", pages());
    const write = h.repository.saveRuntime.bind(h.repository);
    h.repository.saveRuntime = async () => { throw new Error("disk full"); };
    await expect(h.session.begin(run)).rejects.toThrow("disk full");
    expect(h.committed).toEqual([]); expect(h.resolved).toEqual([]);
    h.repository.saveRuntime = write;
    await h.session.begin(run);
    expect(h.session.match).toBeNull();
    expect(h.facts().map(fact => fact.type)).toEqual(["program.started", "program.node-entered"]);
    expect(h.committed[0]).toBe(h.resolved[0]);
    expect(h.facts().every(fact => fact.scopes.game === "test-game" && fact.scopes.program === run.id)).toBe(true);
    expect((await h.repository.loadRuntime())!.activeProgram!.cursor).toBe("first");
  });

  it("preserves automatic node order and gives repeated visits separate identities", async () => {
    const h = eventHarness();
    const program = ProgramDefinitionSchema.parse({ version: 2, id: "loop", start: "init", nodes: [
      { id: "init", type: "initialize", variables: { count: 0 }, next: "increment" },
      { id: "increment", type: "effect", effects: [{ id: "add", type: "add-variable", key: "count", value: 1 }],
        next: { branches: [{ when: { type: "variable", key: "count", operator: "lt", value: 2 }, to: "increment" }], otherwise: "choose" } },
      { id: "choose", type: "choice", options: [{ id: "again", to: "choose" }, { id: "end", to: "end" }] },
      { id: "end", type: "end", result: "victory" }
    ] });
    await h.session.begin(createProgramRun("loop-run", "seed", program));
    expect(h.facts().filter(fact => fact.type === "program.node-entered").map(fact => [fact.data.nodeId, fact.data.visitIndex]))
      .toEqual([["init", 1], ["increment", 2], ["increment", 3], ["choose", 4]]);
    await h.session.choose("again", h.session.run!);
    const visits = h.facts().filter(fact => fact.type === "program.node-entered" && fact.data.nodeId === "choose");
    expect(visits.map(fact => fact.data.visitIndex)).toEqual([4, 5]);
    expect(new Set(visits.map(fact => fact.id)).size).toBe(2);
    const previous = h.session.run!;
    const choices = await Promise.allSettled([h.session.choose("end", previous), h.session.choose("end", previous)]);
    expect(choices.map(item => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(h.facts().filter(fact => fact.type === "program.completed")).toHaveLength(1);
    expect(h.facts().filter(fact => fact.type === "program.choice-selected" && fact.data.choiceId === "end")).toHaveLength(1);
    expect(await h.repository.loadRuntime()).toBeNull();
  });

  it("retains an immediately finished program's execution evidence across a failed start", async () => {
    const h = eventHarness();
    const program = ProgramDefinitionSchema.parse({ version: 2, id: "instant", start: "effect", nodes: [
      { id: "effect", type: "effect", effects: [], next: "end" },
      { id: "end", type: "end", result: "victory" }
    ] });
    const run = createProgramRun("instant-run", "seed", program), commit = h.repository.commitMatchResult.bind(h.repository);
    h.repository.commitMatchResult = async () => { throw new Error("unavailable"); };
    await expect(h.session.begin(run)).rejects.toThrow("unavailable");
    expect(h.facts()).toEqual([]);
    h.repository.commitMatchResult = commit;
    await h.session.begin(run);
    expect(h.facts().map(fact => [fact.type, fact.data.nodeId])).toEqual([
      ["program.started", "end"], ["program.node-entered", "effect"], ["program.node-left", "effect"],
      ["program.node-entered", "end"], ["program.node-left", "end"], ["program.completed", "end"]
    ]);
  });

  it("includes initialization and a preselected entry in the first durable start batch", async () => {
    const h = eventHarness();
    const created = createProgramRun("preselected", "seed", definition());
    const selected = chooseProgram(created, "guard");
    await h.session.begin(selected);
    expect(h.facts().filter(fact => fact.type === "program.node-entered").map(fact => fact.data.nodeId)).toEqual(["init", "select", "guard"]);
    expect(h.facts().filter(fact => fact.type === "program.choice-selected").map(fact => fact.data.choiceId)).toEqual(["guard"]);
  });

  it("distinguishes a declared abandoned outcome from a completed program", async () => {
    const h = eventHarness();
    const program = ProgramDefinitionSchema.parse({ version: 2, id: "declared-abandon", start: "end", nodes: [
      { id: "end", type: "end", result: "abandoned" }
    ] });
    await h.session.begin(createProgramRun("declared-abandon-run", "seed", program));
    expect(h.facts().filter(fact => fact.type === "program.completed")).toHaveLength(0);
    expect(h.facts().filter(fact => fact.type === "program.abandoned").map(fact => fact.data.result)).toEqual(["abandoned"]);
  });

  it("does not advance two presentation nodes on a double confirmation or publish failed completion", async () => {
    const h = eventHarness();
    await h.session.begin(createProgramRun("confirm-run", "seed", pages()));
    await Promise.all([h.session.confirm(), h.session.confirm()]);
    expect(h.session.run!.cursor).toBe("second");
    expect(h.facts().filter(fact => fact.type === "program.node-left" && fact.data.nodeId === "first")).toHaveLength(1);
    const before = h.facts().length, commit = h.repository.commitMatchResult.bind(h.repository);
    h.repository.commitMatchResult = async () => { throw new Error("completion unavailable"); };
    await expect(h.session.confirm()).rejects.toThrow("completion unavailable");
    expect(h.facts()).toHaveLength(before);
    h.repository.commitMatchResult = commit;
    await h.session.confirm();
    expect(h.facts().filter(fact => fact.type === "program.completed")).toHaveLength(1);
  });

  it("emits no failed reward and restores a settlement without replaying prior choices or rewards", async () => {
    const h = eventHarness();
    await h.session.begin(createProgramRun("rewards-run", "seed", definition()));
    await winGuard(h.session); await h.session.completeMatch();
    const before = h.facts().length, write = h.repository.saveRuntime.bind(h.repository);
    h.repository.saveRuntime = async () => { throw new Error("reward unavailable"); };
    await expect(h.session.claim("draws")).rejects.toThrow("reward unavailable");
    expect(h.facts()).toHaveLength(before);
    h.repository.saveRuntime = write;
    await Promise.all([h.session.claim("draws"), h.session.claim("draws")]);
    expect(h.facts().filter(fact => fact.type === "program.reward-claimed")).toHaveLength(1);
    const snapshot = (await h.repository.loadRuntime())!;
    const restored = new ProgramSession(h.repository, h.saves, undefined, undefined, h.events, { game: "test-game" });
    const delivered = h.facts().length;
    restored.restore(snapshot); await restored.flush();
    expect(h.facts().slice(delivered).map(fact => fact.type)).toEqual(["program.restored"]);
    await restored.claim("draws");
    expect(h.facts().filter(fact => fact.type === "program.reward-claimed")).toHaveLength(1);
    expect(restored.run!.resources!.player!.inventory.drawCount).toBe(2);
    await restored.dispose();
  });

  it("keeps failed abandon recoverable and publishes abandonment once without a completion", async () => {
    const h = eventHarness();
    await h.session.begin(createProgramRun("abandon-run", "seed", pages()));
    const remove = h.repository.deleteRuntime.bind(h.repository), before = h.facts().length;
    h.repository.deleteRuntime = async () => { throw new Error("delete unavailable"); };
    await expect(h.session.abandon()).rejects.toThrow("delete unavailable");
    expect(h.facts()).toHaveLength(before);
    expect(h.session.run).not.toBeNull();
    h.repository.deleteRuntime = remove;
    await Promise.all([h.session.abandon(), h.session.abandon()]);
    expect(h.facts().filter(fact => fact.type === "program.abandoned")).toHaveLength(1);
    expect(h.facts().filter(fact => fact.type === "program.completed")).toHaveLength(0);
  });

  it("marks a host-cleared runtime abandoned once without making a second storage write", async () => {
    const h = eventHarness();
    await h.session.begin(createProgramRun("closed-run", "seed", pages()));
    const close = vi.spyOn(h.repository, "closeGameRuntime").mockRejectedValueOnce(new Error("close unavailable"));
    await expect(h.repository.closeGameRuntime(h.saves.get())).rejects.toThrow("close unavailable");
    expect(h.session.run).not.toBeNull();
    expect(h.facts().filter(fact => fact.type === "program.abandoned")).toHaveLength(0);
    await h.repository.closeGameRuntime(h.saves.get());
    const saveRuntime = vi.spyOn(h.repository, "saveRuntime"), remove = vi.spyOn(h.repository, "deleteRuntime");
    h.session.runtimeClosed(); h.session.runtimeClosed();
    expect(h.session.run).toBeNull();
    expect(close).toHaveBeenCalledTimes(2);
    expect(saveRuntime).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    const abandoned = h.facts().filter(fact => fact.type === "program.abandoned");
    expect(abandoned).toHaveLength(1); expect(abandoned[0].data.reason).toBe("game-stopped");
    expect(await h.repository.loadRuntime()).toBeNull();
  });

  it("resolves an immediate withdrawal only after persistence and before program transition events", async () => {
    const h = eventHarness(), observed = terminalEvents(h.events), order: string[] = [];
    await h.session.begin(createProgramRun("immediate-withdraw", "seed", definition()));
    const { match } = await openGuard(h.session), runId = h.session.run!.id;
    h.events.publish("resolved", matchPublicEventBatch(createMatchFactBatch(undefined, match), { game: "test-game", program: runId }));
    h.events.subscribe("resolved", () => { order.push("match-resolved"); }, { types: ["match.MATCH_ESCAPED"] });
    h.events.subscribe("resolved", () => { order.push("program-transition"); }, { types: ["program.node-left"] });
    h.events.subscribe("committed", () => { order.push("match-committed"); }, { types: ["match.MATCH_ESCAPED"] });
    const write = h.repository.saveRuntime.bind(h.repository);
    h.repository.saveRuntime = async () => { throw new Error("withdraw unavailable"); };
    await expect(h.session.completeMatch(true)).rejects.toThrow("withdraw unavailable");
    expect(observed.resolved).toEqual([]); expect(observed.committed).toEqual([]); expect(order).toEqual([]);
    h.repository.saveRuntime = write;
    await h.session.completeMatch(true);
    expect(order).toEqual(["match-resolved", "program-transition", "match-committed"]);
    const resolved = observed.resolved.flatMap(batch => batch.facts), committed = observed.committed.flatMap(batch => batch.facts);
    expect(resolved.map(fact => fact.type)).toEqual(["match.MATCH_ESCAPED", "match.MATCH_FINISHED", "match.MATCH_RESULT_ACKNOWLEDGED"]);
    expect(resolved.map(fact => [fact.id, fact.scopes])).toEqual(committed.map(fact => [fact.id, fact.scopes]));
    expect(resolved.every(fact => fact.scopes.game === "test-game" && fact.scopes.program === runId)).toBe(true);
  });

  it("resolves a normal result acknowledgement while retaining earlier table fact identities", async () => {
    const h = eventHarness(), observed = terminalEvents(h.events);
    await h.session.begin(createProgramRun("normal-ack", "seed", definition()));
    const won = await winGuard(h.session), scopes = { game: "test-game", program: h.session.run!.id };
    h.events.publish("resolved", matchPublicEventBatch(createMatchFactBatch(undefined, won), scopes));
    const before = observed.resolved.length;
    await h.session.completeMatch();
    const acknowledgement = observed.resolved.slice(before).flatMap(batch => batch.facts);
    expect(acknowledgement.map(fact => fact.type)).toEqual(["match.MATCH_RESULT_ACKNOWLEDGED"]);
    const durable = observed.committed.flatMap(batch => batch.facts).find(fact => fact.type === "match.MATCH_RESULT_ACKNOWLEDGED")!;
    expect(acknowledgement[0].id).toBe(durable.id); expect(acknowledgement[0].scopes).toEqual(durable.scopes);
  });

  it("does not redeliver escape facts already resolved by an ordinary table dispatch", async () => {
    const h = eventHarness(), observed = terminalEvents(h.events);
    await h.session.begin(createProgramRun("dispatched-escape", "seed", definition()));
    const { match, handle } = await openGuard(h.session), scopes = { game: "test-game", program: h.session.run!.id };
    h.events.publish("resolved", matchPublicEventBatch(createMatchFactBatch(undefined, match), scopes));
    handle.dispatch({ type: "ESCAPE_MATCH" });
    h.events.publish("resolved", matchPublicEventBatch(handle.getLastFactBatch!()!, scopes));
    await handle.flush();
    await h.session.completeMatch();
    const resolved = observed.resolved.flatMap(batch => batch.facts), committed = observed.committed.flatMap(batch => batch.facts);
    expect(resolved.filter(fact => fact.type === "match.MATCH_ESCAPED")).toHaveLength(1);
    expect(resolved.filter(fact => fact.type === "match.MATCH_RESULT_ACKNOWLEDGED")).toHaveLength(1);
    expect(resolved.map(fact => [fact.id, fact.scopes])).toEqual(committed.map(fact => [fact.id, fact.scopes]));
  });
});
