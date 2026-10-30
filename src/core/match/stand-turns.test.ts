import { afterEach, describe, expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import type { Rank } from "../blackjack/types";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import { createMatch, gameReducer, getLegalActions, type CreateMatchOptions } from "./reducer";
import type { MatchState } from "./types";
import { createDefaultSave, createRuntimeSave } from "../../persistence/boot";
import { validateLongTermSave, validateRuntimeSave } from "../../persistence/schema";
import { exportSaveJson, importSave } from "../../persistence/json";

const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));
const binding = (definitionId: string) => ({ definitionId, enabled: true, parameters: {} });
function install(definitions: readonly unknown[], statuses: readonly unknown[] = []) {
  installAbilityRegistry([...registry.definitions, ...definitions], [...registry.statuses, ...statuses], registry.catalogVersion);
}
function fixture(options: CreateMatchOptions = {}): MatchState {
  const base = createMatch("neutral-stand-turns", { opponentId: "chatgpt", opponentAiSkills: [], ...options });
  const ranks: Rank[] = ["2", "3", "2", "3", "2", "2", "2", "2", "2", "2"];
  const cards = ranks.map((rank, index) => createCard("spades", rank, `stand-turn-${index}`));
  const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 },
    playerSkills: { ...base.playerSkills, drawCount: 0, drawOffer: null },
    round: { ...base.round, phase: "turns", currentActor: "player", player, opponent, outcome: null },
    history: [{ type: "ROUND_STARTED", roundIndex: base.roundIndex },
      ...cards.slice(0, 4).map((card, index) => ({ type: "CARD_DEALT" as const, actor: index < 2 ? "player" as const : "opponent" as const, card, private: true }))] };
}
function returnedPlayerTurn(state = fixture({ autoSkipAfterStand: false })): MatchState {
  return gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "OPPONENT_HIT" });
}
const active = { id: "example-stand-active", name: "示例改牌", description: "添加一张中性衍生牌", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example-active"],
  activation: { type: "action", windows: ["owner-turn"], consume: "none" },
  rules: [{ id: "add", trigger: "on-ability-played", effects: [{ type: "acquire-card", target: "owner", reportResult: true, choices: [{ source: "derived", rank: { type: "static", rank: "2" }, suit: { type: "static", suit: "clubs" } }] }] }] };
const onStand = { id: "example-stand-reward", name: "示例停牌", description: "停牌时增加一次抽取", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
  rules: [{ id: "reward", trigger: "after-stand", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }] };

function addStatus(state: MatchState, statusDefinitionId: string, duration: "round" | "until-owner-action" = "round"): MatchState {
  return { ...state, abilities: { ...state.abilities, statuses: [...state.abilities.statuses, {
    statusDefinitionId, owner: "player", sourceInstanceId: state.abilities.instances[0].instanceId, stacks: 1, duration, parameters: {}, createdAtSequence: state.abilities.sequence
  }] } };
}

describe("optional player turns after Stand", () => {
  it.each([true, undefined])("keeps automatic skipping for new/default and legacy matches (%s)", autoSkipAfterStand => {
    expect(createMatch("stand-default").autoSkipAfterStand).toBe(true);
    const initial = { ...fixture(), autoSkipAfterStand };
    const state = returnedPlayerTurn(initial);
    expect(state.round.currentActor).toBe("opponent");
    expect(state.player.stood).toBe(true);
    expect(getLegalActions(state)).toContainEqual({ type: "AI_TURN" });
  });

  it("returns to the stood player repeatedly, rejecting Hit without any state or RNG changes", () => {
    let state = gameReducer(fixture({ autoSkipAfterStand: false }), { type: "PLAYER_STAND" });
    for (let index = 0; index < 3; index++) {
      state = gameReducer(state, { type: "OPPONENT_HIT" });
      expect(state.round).toMatchObject({ currentActor: "player", phase: "turns" });
      expect(state.player.stood).toBe(true);
      const snapshot = structuredClone(state);
      expect(getLegalActions(state)).toContainEqual({ type: "PLAYER_STAND" });
      expect(getLegalActions(state)).not.toContainEqual({ type: "PLAYER_HIT" });
      expect(gameReducer(state, { type: "PLAYER_HIT" })).toBe(state);
      expect(state).toEqual(snapshot);
      state = gameReducer(state, { type: "PLAYER_STAND" });
      expect(state.round.currentActor).toBe("opponent");
    }
    expect(state.history.filter(event => event.type === "PLAYER_STOOD")).toHaveLength(1);
  });

  it("keeps the current turn through repeated skill hand changes without restoring Hit", () => {
    install([active]);
    let state = returnedPlayerTurn(fixture({ autoSkipAfterStand: false, playerAiSkills: [binding(active.id)] }));
    const instanceId = state.abilities.instances[0].instanceId;
    for (let index = 0; index < 2; index++) {
      expect(getLegalActions(state)).toContainEqual({ type: "PLAY_ABILITY", instanceId });
      state = gameReducer(state, { type: "PLAY_ABILITY", instanceId });
      expect(state.player.hand.cards).toHaveLength(3 + index);
      expect(state.player.stood).toBe(true);
      expect(state.round.currentActor).toBe("player");
      expect(gameReducer(state, { type: "PLAYER_HIT" })).toBe(state);
    }
  });

  it("lets a stood player draw and select a skill without yielding", () => {
    const state = returnedPlayerTurn();
    const ready = { ...state, playerSkills: { ...state.playerSkills, drawCount: 1 } };
    expect(getLegalActions(ready)).toContainEqual({ type: "OPEN_SKILL_DRAW" });
    const offered = gameReducer(ready, { type: "OPEN_SKILL_DRAW" });
    const definitionId = offered.playerSkills.drawOffer!.candidateDefinitionIds[0];
    const selected = gameReducer(offered, { type: "SELECT_SKILL_DRAW", definitionId });
    expect(selected.round.currentActor).toBe("player");
    expect(selected.player.stood).toBe(true);
    expect(selected.playerSkills.cards).toHaveLength(state.playerSkills.cards.length + 1);
    expect(getLegalActions(selected)).toContainEqual({ type: "PLAYER_STAND" });
    expect(gameReducer(selected, { type: "PLAYER_HIT" })).toBe(selected);
  });

  it("does not retrigger Stand rewards, but expires until-owner-action statuses on repeated Stand", () => {
    install([onStand], [{ id: "example-until-action", defaultDuration: "until-owner-action", rules: [] }]);
    const state = returnedPlayerTurn(fixture({ autoSkipAfterStand: false, playerAiSkills: [binding(onStand.id)] }));
    expect(state.playerSkills.drawCount).toBe(1);
    const marked = addStatus(state, "example-until-action", "until-owner-action");
    const after = gameReducer(marked, { type: "PLAYER_STAND" });
    expect(after.playerSkills.drawCount).toBe(1);
    expect(after.abilities.statuses).toHaveLength(0);
    expect(after.history.slice(marked.history.length)).toContainEqual({ type: "STATUS_REMOVED", statusDefinitionId: "example-until-action", owner: "player", reason: "expired" });
    expect(after.history.filter(event => event.type === "PLAYER_STOOD")).toHaveLength(1);
    expect(after.history.filter(event => event.type === "ABILITY_TRIGGERED" && event.definitionId === onStand.id)).toHaveLength(1);
  });

  it("respects Stand and skill-tag blocking after standing", () => {
    install([active], [
      { id: "example-no-stand", defaultDuration: "round", blocksActions: ["stand"], rules: [] },
      { id: "example-no-skills", defaultDuration: "round", blocksAbilityTags: ["example-active"], rules: [] }
    ]);
    const state = returnedPlayerTurn(fixture({ autoSkipAfterStand: false, playerAiSkills: [binding(active.id)] }));
    const instanceId = state.abilities.instances[0].instanceId;
    const noStand = addStatus(state, "example-no-stand");
    expect(getLegalActions(noStand)).not.toContainEqual({ type: "PLAYER_STAND" });
    expect(gameReducer(noStand, { type: "PLAYER_STAND" })).toBe(noStand);
    expect(getLegalActions(noStand)).toContainEqual({ type: "PLAY_ABILITY", instanceId });
    const noSkills = addStatus(state, "example-no-skills");
    expect(getLegalActions(noSkills)).not.toContainEqual({ type: "PLAY_ABILITY", instanceId });
    expect(gameReducer(noSkills, { type: "PLAY_ABILITY", instanceId })).toBe(noSkills);
    expect(getLegalActions(noSkills)).toContainEqual({ type: "PLAYER_STAND" });
  });

  it("returns turns after skill-forced standing without firing voluntary Stand effects", () => {
    const forced = { id: "example-forced-stand", name: "示例强制停牌", description: "实际要牌后强制停牌", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
      rules: [{ id: "force", trigger: "after-hit-resolved", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "force-stand", target: "owner" }] }] };
    install([forced, onStand]);
    const state = gameReducer(fixture({ autoSkipAfterStand: false, playerAiSkills: [binding(forced.id), binding(onStand.id)] }), { type: "PLAYER_HIT" });
    expect(state.player.stood).toBe(true);
    expect(state.round.currentActor).toBe("opponent");
    const returned = gameReducer(state, { type: "OPPONENT_HIT" });
    expect(returned.round.currentActor).toBe("player");
    expect(gameReducer(returned, { type: "PLAYER_STAND" }).playerSkills.drawCount).toBe(0);
  });

  it("fires before-turn abilities when a stood player receives a new turn", () => {
    const beforeTurn = { ...onStand, id: "example-return-turn", rules: [{ id: "turn", trigger: "before-turn", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }] };
    install([beforeTurn]);
    const state = returnedPlayerTurn(fixture({ autoSkipAfterStand: false, playerAiSkills: [binding(beforeTurn.id)] }));
    expect(state.playerSkills.drawCount).toBe(1);
    const returned = gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "OPPONENT_HIT" });
    expect(returned.playerSkills.drawCount).toBe(2);
  });

  it("allows skipping to a stood player and bounds reciprocal skip chains", () => {
    const skip = { id: "example-stood-turn-skip", name: "示例跳过", description: "交给仍可行动的一方", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["example"], activation: { type: "automatic" },
      rules: [{ id: "skip", trigger: "before-turn", conditions: [{ type: "actor-is", actor: "owner" }, { type: "pending-turn-can-skip", target: "owner" }], effects: [{ type: "skip-turn", target: "owner" }] }] };
    install([skip]);
    const state = gameReducer(fixture({ autoSkipAfterStand: false, opponentAiSkills: [binding(skip.id)] }), { type: "PLAYER_STAND" });
    expect(state.round.currentActor).toBe("player");
    expect(state.player.stood).toBe(true);
    expect(state.history.at(-1)).toMatchObject({ type: "TURN_SKIPPED", actor: "opponent" });
    const reciprocal = fixture({ autoSkipAfterStand: false, playerAiSkills: [binding(skip.id)], opponentAiSkills: [binding(skip.id)] });
    const after = gameReducer(reciprocal, { type: "PLAYER_STAND" });
    expect(after.history.filter(event => event.type === "TURN_SKIPPED")).toHaveLength(2);
    expect(after.round.currentActor).toBe("opponent");
    expect(getLegalActions(after)).toContainEqual({ type: "AI_TURN" });
  });

  it("settles immediately once both have stood and never returns a stood AI turn", () => {
    const playerFirst = gameReducer(returnedPlayerTurn(), { type: "PLAYER_STAND" });
    const settled = gameReducer(playerFirst, { type: "OPPONENT_STAND" });
    expect(settled.round).toMatchObject({ phase: "round-reveal", currentActor: null });
    expect(settled.history.filter(event => event.type === "ROUND_RESOLVED")).toHaveLength(1);
    expect(gameReducer(settled, { type: "PLAYER_STAND" })).toBe(settled);
    const initial = fixture({ autoSkipAfterStand: false });
    const opponentFirst = gameReducer({ ...initial, round: { ...initial.round, currentActor: "opponent" } }, { type: "OPPONENT_STAND" });
    const afterHit = gameReducer(opponentFirst, { type: "PLAYER_HIT" });
    expect(afterHit.round.currentActor).toBe("player");
    expect(getLegalActions(afterHit)).not.toContainEqual({ type: "AI_TURN" });
    expect(gameReducer(afterHit, { type: "PLAYER_STAND" }).round.phase).toBe("round-reveal");
  });

  it("preserves the match snapshot through runtime serialization and defaults missing legacy fields", async () => {
    const state = returnedPlayerTurn();
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
    expect(restored.autoSkipAfterStand).toBe(false);
    expect(getLegalActions(restored)).toContainEqual({ type: "PLAYER_STAND" });
    expect(gameReducer(restored, { type: "PLAYER_HIT" })).toBe(restored);
    const legacy = fixture();
    delete (legacy as { autoSkipAfterStand?: boolean }).autoSkipAfterStand;
    const old = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(legacy)))).activeMatch!;
    expect(old).not.toHaveProperty("autoSkipAfterStand");
    expect(returnedPlayerTurn(old).round.currentActor).toBe("opponent");
    const save = createDefaultSave();
    expect(save.settings.autoSkipAfterStand).toBe(true);
    save.settings.autoSkipAfterStand = false;
    expect((await importSave(exportSaveJson(save))).settings.autoSkipAfterStand).toBe(false);
    delete save.settings.autoSkipAfterStand;
    expect(validateLongTermSave(save).settings).not.toHaveProperty("autoSkipAfterStand");
  });
});
