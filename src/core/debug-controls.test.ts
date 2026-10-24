import { afterEach, describe, expect, it } from "vitest";
import { createCard } from "./blackjack/card";
import { createMatch, gameReducer, getActiveBustLimit, previewComparisonScores } from "./match/reducer";
import type { MatchState } from "./match/types";
// @ts-expect-error The standalone package ships browser JavaScript.
import { debugInstance, debugValues, adjustDebug } from "../../public/characters/debug-engine/module.js";
type DebugEngineField = "playerAdvantage" | "aiAdvantage" | "publicBustLimit" | "playerBullets" | "aiBullets";
import { PLAYER_SKILL_DEFINITIONS, INITIAL_PLAYER_SKILL_IDS } from "./skills/definitions";
import { ABILITY_REGISTRY, installAbilityRegistry, instantiateAbility } from "./abilities/registry";
import { addAbilityInstance } from "./abilities/runtime";
import { addGunBullets, removeGunBullets } from "./abilities/roulette-adapter";
import { createDefaultSave, createRuntimeSave } from "../persistence/boot";
import { validateLongTermSave, validateRuntimeSave } from "../persistence/schema";

const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));

function fixture(enabled = true): MatchState {
  const base = createMatch("debug-controls", { opponentId: "chatgpt", skillDeckIds: [], intrinsicAbilities: enabled ? [{ definitionId: "builtin-debug-control", enabled: true, parameters: {} }] : [] });
  const cards = Array.from({ length: 52 }, (_, i) => createCard("spades", i === 0 || i === 2 ? "10" : i === 1 ? "7" : i === 3 ? "8" : "2", `debug-${i}`));
  const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, round: { ...base.round, player, opponent, phase: "turns", currentActor: "player", outcome: null }, history: [{ type: "ROUND_STARTED", roundIndex: 0 }] };
}
function adjust(state: MatchState, field: DebugEngineField, delta: number): MatchState {
  let current = state;
  adjustDebug({ getMatch: () => current, configureAbility: (binding: import("./abilities/types").AbilityBinding) => { current = gameReducer(current, { type: "CONFIGURE_INTRINSIC_ABILITY", binding }); }, invokeAbility: (definitionId: string, parameters: Record<string, number>) => { current = gameReducer(current, { type: "INVOKE_INTRINSIC_ABILITY", definitionId, parameters }); } }, field, delta);
  return current;
}
function nextRound(state: MatchState): MatchState {
  return gameReducer({ ...state, round: { ...state.round, phase: "round-reveal", outcome: { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 } } }, { type: "ACK_ROUND_RESULT" });
}

describe("built-in debug controls", () => {
  it("defaults off, rejects editing without an instance, and keeps the control out of normal acquisition", () => {
    const state = fixture(false);
    expect(debugInstance(state)).toBeUndefined();
    expect(adjust(state, "playerAdvantage", 10)).toBe(state);
    expect(PLAYER_SKILL_DEFINITIONS.every(definition => !definition.hidden)).toBe(true);
    expect(INITIAL_PLAYER_SKILL_IDS).not.toContain(debugInstance(fixture())?.definitionId);
    expect(fixture().playerSkills.cards).toEqual([]);
    expect(adjust(fixture(), "playerAdvantage", 100)).toEqual(fixture());
  });

  it("adds positive and negative comparison modifiers without changing bust status or random streams", () => {
    const before = fixture();
    const state = adjust(adjust(before, "playerAdvantage", 10), "aiAdvantage", -1);
    expect(previewComparisonScores(state)).toEqual({ baseScores: { player: 17, opponent: 18 }, scores: { player: 27, opponent: 17 } });
    expect(state.player.busted).toBe(false);
    expect(state.rng).toEqual(before.rng);
    expect(state.abilities.rng).toEqual(before.abilities.rng);
    const settled = gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "OPPONENT_STAND" });
    expect(settled.round.outcome?.comparisonScores).toEqual({ player: 27, opponent: 17 });
    expect(settled.round.outcome?.winner).toBe("player");
    const edited = adjust(settled, "aiAdvantage", 10);
    expect(edited.round.outcome).toEqual(settled.round.outcome);
  });

  it("stacks with ordinary skills for comparison and the shared bust limit", () => {
    installAbilityRegistry([...registry.definitions, {
      id: "neutral-adjustment", name: "示例修正", description: "通用叠加夹具", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["fixture"], activation: { type: "automatic" },
      rules: [
        { id: "score", trigger: "before-round-resolution", conditions: [{ type: "round-reason-is", value: "comparison" }], effects: [{ type: "add-to-pending-comparison-score", target: "rival", amount: 2 }] },
        { id: "limit", trigger: "before-bust-check", effects: [{ type: "add-to-pending-bust-limit", target: "event-actor", amount: 3 }] }
      ]
    }], registry.statuses, registry.catalogVersion);
    let state = fixture();
    state = { ...state, abilities: addAbilityInstance(state.abilities, instantiateAbility({ definitionId: "neutral-adjustment", enabled: true, parameters: {} }, "opponent", "neutral-instance", state.abilities.sequence + 1, undefined, "ai-skill")) };
    state = adjust(adjust(state, "playerAdvantage", -1), "publicBustLimit", 10);
    expect(previewComparisonScores(state).scores.player).toBe(18);
    expect(getActiveBustLimit(state, "player")).toBe(34);
    expect(getActiveBustLimit(state, "opponent")).toBe(34);
  });

  it("immediately checks lowered limits below 21, recovers bust flags, and clamps the configured limit", () => {
    let state = adjust(fixture(), "publicBustLimit", -10);
    expect(state.player.busted).toBe(true);
    expect(state.opponent.busted).toBe(true);
    expect(state.round.phase).toBe("turns");
    expect(state.player).toBe(state.round.player);
    state = adjust(state, "publicBustLimit", 10);
    expect(state.player.busted).toBe(false);
    expect(state.opponent.busted).toBe(false);
    state = adjust(adjust(adjust(state, "publicBustLimit", -10), "publicBustLimit", -10), "publicBustLimit", -10);
    expect(debugValues(state).publicBustLimit).toBe(1);
    expect(getActiveBustLimit(state, "player")).toBe(1);
  });

  it("preserves the original monotonic bust primitive unless decreasing is explicitly enabled", () => {
    const definition = {
      id: "neutral-limit-adjustment", name: "示例阈值", description: "通用边界夹具", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["fixture"], activation: { type: "automatic" },
      rules: [{ id: "limit", trigger: "before-bust-check", effects: [{ type: "add-to-pending-bust-limit", target: "event-actor", amount: -30 }] }]
    };
    installAbilityRegistry([...registry.definitions, definition], registry.statuses, registry.catalogVersion);
    let state = fixture(false);
    state = { ...state, abilities: addAbilityInstance(state.abilities, instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", "neutral-limit", 1, undefined, "ai-skill")) };
    expect(getActiveBustLimit(state, "player")).toBe(21);
    const signed = { ...definition, rules: [{ ...definition.rules[0], effects: [{ ...definition.rules[0].effects[0], allowDecrease: true }] }] };
    installAbilityRegistry([...registry.definitions, signed], registry.statuses, registry.catalogVersion);
    expect(getActiveBustLimit(state, "player")).toBe(1);
  });

  it("still commits bust checks for hands above 21 that a raised limit protects", () => {
    const base = fixture();
    const player = { ...base.player, hand: { cards: [createCard("spades", "10"), createCard("hearts", "8"), createCard("clubs", "5")] } };
    const state = adjust({ ...base, player, round: { ...base.round, player } }, "publicBustLimit", 10);
    expect(state.player).toMatchObject({ bustLimit: 31, busted: false });
    expect(state.player).toBe(state.round.player);
    expect(state.history.some(event => event.type === "ABILITY_TRIGGERED")).toBe(true);
    const scoreEdit = adjust(state, "playerAdvantage", 1);
    expect(scoreEdit.history).toEqual(state.history);
    expect(scoreEdit.abilities.rng).toEqual(state.abilities.rng);
    expect(scoreEdit.player.bustLimit).toBe(31);
  });

  it("adjusts both actual cylinders through effects, clamps bullets, and never replays edits on later actions", () => {
    let state = adjust(adjust(fixture(), "playerBullets", 10), "aiBullets", 1);
    expect(state.roulette.player.bullets).toBe(6);
    expect(state.roulette.opponent.bullets).toBe(1);
    const before = state;
    expect(adjust(state, "playerBullets", 1)).toBe(state);
    state = adjust(state, "playerBullets", -1);
    expect(state.roulette.player.bullets).toBe(5);
    expect(state.history.filter(event => event.type === "ABILITY_RESULT").at(-1)).toMatchObject({ type: "ABILITY_RESULT", result: { type: "gun-bullets-added", actor: "player", amount: -1, bullets: 5 } });
    expect(debugInstance(state)?.parameters.playerBulletDelta).toBe(0);
    state = adjust(state, "aiBullets", -10);
    expect(state.roulette.opponent.bullets).toBe(0);
    expect(state.rng).toEqual(before.rng);
    expect(validateRuntimeSave(createRuntimeSave(state)).activeMatch.roulette).toEqual(state.roulette);
    state = nextRound(state);
    expect(state.roulette.player.bullets).toBe(5);
    expect(state.roulette.opponent.bullets).toBe(0);
    expect(addGunBullets({ capacity: 6, bullets: 3 }, -2).bullets).toBe(3);
    expect(removeGunBullets({ capacity: 6, bullets: 3 }, -2).bullets).toBe(3);
    expect(removeGunBullets({ capacity: 6, bullets: 3 }, 10).bullets).toBe(0);
  });

  it("persists through round boundaries and runtime saves, then clears on disable, escape and match completion", () => {
    let state = adjust(adjust(adjust(fixture(), "playerAdvantage", -10), "publicBustLimit", 10), "playerBullets", 1);
    state = nextRound(state);
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch;
    expect(debugValues(restored)).toEqual(debugValues(state));
    state = gameReducer(restored, { type: "CONFIGURE_INTRINSIC_ABILITY", binding: { definitionId: "builtin-debug-control", enabled: false, parameters: {} } });
    expect(debugInstance(state)).toBeUndefined();
    expect(debugValues(state).publicBustLimit).toBe(21);
    expect(state.roulette.player.bullets).toBe(1);
    expect(debugInstance(gameReducer(restored, { type: "ESCAPE_MATCH" }))).toBeUndefined();
    const ready = adjust(fixture(), "aiBullets", 10);
    const fatal = gameReducer({ ...ready, round: { ...ready.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } } }, { type: "TRIGGER_ROULETTE" });
    expect(fatal.status).toBe("finished");
    expect(debugInstance(fatal)).toBeUndefined();
    expect(debugValues(fixture())).toMatchObject({ playerAdvantage: 0, aiAdvantage: 0, publicBustLimit: 21 });
  });

  it("accepts older settings without rewriting and round-trips only the persistent toggle in long-term saves", () => {
    const save = createDefaultSave();
    expect(validateLongTermSave(save).settings.debugEngineEnabled).toBeUndefined();
    const enabled = { ...save, settings: { ...save.settings, debugEngineEnabled: true } };
    expect(validateLongTermSave(JSON.parse(JSON.stringify(enabled))).settings).toEqual(enabled.settings);
    expect(enabled.settings).not.toHaveProperty("playerAdvantage");
  });
});
