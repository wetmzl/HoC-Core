import { describe, expect, it } from "vitest";
import { createFlowRun } from "../core/flow/reducer";
import { instantiateAbility } from "../core/abilities/registry";
import { FlowDefinitionSchema, type FlowDefinition } from "../core/flow/schema";
import { createMatch, gameReducer } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveRepository } from "../persistence/memory-repository";
import { EncounterSession } from "./encounter-session";

function circuit(): FlowDefinition {
  return FlowDefinitionSchema.parse({ id: "fixture-circuit", playerGun: { capacity: 3, bullets: 1 }, nodes: [
    { id: "first", opponentId: "llama", opponentGun: { capacity: 2, bullets: 0 }, routes: {
      victory: { type: "node", nodeId: "second" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" }
    } },
    { id: "second", opponentId: "llama", requires: ["first"], opponentGun: { capacity: 5, bullets: 0 }, routes: {
      victory: { type: "node", nodeId: "final" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "selection" }
    } },
    { id: "final", opponentId: "chatgpt", requires: ["second"], opponentGun: { capacity: 9, bullets: 0 }, routes: {
      victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" }
    } }
  ] });
}

async function harness(definition = circuit()) {
  let save = createDefaultSave();
  const repository = new MemorySaveRepository({ longTerm: save });
  const saves = { get: () => save, set: (next: typeof save) => { save = next; } };
  const session = new EncounterSession(repository, saves);
  await session.begin(createFlowRun("fixture-run", "fixture-seed", definition));
  const reopen = async () => {
    const restored = new EncounterSession(repository, saves);
    restored.restore((await repository.loadRuntime())!);
    return restored;
  };
  return { session, repository, saves, reopen };
}

function finish(match: MatchState, winner: "player" | "opponent" = "player"): MatchState {
  const actor = winner === "player" ? "opponent" : "player";
  const ready: MatchState = { ...match,
    roulette: { ...match.roulette, [actor]: { ...match.roulette[actor], bullets: match.roulette[actor].capacity } },
    round: { ...match.round, phase: "roulette-trigger", currentActor: null,
      outcome: { winner, reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } }
  };
  const result = gameReducer(gameReducer(ready, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
  expect(result.status).toBe("finished");
  expect(result.view).toBe("match-summary");
  return result;
}

async function open(session: EncounterSession, nodeId: string, transform: (match: MatchState) => MatchState = match => match) {
  const prepared = session.prepare(nodeId);
  expect(prepared).not.toBeNull();
  const match = transform(createMatch(prepared!.plan.seed, {
    ...prepared!.plan.options, opponentId: prepared!.plan.opponentId, opponentAiSkills: [], talentIds: []
  }));
  const handle = await session.attach(prepared!.run, match);
  return { match, handle, plan: prepared!.plan };
}

describe("persisted generic flow sessions", () => {
  it("restores a three-node route with two visits to the same opponent and records only its final result", async () => {
    const definition = circuit(), h = await harness(definition);
    let session = h.session;
    const matches: MatchState[] = [];
    expect(session.prepare("second")).toBeNull();
    for (const [index, node] of definition.nodes.entries()) {
      const { match, handle } = await open(session, node.id, finish);
      matches.push(match);
      expect(match.roulette.player).toEqual({ capacity: 3, bullets: 1 });
      expect(match.roulette.opponent.capacity).toBe(node.opponentGun!.capacity);
      expect(session.recordsResult).toBe(index === 2);
      expect(session.continues).toBe(index !== 2);
      await session.settle();
      expect(() => handle.getState()).toThrow("牌局已结束");
      if (index < 2) {
        const durable = (await h.repository.loadRuntime())!;
        expect(durable.activeMatch).toBeNull();
        expect(durable.activeFlow?.nextNodeId).toBe(definition.nodes[index + 1].id);
        expect(durable.activeFlow?.completedNodes).toEqual(definition.nodes.slice(0, index + 1).map(value => value.id));
        expect((await h.repository.loadLongTerm())!.history).toEqual([]);
        session = await h.reopen();
        expect(session.run!.nextNodeId).toBe(definition.nodes[index + 1].id);
        expect(session.prepare(node.id)).toBeNull();
      }
    }
    expect(matches[0].opponentId).toBe(matches[1].opponentId);
    expect(new Set(matches.map(match => match.id)).size).toBe(3);
    expect(new Set(matches.map(match => match.seed)).size).toBe(3);
    expect(await h.repository.loadRuntime()).toBeNull();
    expect(h.saves.get().history.map(record => record.id)).toEqual([matches[2].id]);
    expect(h.saves.get().profile).toMatchObject({ matchesPlayed: 1, wins: 1 });
    expect(h.saves.get().characterDefeatProgress?.counts).toEqual({ llama: 2, chatgpt: 1 });
    expect(h.repository.commits).toHaveLength(3);
    await expect(session.settle()).rejects.toThrow();
    expect(h.repository.commits).toHaveLength(3);
  });

  it("records a defeat at a node whose victory would have continued the flow", async () => {
    const { session, repository, saves } = await harness();
    const { match } = await open(session, "first", state => finish(state, "opponent"));
    expect(session.recordsResult).toBe(true); expect(session.continues).toBe(false);
    await session.settle();
    expect(await repository.loadRuntime()).toBeNull();
    expect(saves.get().history.map(record => record.id)).toEqual([match.id]);
    expect(saves.get().profile).toMatchObject({ matchesPlayed: 1, wins: 0 });
    expect(saves.get().defeats).toEqual([]);
    expect(repository.commits).toHaveLength(1);
  });

  it("persists an authored escape destination and opens it with a fresh table identity", async () => {
    const source = circuit();
    const definition: FlowDefinition = { ...source, nodes: source.nodes.map((node, index) => index === 0
      ? { ...node, routes: { ...node.routes, escaped: { type: "node", nodeId: "second" } } }
      : index === 1 ? { ...node, requires: [] } : node) };
    const h = await harness(definition);
    const first = await open(h.session, "first");
    expect(h.session.escapeContinues).toBe(true);
    await h.session.settle(true);
    const restored = await h.reopen();
    expect(restored.run!.nextNodeId).toBe("second");
    expect(restored.run!.completedNodes).toEqual([]);
    expect(restored.prepare("first")).toBeNull();
    const second = await open(restored, "second");
    expect(second.match.id).not.toBe(first.match.id);
    expect(second.match.seed).not.toBe(first.match.seed);
    expect(second.match.playerSkills.cards).toEqual(first.match.playerSkills.cards);
    expect((await h.repository.loadLongTerm())!.history).toEqual([]);
    expect(h.repository.commits).toHaveLength(0);
  });

  it("reopens a repeatable node after victories and escape without duplicate completed nodes or reused table IDs", async () => {
    const source = circuit(), node = source.nodes[0];
    const h = await harness({ ...source, nodes: [{ ...node, id: "practice", repeatable: true,
      routes: { victory: { type: "selection" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "node", nodeId: "practice" } }
    }] });
    let session = h.session;
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      ids.push((await open(session, "practice", finish)).match.id);
      await session.settle(); session = await h.reopen();
      expect(session.run!.completedNodes).toEqual(["practice"]);
    }
    ids.push((await open(session, "practice")).match.id);
    await session.settle(true); session = await h.reopen();
    expect(session.run!.completedNodes).toEqual(["practice"]);
    ids.push((await open(session, "practice", state => finish(state, "opponent"))).match.id);
    await session.settle();
    expect(new Set(ids).size).toBe(4);
    expect(h.saves.get().history.map(record => record.id)).toEqual([ids[3]]);
    expect(h.saves.get().characterDefeatProgress?.counts.llama).toBe(2);
    expect(h.repository.commits).toHaveLength(3);
  });

  it("carries an exhausted inventory through save/reload without issuing opening cards or draws again", async () => {
    const h = await harness();
    await open(h.session, "first", state => {
      expect(state.playerSkills.cards.length).toBeGreaterThan(0);
      const ended = finish(state), cardIds = new Set(ended.playerSkills.cards.map(card => card.instanceId));
      return { ...ended, playerSkills: { ...ended.playerSkills, cards: [], drawCount: 0 },
        abilities: { ...ended.abilities, instances: ended.abilities.instances.filter(instance => !cardIds.has(instance.instanceId)), counters: {} } };
    });
    await h.session.settle();
    expect((await h.repository.loadRuntime())!.flowMemory!.player!.inventory.cards).toEqual([]);
    const restored = await h.reopen(), { match } = await open(restored, "second");
    expect(match.playerSkills.cards).toEqual([]); expect(match.playerSkills.drawCount).toBe(0);
    expect(match.playerSkills.openingCardCount).toBe(3);
    expect(match.roulette).toEqual({ player: { capacity: 3, bullets: 1 }, opponent: { capacity: 5, bullets: 0 } });
    expect((await h.repository.loadRuntime())!.activeMatch!.playerSkills.cards).toEqual([]);
  });

  it("preserves a partly used card and its remaining draws across victory, reload and the next opening", async () => {
    const h = await harness();
    const instance = { ...instantiateAbility({ definitionId: "situation-assessment", level: 1, enabled: true, parameters: {} },
      "player", "fixture-carried-card", 99, undefined, "player-skill"), remainingUses: 1 };
    const { match } = await open(h.session, "first", state => finish({ ...state,
      playerSkills: { ...state.playerSkills, cards: [{ kind: "player-skill", owner: "player", level: 1,
        definitionId: instance.definitionId, instanceId: instance.instanceId }], drawCount: 2 },
      abilities: { ...state.abilities, instances: [instance], sequence: 99, counters: {} }
    }));
    await h.session.settle();
    const selection = (await h.repository.loadRuntime())!;
    expect(selection.flowMemory!.player!.instances).toEqual([instance]);
    const next = await open(await h.reopen(), "second");
    expect(next.match.playerSkills.cards).toEqual(match.playerSkills.cards);
    expect(next.match.playerSkills.drawCount).toBe(2);
    expect(next.match.abilities.instances.find(value => value.instanceId === instance.instanceId)?.remainingUses).toBe(1);
    expect((await h.repository.loadRuntime())!.activeMatch!.abilities.instances).toContainEqual(instance);
  });

  it("rejects previous-node attachments and invalidates handles even when a rollback reuses the next match ID", async () => {
    const h = await harness();
    const first = await open(h.session, "first", finish), previousRun = h.session.run!;
    await h.session.settle();
    const selection = h.session.snapshot!;
    await expect(h.session.attach(previousRun, first.match)).rejects.toThrow();
    expect(await h.repository.loadRuntime()).toEqual(selection);
    const second = await open(h.session, "second"), secondRun = h.session.run!;
    const authoritative = h.session.snapshot!;
    await expect(h.session.attach(previousRun, first.match)).rejects.toThrow();
    expect(await h.repository.loadRuntime()).toEqual(authoritative);
    expect(() => first.handle.updateSave(createDefaultSave())).toThrow("牌局已结束");
    await h.session.replace(selection);
    const retry = h.session.prepare("second")!;
    expect(retry.plan.options.id).toBe(second.match.id);
    const current = await h.session.attach(retry.run, second.match);
    expect(() => second.handle.dispatch({ type: "PLAYER_STAND" })).toThrow("牌局已结束");
    const state = current.dispatch({ type: "PLAYER_STAND" }); await current.flush();
    await expect(h.session.attach(secondRun, second.match)).rejects.toThrow("牌局已改变");
    expect((await h.repository.loadRuntime())!.activeMatch).toEqual(state);
    expect(h.repository.longTermWrites).toHaveLength(1);
    expect(h.saves.get().characterDefeatProgress?.counts.llama).toBe(1);
  });

  it("retries a failed reward as one durable receipt and carries each resource change to the next table", async () => {
    const source = circuit();
    const h = await harness({ ...source, nodes: source.nodes.map((node, index) => index ? node : {
      ...node, victoryRewards: { skillDraws: 2, removeBullets: 1, pointAdvantage: 3 }
    }) });
    const { match } = await open(h.session, "first", finish), before = h.session.snapshot!;
    const write = h.repository.saveRuntime.bind(h.repository); let fail = true;
    h.repository.saveRuntime = async snapshot => { if (fail) { fail = false; throw new Error("reward unavailable"); } await write(snapshot); };
    await expect(h.session.claim("skillDraws")).rejects.toThrow("reward unavailable");
    expect(h.session.snapshot).toBe(before);
    expect(await h.repository.loadRuntime()).toEqual(before);
    const restored = await h.reopen(), writes = h.repository.runtimeWrites.length;
    await Promise.all([restored.claim("skillDraws"), restored.claim("skillDraws")]);
    expect(h.repository.runtimeWrites).toHaveLength(writes + 1);
    expect(restored.run!.encounter!.claimedRewards).toEqual(["skillDraws"]);
    expect(restored.match!.playerSkills.drawCount).toBe(match.playerSkills.drawCount + 2);
    await expect(restored.settle()).rejects.toThrow("请先领取本场奖励");
    const again = await h.reopen();
    await again.claim("skillDraws"); await again.claim("removeBullets"); await again.claim("pointAdvantage");
    expect((await h.repository.loadRuntime())!.activeFlow!.encounter!.claimedRewards).toEqual(["skillDraws", "removeBullets", "pointAdvantage"]);
    await again.settle();
    const next = await open(await h.reopen(), "second");
    expect(next.match.playerSkills.drawCount).toBe(match.playerSkills.drawCount + 2);
    expect(next.match.roulette.player).toEqual({ capacity: 3, bullets: 0 });
    expect(next.match.comparisonBonuses).toEqual({ player: 3, opponent: 0 });
    expect(h.repository.commits).toHaveLength(1);
    expect(h.saves.get().characterDefeatProgress?.counts.llama).toBe(1);
  });

  it("atomically records an always node with its continuation and retains the pending result on failure", async () => {
    const source = circuit();
    const h = await harness({ ...source, nodes: source.nodes.map((node, index) => index ? node : { ...node, recordResult: "always" }) });
    const { match } = await open(h.session, "first", finish), before = h.session.snapshot!;
    expect(h.session.recordsResult).toBe(true); expect(h.session.continues).toBe(true);
    const commit = h.repository.commitMatchResult.bind(h.repository); let fail = true;
    h.repository.commitMatchResult = async (save, runtime) => {
      if (fail) { fail = false; throw new Error("continued result unavailable"); }
      await commit(save, runtime);
    };
    await expect(h.session.settle()).rejects.toThrow("continued result unavailable");
    expect(h.session.snapshot).toBe(before);
    expect(await h.repository.loadRuntime()).toEqual(before);
    expect((await h.repository.loadLongTerm())!.history).toEqual([]);
    expect(h.saves.get().history).toEqual([]); expect(h.repository.commits).toHaveLength(0);
    const restored = await h.reopen(); await restored.settle();
    expect((await h.repository.loadLongTerm())!.history.map(record => record.id)).toEqual([match.id]);
    expect((await h.repository.loadRuntime())!.activeFlow!.nextNodeId).toBe("second");
    expect((await h.repository.loadRuntime())!.activeMatch).toBeNull();
    expect(h.saves.get().profile.matchesPlayed).toBe(1);
    await expect(restored.settle()).rejects.toThrow();
    expect(h.repository.commits).toHaveLength(1);
    expect((await h.reopen()).prepare("second")).not.toBeNull();
  });

  it.each([undefined, "fixture-completion"])("honors never for a terminal node while preserving completion marker %s", async completionId => {
    const source = circuit(), node = source.nodes[2];
    const h = await harness({ ...source, ...(completionId ? { completionId } : {}), nodes: [{ ...node, requires: [], recordResult: "never" }] });
    await open(h.session, "final", finish);
    expect(h.session.recordsResult).toBe(false); expect(h.session.continues).toBe(false);
    await h.session.settle();
    expect(await h.repository.loadRuntime()).toBeNull();
    const durable = (await h.repository.loadLongTerm())!;
    expect(durable.history).toEqual([]); expect(durable.defeats).toEqual([]);
    expect(durable.profile).toMatchObject({ matchesPlayed: 0, wins: 0 });
    expect(durable.completedChallenges ?? []).toEqual(completionId ? [completionId] : []);
    expect(durable.characterDefeatProgress?.counts.chatgpt).toBe(1);
    expect(h.repository.commits).toHaveLength(1);
  });
});
