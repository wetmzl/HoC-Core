import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import { resolveScalar } from "../abilities/conditions";
import type { AbilityRule, ScalarValue } from "../abilities/types";
import { createCard } from "../blackjack/card";
import type { Rank } from "../blackjack/types";
import { createHand } from "../blackjack/hand";
import { abilityWorld, createMatch, gameReducer, previewComparisonScores, resolveRound } from "./reducer";
import type { MatchState } from "./types";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));

function setup(rules: readonly AbilityRule[] = [], playerRanks: readonly Rank[] = ["10", "8"], opponentRanks: readonly Rank[] = ["10", "8"]) {
  const definition = { id: "example-score-observer", name: "Score observer", description: "Neutral score snapshot fixture", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["score"], activation: { type: "automatic" }, rules };
  installAbilityRegistry([...original.definitions, definition], [...original.statuses, { id: "example-score-memory", defaultDuration: "match", rules: [] }], original.catalogVersion);
  const base = createMatch("point-advantage", { opponentId: "claude", skillDeckIds: [], comparisonBonuses: { player: 3, opponent: -1 }, opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }] });
  const hand = (ranks: readonly Rank[], prefix: string) => createHand(ranks.map((rank, i) => createCard("clubs", rank, `${prefix}-${i}`)));
  const player = { ...base.player, hand: hand(playerRanks, "p"), stood: true, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: hand(opponentRanks, "o"), stood: true, busted: false, bustLimit: undefined };
  return { ...base, player, opponent, round: { ...base.round, phase: "turns" as const, player, opponent, currentActor: null, outcome: null } };
}

const outcome = { reason: "comparison" as const, winner: "player" as const, penaltyTarget: "opponent" as const, bulletsAdded: 1 };
const previous: ScalarValue = { type: "round-point-advantage", target: "rival", round: "previous" };

describe("signed round point advantage snapshots", () => {
  it("captures base bonuses plus every applied positive and negative modifier", () => {
    const state = setup([{ id: "decrease", trigger: "before-round-resolution", effects: [{ type: "add-to-pending-comparison-score", target: "rival", amount: -6 }] }]);
    const settled = resolveRound(state, outcome);
    expect(settled.round.outcome?.pointAdvantages).toEqual({ player: -3, opponent: -1 });
    expect(settled.round.outcome?.comparisonScores).toEqual({ player: 15, opponent: 17 });
    const saved = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(settled)))).activeMatch!;
    expect(saved.round.outcome?.pointAdvantages).toEqual({ player: -3, opponent: -1 });
  });

  it("uses the actual effective A base instead of subtracting ordinary hand-total", () => {
    const state = setup([{ id: "limit", trigger: "before-bust-check", effects: [{ type: "add-to-pending-bust-limit", target: "event-actor", amount: 4 }] }], ["A", "10", "3"], ["10", "8"]);
    const settled = resolveRound(state, outcome);
    expect(settled.round.outcome?.comparisonScores?.player).toBe(27);
    expect(settled.round.outcome?.pointAdvantages?.player).toBe(3);
  });

  it.each(["blackjack", "bust", "push"] as const)("records zero for %s without a point comparison", reason => {
    const settled = resolveRound(setup(), { winner: null, reason, penaltyTarget: null, bulletsAdded: 0 });
    expect(settled.round.outcome?.pointAdvantages ?? { player: 0, opponent: 0 }).toEqual({ player: 0, opponent: 0 });
  });

  it.each([["half", -1], ["double", -6]] as const)("carries signed values into next round's %s formula and save", (mode, expected) => {
    const amount: ScalarValue = mode === "half" ? { type: "ceil", value: { type: "divide", left: previous, right: 2 } } : { type: "multiply", left: previous, right: 2 };
    const initial = setup([{ id: "mirror", trigger: "before-round-resolution", effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount }] }]);
    const settled = resolveRound({ ...initial, comparisonBonuses: { player: -3, opponent: 0 } }, outcome);
    const noPenalty: MatchState = { ...settled, round: { ...settled.round, phase: "round-reveal", outcome: { ...settled.round.outcome!, winner: null, penaltyTarget: null, bulletsAdded: 0 } } };
    const next = gameReducer(noPenalty, { type: "ACK_ROUND_RESULT" });
    expect(next.previousRoundPointAdvantages).toEqual({ player: -3, opponent: 0 });
    const saved = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(next)))).activeMatch!;
    expect(saved.previousRoundPointAdvantages).toEqual(next.previousRoundPointAdvantages);
    const before = JSON.stringify(saved);
    const preview = previewComparisonScores({ ...saved, round: { ...saved.round, phase: "turns", outcome: null } });
    expect(preview.scores.opponent - preview.baseScores.opponent).toBe(expected);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("reads same-rule comparison changes from the updated pending transaction", () => {
    const state = setup([{ id: "change-and-observe", trigger: "before-round-resolution", effects: [
      { type: "add-to-pending-comparison-score", target: "rival", amount: -6 },
      { type: "assign-status-values", target: "owner", statusDefinitionId: "example-score-memory", values: { ["value"]: { type: "numeric", value: { type: "round-point-advantage", target: "rival", round: "current" } } } }
    ] }]);
    const settled = resolveRound(state, outcome);
    expect(settled.abilities.statuses.find(status => status.statusDefinitionId === "example-score-memory")?.parameters.value).toBe(-3);
  });

  it("rolls back overflowing score transactions before publishing a snapshot", () => {
    const state = setup([{ id: "overflow", trigger: "before-round-resolution", effects: [
      { type: "add-to-pending-comparison-score", target: "rival", amount: 1e308 },
      { type: "add-to-pending-comparison-score", target: "rival", amount: 1e308 }
    ] }]);
    const settled = resolveRound(state, outcome);
    expect(settled.round.outcome?.pointAdvantages).toEqual({ player: 3, opponent: -1 });
    expect(settled.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED" && event.reason.includes("not finite"))).toBe(true);
    expect(() => validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(settled))))).not.toThrow();
  });

  it("exposes the running comparison modifier after earlier rules and zero before any history", () => {
    const state = setup([
      { id: "subtract", trigger: "before-round-resolution", priority: -1, effects: [{ type: "add-to-pending-comparison-score", target: "rival", amount: -6 }] },
      { id: "observe", trigger: "before-round-resolution", effects: [{ type: "assign-status-values", target: "owner", statusDefinitionId: "example-score-memory", values: { ["value"]: { type: "numeric", value: { type: "round-point-advantage", target: "rival", round: "current" } } } }] }
    ]);
    expect(resolveScalar(previous, { world: abilityWorld(state), ability: state.abilities.instances[0], event: { trigger: "before-turn", sourceEventId: "first" } })).toBe(0);
    const settled = resolveRound(state, outcome);
    expect(settled.abilities.statuses.find(status => status.statusDefinitionId === "example-score-memory")?.parameters.value).toBe(-3);
  });
});
