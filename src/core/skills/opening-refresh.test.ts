import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import { createMatch, gameReducer, getLegalActions, resolveRound } from "../match/reducer";
import type { MatchState } from "../match/types";
import { PLAYER_SKILL_DEFINITIONS } from "./definitions";
import { unlockedTalentIdsForDefeats } from "../talents/definitions";
import { createDefaultSave, createRuntimeSave } from "../../persistence/boot";
import { validateLongTermSave, validateRuntimeSave } from "../../persistence/schema";
import { createCard } from "../blackjack/card";

const registry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(registry.definitions, registry.statuses, registry.catalogVersion));
const talents = ["early-preparation", "resilient-spirit", "second-chance", "well-prepared"];
const active = PLAYER_SKILL_DEFINITIONS.find(s => s.category === "active" && s.drop.enabled)!;
const passive = PLAYER_SKILL_DEFINITIONS.find(s => s.category === "passive" && !s.stackable && s.drop.enabled)!;
function ready(talentIds = ["second-chance"]): MatchState {
  const base = createMatch("refresh", { opponentId: "llama", talentIds, skillDeckIds: [active.id] });
  return { ...base, playerSkills: { ...base.playerSkills, drawCount: 2 }, round: { ...base.round, currentActor: "player", phase: "turns" } };
}
function open(state = ready()) { return gameReducer(state, { type: "OPEN_SKILL_DRAW" }); }
const refresh = { type: "REFRESH_SKILL_DRAW" } as const;

describe("opening skill cards and official talents", () => {
  it("deals three skill cards once, using only the carried pool and permitting active duplicates", () => {
    const match = ready([]);
    expect(match.playerSkills.cards.map(c => c.definitionId)).toEqual([active.id, active.id, active.id]);
    const next = gameReducer(resolveRound(match, { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 }), { type: "ACK_ROUND_RESULT" });
    expect(next.roundIndex).toBe(1);
    expect(next.playerSkills.cards).toEqual(match.playerSkills.cards);
  });
  it("keeps opening draws separate and cumulatively applies all four talents", () => {
    const base = createMatch("opening", { opponentId: "llama", talentIds: talents, skillDeckIds: [active.id] });
    expect(base.playerSkills.cards).toHaveLength(4);
    expect(base.playerSkills.drawCount).toBe(1);
    expect(base.playerSkills.refreshesPerDraw).toBe(1);
    expect(base.player.hand.cards).toHaveLength(2);
    expect(base.opponent.hand.cards).toHaveLength(2);
    expect(createMatch("opening", { opponentId: "llama", skillDeckIds: [active.id] }).playerSkills.drawCount).toBe(0);
  });
  it("stops at an exhausted pool and never duplicates non-stackable passives", () => {
    const match = createMatch("one-passive", { skillDeckIds: [passive.id] });
    expect(match.playerSkills.cards.map(c => c.definitionId)).toEqual([passive.id]);
    expect(createMatch("empty", { skillDeckIds: [] }).playerSkills.cards).toEqual([]);
  });
  it("runs acquisition effects for each opening card and replays all random state", () => {
    const skill = registry.definitions.find(d => d.id === active.id)!;
    installAbilityRegistry(registry.definitions.map(d => d.id === active.id ? { ...skill, rules: [{ id: "gained", trigger: "on-ability-gained", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }] } : d), registry.statuses, registry.catalogVersion);
    const options = { opponentId: "llama", skillDeckIds: [active.id] };
    const match = createMatch("gain-effect", options);
    expect(match.playerSkills.drawCount).toBe(3);
    expect(match.history.filter(e => e.type === "SKILL_GAINED")).toHaveLength(3);
    expect(createMatch("gain-effect", options)).toEqual(match);
  });
  it("uses the final loss outcome and rewards only once per round", () => {
    const match = ready(["resilient-spirit"]);
    const loss = { winner: "opponent", reason: "comparison", penaltyTarget: "player", bulletsAdded: 1 } as const;
    for (const reason of ["comparison", "bust", "blackjack"] as const) {
      expect(resolveRound(match, { ...loss, reason }).playerSkills.drawCount - match.playerSkills.drawCount).toBe(2);
    }
    const after = resolveRound(match, loss);
    expect(after.playerSkills.drawCount - match.playerSkills.drawCount).toBe(2);
    expect(gameReducer(after, { type: "ACK_ROUND_RESULT" }).playerSkills.drawCount).toBe(after.playerSkills.drawCount);
    // Even duplicate dispatch of the settlement event cannot trigger the talent twice.
    expect(resolveRound(after, loss).playerSkills.drawCount - after.playerSkills.drawCount).toBe(1);
    for (const winner of ["player", null] as const) {
      const settled = resolveRound(match, { winner, reason: winner ? "comparison" : "push", penaltyTarget: winner ? "opponent" : null, bulletsAdded: winner ? 1 : 0 });
      expect(settled.playerSkills.drawCount - match.playerSkills.drawCount).toBe(1);
    }
    const next = gameReducer(resolveRound(match, { winner: null, reason: "push", penaltyTarget: null, bulletsAdded: 0 }), { type: "ACK_ROUND_RESULT" });
    expect(resolveRound(next, loss).playerSkills.drawCount - next.playerSkills.drawCount).toBe(2);
  });
  it("does not award a loss talent for a provisional loss changed by comparison abilities", () => {
    // Use the built-in debug ability through its public parameters to change final comparison totals.
    const base = createMatch("final-result", { opponentId: "llama", talentIds: ["resilient-spirit"], skillDeckIds: [], intrinsicAbilities: [{ definitionId: "builtin-debug-control", enabled: true, parameters: { playerAdvantage: 10 } }] });
    const player = { ...base.player, hand: { cards: [createCard("spades", "10", "p1"), createCard("hearts", "5", "p2")] } };
    const opponent = { ...base.opponent, hand: { cards: [createCard("spades", "10", "o1"), createCard("hearts", "8", "o2")] } };
    const state = { ...base, player, opponent, round: { ...base.round, player, opponent, currentActor: "player" as const } };
    const result = gameReducer(gameReducer(state, { type: "PLAYER_STAND" }), { type: "OPPONENT_STAND" });
    expect(result.round.outcome?.winner).toBe("player");
    expect(result.playerSkills.drawCount).toBe(1);
  });
  it("unlocks cumulatively at 1/3/5/7 distinct defeats without counting rematches", () => {
    const ids = ["well-prepared", "resilient-spirit", "second-chance", "early-preparation"];
    for (let count = 0; count <= 8; count++) {
      const defeats = Array.from({ length: count }, (_, i) => ({ opponentId: `example-${i}`, timestamp: "2026-10-15T00:00:00Z" }));
      const unlocked = unlockedTalentIdsForDefeats([...defeats, ...defeats]);
      expect(unlocked).toHaveLength([1, 3, 5, 7].filter(n => n <= count).length);
      expect(unlocked.every(id => ids.includes(id))).toBe(true);
    }
    expect(validateLongTermSave(createDefaultSave()).schemaVersion).toBe(9);
  });
});

describe("per-offer refresh budget", () => {
  it("consumes a refresh, allows identical candidates, preserves draws and resets for the next offer", () => {
    const start = open();
    expect(start.playerSkills.drawOffer?.refreshesRemaining).toBe(1);
    expect(getLegalActions(start)).toContainEqual(refresh);
    const after = gameReducer(start, refresh);
    expect(after.playerSkills.drawOffer?.candidateDefinitionIds).toEqual(start.playerSkills.drawOffer?.candidateDefinitionIds);
    expect(after.playerSkills.drawOffer?.refreshesRemaining).toBe(0);
    expect(after.playerSkills.drawCount).toBe(start.playerSkills.drawCount);
    expect(after.rng.loot).not.toEqual(start.rng.loot);
    expect(after.playerSkills.cards).toEqual(start.playerSkills.cards);
    expect(getLegalActions(after)).not.toContainEqual(refresh);
    expect(gameReducer(after, refresh)).toBe(after);
    const selected = gameReducer(after, { type: "SELECT_SKILL_DRAW", definitionId: active.id });
    expect(selected.playerSkills.drawCount).toBe(1);
    expect(open(selected).playerSkills.drawOffer?.refreshesRemaining).toBe(1);
    expect(gameReducer(open(), refresh)).toEqual(after);
  });
  it("supports arbitrary per-draw budgets and rejects invalid refreshes without changing RNG", () => {
    const state = ready();
    let current = open({ ...state, playerSkills: { ...state.playerSkills, refreshesPerDraw: 2 } });
    current = gameReducer(current, refresh);
    expect(current.playerSkills.drawOffer?.refreshesRemaining).toBe(1);
    current = gameReducer(current, refresh);
    expect(current.playerSkills.drawOffer?.refreshesRemaining).toBe(0);
    for (const invalid of [ready(), open(ready([])), { ...open(), status: "finished" as const }, { ...open(), round: { ...state.round, currentActor: "opponent" as const } }]) {
      expect(gameReducer(invalid, refresh)).toBe(invalid);
    }
  });
  it("roundtrips candidates, history, RNG and spent budget without refilling on reload", () => {
    const state = gameReducer(open(), refresh);
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(state)))).activeMatch!;
    expect(restored).toEqual(state);
    const corrupt = { ...state, playerSkills: { ...state.playerSkills, drawOffer: { ...state.playerSkills.drawOffer!, refreshesRemaining: 2 } } };
    expect(() => createRuntimeSave(corrupt)).toThrow();
    expect(gameReducer(restored, refresh)).toBe(restored);
    expect(() => validateRuntimeSave(createRuntimeSave({ ...state, abilities: { ...state.abilities, catalogVersion: "abilities-v39" } }))).toThrow();
  });
});
