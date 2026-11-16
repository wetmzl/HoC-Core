import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { getCharacterMetadata, loadCharacter } from "../characters";
import { createCard } from "../../core/blackjack/card";
import type { Rank } from "../../core/blackjack/types";
import { handValue } from "../../core/blackjack/hand";
import { createMatch, gameReducer, getRoundHitCounts, normalizeAbilityHands } from "../../core/match/reducer";
import type { MatchState } from "../../core/match/types";
import { ABILITY_REGISTRY, getAbilityDefinition, installAbilityRegistry, instantiateAbility } from "../../core/abilities/registry";
import { addAbilityInstance } from "../../core/abilities/runtime";
import type { AbilityBinding } from "../../core/abilities/types";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";

const originalRegistry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(originalRegistry.definitions, originalRegistry.statuses, originalRegistry.catalogVersion));

function fixture(id: "qwen" | "glm", bindings: readonly AbilityBinding[], playerRanks: Rank[], opponentRanks: Rank[], remaining: Rank[] = ["2", "2", "2"]): MatchState {
  const base = createMatch(`official-${id}-skills`, { opponentId: id, opponentAiSkills: bindings, skillDeckIds: [], aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
  const cards = [...playerRanks, ...opponentRanks, ...remaining].map((rank, index) => createCard("spades", rank, `${id}-fixture-${index}`));
  const player = { ...base.player, hand: { cards: cards.slice(0, playerRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(playerRanks.length, playerRanks.length + opponentRanks.length) }, stood: false, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, shoe: { cards, cursor: playerRanks.length + opponentRanks.length, shuffleIndex: 1 },
    history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex }], playerSkills: { ...base.playerSkills, drawOffer: null },
    round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null } };
}

function restore(state: MatchState): MatchState {
  return validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
}

function hold(state: MatchState, definitionId: string, instanceId: string): MatchState {
  const held = instantiateAbility({ definitionId, enabled: true, parameters: {} }, "player", instanceId, state.abilities.sequence + 1);
  return { ...state, abilities: addAbilityInstance(state.abilities, held), playerSkills: { ...state.playerSkills, cards: [...state.playerSkills.cards, { kind: "player-skill", owner: "player", definitionId, level: held.level ?? 1, instanceId }] } };
}

describe("Qwen 与 GLM 官方技能内容", () => {
  it("keeps the requested tiers, exact literary copy and defeat rewards without extra displays", async () => {
    expect(getCharacterMetadata("qwen")?.tier).toBe("A");
    expect(getCharacterMetadata("glm")?.tier).toBe("S");
    const requested = [
      ["qwen-takeaway-and-milk-tea", "你的外卖和奶茶", "替你下单的agent固然美妙，但是你似乎对那家公司不太放心……。"],
      ["glm-not-secrets", "原来这些不是机密吗？", "“是你自己允许我查看工作区文件的嘛”"],
      ["glm-aliyun-oss", "阿里云 OSS", "“已经替你存好了。至于访问权限……哎呀，怎么只有我的名字？”"]
    ];
    for (const [id, name, profileLore] of requested) {
      const definition = getAbilityDefinition(id)!;
      expect(definition).toMatchObject({ name, profileLore, sourceKind: "ai-skill", activation: { type: "automatic" } });
      expect(definition.ttl).toBeUndefined();
      expect(definition.displays ?? []).toEqual([]);
    }
    for (const id of ["qwen", "glm"]) {
      const match = JSON.parse(await readFile(new URL(`../../../public/characters/${id}/resources/character-match.json`, import.meta.url), "utf8"));
      expect(match.rewardSkillResourceIds).toEqual(id === "qwen" ? ["player:qwen-takeaway-player"] : ["player:glm-aliyun-oss-player"]);
    }
  });

  it("uses a held card on the second actual Hit and restores its consumed card and lasting status correctly", async () => {
    let state = fixture("qwen", (await loadCharacter("qwen")).aiSkills, ["2", "2"], ["2", "2"]);
    state = hold(state, "a-single-coin", "held-coin");
    state = gameReducer(state, { type: "PLAYER_HIT" });
    expect(getRoundHitCounts(state).player).toBe(1);
    expect(state.history.filter(event => event.type === "ABILITY_PLAYED")).toEqual([]);
    expect(state.playerSkills.cards.map(card => card.instanceId)).toEqual(["held-coin"]);
    state = gameReducer({ ...state, round: { ...state.round, currentActor: "player" } }, { type: "PLAYER_HIT" });
    expect(getRoundHitCounts(state).player).toBe(2);
    expect(state.history.filter(event => event.type === "ABILITY_PLAYED")).toEqual([expect.objectContaining({ definitionId: "a-single-coin", owner: "player", instanceId: "held-coin" })]);
    expect(state.abilities.statuses).toContainEqual(expect.objectContaining({ statusDefinitionId: "player-point-advantage", owner: "player", stacks: 1 }));
    expect(state.playerSkills.cards).toEqual([]);
    const advantage = state.abilities.statuses.find(status => status.statusDefinitionId === "player-point-advantage" && status.owner === "player")!;
    expect(advantage.sourceInstanceId).toBe("held-coin");
    expect(state.abilities.instances.filter(instance => instance.kind === "player-skill").map(instance => instance.instanceId)).toEqual([advantage.sourceInstanceId]);
    expect(state.abilities.instances.find(instance => instance.instanceId === advantage.sourceInstanceId)).toMatchObject({ definitionId: "a-single-coin", owner: "player" });
    expect(restore(state)).toEqual(state);
    state = gameReducer({ ...restore(state), round: { ...state.round, currentActor: "player" } }, { type: "PLAYER_HIT" });
    expect(getRoundHitCounts(state).player).toBe(3);
    expect(state.history.filter(event => event.type === "ABILITY_PLAYED")).toHaveLength(1);
    expect(state.playerSkills.cards).toEqual([]);
    expect(restore(state)).toEqual(state);
    expect(state.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });

  it.each(["empty", "unavailable"] as const)("skips Qwen's delivery when the held active pool is %s", async mode => {
    let state = fixture("qwen", (await loadCharacter("qwen")).aiSkills, ["2", "2"], ["2", "2"]);
    if (mode === "unavailable") {
      state = hold(state, "prepaid-premium", "unavailable-premium");
      state = { ...state, roulette: { ...state.roulette, player: { ...state.roulette.player, bullets: state.roulette.player.capacity } } };
    }
    const cards = state.playerSkills.cards;
    for (let hit = 0; hit < 2; hit++) state = gameReducer({ ...state, round: { ...state.round, currentActor: "player" } }, { type: "PLAYER_HIT" });
    expect(getRoundHitCounts(state).player).toBe(2);
    expect(state.playerSkills.cards).toEqual(cards);
    expect(state.history.filter(event => event.type === "ABILITY_PLAYED" || (event.type === "ABILITY_TRIGGERED" && event.definitionId === "qwen-takeaway-and-milk-tea"))).toEqual([]);
    expect(restore(state)).toEqual(state);
  });

  it.each([[18, 19, "stand"], [19, 18, "hit"], [18, 18, "hit"]] as const)("uses GLM's information after the player stands: player %s versus GLM %s means %s", async (playerTotal, opponentTotal, action) => {
    const binding = (await loadCharacter("glm")).aiSkills.filter(skill => skill.definitionId === "glm-not-secrets");
    const state = fixture("glm", binding, ["10", playerTotal === 19 ? "9" : "8"], ["10", opponentTotal === 19 ? "9" : "8"]);
    const player = { ...state.player, stood: true };
    const after = gameReducer({ ...state, player, round: { ...state.round, player, currentActor: "opponent" } }, { type: "AI_TURN" });
    expect(after.lastAiDecision?.action).toBe(action);
    expect(after.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });

  it("retains the ordinary AI policy while the player has not stood", async () => {
    const binding = (await loadCharacter("glm")).aiSkills.filter(skill => skill.definitionId === "glm-not-secrets");
    const state = fixture("glm", binding, ["10", "9"], ["10", "8"]);
    const after = gameReducer({ ...state, round: { ...state.round, currentActor: "opponent" } }, { type: "AI_TURN" });
    expect(after.lastAiDecision?.action).toBe("stand");
    expect(after.lastAiDecision?.actionOverride).toBeUndefined();
    expect(after.history.some(event => event.type === "ABILITY_TRIGGERED" && event.definitionId === "glm-not-secrets")).toBe(false);
  });

  it("stops GLM after a losing Hit busts, including after saving and restoring", async () => {
    let state = fixture("glm", (await loadCharacter("glm")).aiSkills, ["10", "10"], ["10", "9"], ["5", "2", "2"]);
    state = gameReducer(state, { type: "PLAYER_STAND" });
    state = gameReducer(state, { type: "AI_TURN" });
    expect(state.lastAiDecision?.action).toBe("hit");
    expect(state.opponent.busted).toBe(true);
    expect(handValue(state.opponent.hand)).toBe(24);
    state = restore(state);
    const cursor = state.shoe.cursor;
    state = gameReducer(state, { type: "AI_TURN" });
    expect(state.lastAiDecision?.action).toBe("stand");
    expect(state.opponent.stood).toBe(true);
    expect(state.shoe.cursor).toBe(cursor);
    expect(getRoundHitCounts(state).opponent).toBe(1);
    expect(state.round.outcome).toMatchObject({ winner: "player", reason: "bust" });
    expect(state.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });

  it("stops an already busted GLM before the player stands even with a high AI threshold", async () => {
    const base = normalizeAbilityHands(fixture("glm", (await loadCharacter("glm")).aiSkills, ["10", "9"], ["10", "9", "5"]));
    const state = { ...base, aiProfile: { P: 100, A: 0, B: 0, C: 0 }, round: { ...base.round, currentActor: "opponent" as const } };
    const after = gameReducer(state, { type: "AI_TURN" });
    expect(after.lastAiDecision?.action).toBe("stand");
    expect(after.opponent.stood).toBe(true);
    expect(after.shoe.cursor).toBe(state.shoe.cursor);
    expect(after.round.currentActor).toBe("player");
  });

  it("recompares both changed hands after GLM hits and steals a limit-reaching card", async () => {
    let state = fixture("glm", (await loadCharacter("glm")).aiSkills, ["10", "7", "2"], ["10", "8"], ["A", "2", "2"]);
    const player = { ...state.player, stood: true };
    const stolen = state.player.hand.cards[2];
    state = gameReducer({ ...state, player, round: { ...state.round, player, currentActor: "opponent" } }, { type: "AI_TURN" });
    expect(state.lastAiDecision?.action).toBe("hit");
    expect(state.opponent.hand.cards.at(-1)).toEqual(stolen);
    expect(handValue(state.player.hand)).toBe(17);
    expect(handValue(state.opponent.hand)).toBe(21);
    expect(getRoundHitCounts(state)).toEqual({ player: 0, opponent: 1 });
    state = restore(state);
    const cursor = state.shoe.cursor;
    state = gameReducer(state, { type: "AI_TURN" });
    expect(state.lastAiDecision?.action).toBe("stand");
    expect(state.shoe.cursor).toBe(cursor);
    expect(state.round.outcome?.winner).toBe("opponent");
    expect(state.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });

  it("steals the first eligible card anywhere in the player's hand after a hand change", async () => {
    const binding = (await loadCharacter("glm")).aiSkills.filter(skill => skill.definitionId === "glm-aliyun-oss");
    const state = fixture("glm", binding, ["2", "3", "2"], ["10", "9"], ["A", "2", "2"]);
    const stolen = state.player.hand.cards[0];
    const after = gameReducer(state, { type: "PLAYER_HIT" });
    expect(after.player.hand.cards.some(card => card.id === stolen.id)).toBe(false);
    expect(after.opponent.hand.cards.at(-1)).toEqual(stolen);
    expect(handValue(after.opponent.hand)).toBe(21);
    expect(getRoundHitCounts(after)).toEqual({ player: 1, opponent: 0 });
    expect(after.shoe.cursor).toBe(state.shoe.cursor + 1);
    expect(after.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });

  it.each(["menu-smoke-a", "menu-smoke-b", "menu-smoke-c"])("saves and restores real held-card deliveries across two rounds with seed %s", async seed => {
    const bindings = (await loadCharacter("qwen")).aiSkills;
    let state = createMatch(seed, { opponentId: "qwen", opponentAiSkills: bindings, skillDeckIds: [], grantOpeningSkills: false, openingSkillCards: 0,
      initialPlayerSkills: ["a-single-coin", "critical-judgment", "situation-assessment", "scent-of-a-woman", "heart-hunter", "prepaid-premium"].map(definitionId => ({ definitionId, enabled: true, parameters: {} })),
      aiProfile: { P: 0, A: 0, B: 0, C: 0 } });
    let deliveries = 0;
    for (let step = 0; step < 80 && state.status === "active" && state.roundIndex < 2; step++) {
      const before = state;
      if (state.round.phase === "turns") {
        if (state.round.currentActor === "opponent") state = gameReducer(state, { type: "AI_TURN" });
        else if (getRoundHitCounts(state).player < 3) {
          state = gameReducer(state, { type: "PLAYER_HIT" });
          expect(getRoundHitCounts(state).player).toBe(getRoundHitCounts(before).player + 1);
          const plays = state.history.slice(before.history.length).filter(event => event.type === "ABILITY_PLAYED");
          expect(plays.length).toBe(getRoundHitCounts(state).player >= 2 ? 1 : 0);
          for (const played of plays) {
            if (played.type !== "ABILITY_PLAYED") continue;
            deliveries++;
            expect(before.playerSkills.cards).toContainEqual(expect.objectContaining({ instanceId: played.instanceId, definitionId: played.definitionId }));
            const definition = getAbilityDefinition(played.definitionId)!;
            const oldInstance = before.abilities.instances.find(instance => instance.instanceId === played.instanceId)!;
            const uses = oldInstance.remainingUses ?? (definition.activation.type === "action" ? definition.activation.uses ?? 1 : 1);
            expect(state.playerSkills.cards.some(card => card.instanceId === played.instanceId)).toBe(uses > 1);
            if (uses > 1) expect(state.abilities.instances.find(instance => instance.instanceId === played.instanceId)?.remainingUses).toBe(uses - 1);
            for (const card of before.playerSkills.cards.filter(card => card.instanceId !== played.instanceId)) expect(state.playerSkills.cards).toContainEqual(card);
          }
        } else state = gameReducer(state, { type: "PLAYER_STAND" });
      } else if (state.round.phase === "round-reveal") state = gameReducer(state, { type: "ACK_ROUND_RESULT" });
      else if (state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger") state = gameReducer(state, { type: "TRIGGER_ROULETTE" });
      else if (state.round.phase === "roulette-result") state = gameReducer(state, { type: "ACK_TRIGGER_RESULT" });
      else throw new Error(`Unexpected phase ${state.round.phase}`);
      expect(state.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
      expect(restore(state)).toEqual(state);
      state = restore(state);
    }
    expect(deliveries).toBeGreaterThanOrEqual(4);
    expect(state.roundIndex).toBe(2);
  });
});
