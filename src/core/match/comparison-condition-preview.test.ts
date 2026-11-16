import { afterEach, describe, expect, it } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../abilities/registry";
import type { AbilityRule, AiSkillAbilityDefinition } from "../abilities/types";
import { createCard } from "../blackjack/card";
import type { Rank } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { createMatch, gameReducer } from "./reducer";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));

function fixture(playerRanks: readonly Rank[], opponentRanks: readonly Rank[], extraRules: readonly AbilityRule[] = [], bonuses?: { player: number; opponent: number }) {
  const definition: AiSkillAbilityDefinition = {
    id: "example-comparison-decision", name: "比较决策", description: "中性比较预演夹具", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["example"], activation: { type: "automatic" },
    rules: [...extraRules,
      { id: "winning-stand", trigger: "before-ai-decision", conditions: [{ type: "actor-stood", target: "rival", expected: true }, { type: "comparison-would-win", target: "owner" }], effects: [{ type: "set-pending-ai-action", target: "owner", action: "stand" }] },
      { id: "not-winning-hit", trigger: "before-ai-decision", conditions: [{ type: "actor-stood", target: "rival", expected: true }, { type: "not", condition: { type: "comparison-would-win", target: "owner" } }], effects: [{ type: "set-pending-ai-action", target: "owner", action: "hit" }] }
    ]
  };
  installAbilityRegistry([...original.definitions, definition], [...original.statuses, {
    id: "example-live-score", defaultDuration: "round", rules: [{ id: "live-bonus", trigger: "before-round-resolution", effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 3 }] }]
  }], original.catalogVersion);
  const base = createMatch("comparison-condition-preview", { skillDeckIds: [], grantOpeningSkills: false, comparisonBonuses: bonuses, opponentAiSkills: [{ definitionId: definition.id, parameters: {}, enabled: true }] });
  const hand = (ranks: readonly Rank[], prefix: string) => ({ cards: ranks.map((rank, index) => createCard("clubs", rank, `${prefix}-${index}`)) });
  const player = { ...base.player, hand: hand(playerRanks, "player"), stood: true, busted: false, bustLimit: undefined };
  const opponent = { ...base.opponent, hand: hand(opponentRanks, "opponent"), stood: false, busted: false, bustLimit: undefined };
  const used = [...player.hand.cards, ...opponent.hand.cards];
  return { ...base, player, opponent, shoe: { cards: [...used, createCard("hearts", "2", "next"), createCard("spades", "3", "follow")], cursor: used.length, shuffleIndex: 1 },
    playerSkills: { ...base.playerSkills, drawOffer: null }, history: [{ type: "ROUND_STARTED" as const, roundIndex: base.roundIndex }],
    round: { ...base.round, player, opponent, currentActor: "opponent" as const, phase: "turns" as const, outcome: null }
  };
}

describe("discarded comparison previews for ability conditions", () => {
  it.each([
    [["10", "7"], ["10", "8"], "stand"],
    [["10", "8"], ["10", "8"], "hit"],
    [["10", "9"], ["10", "8"], "hit"]
  ] as const)("uses strict comparison for %s against %s", (player, opponent, expected) => {
    expect(gameReducer(fixture(player, opponent), { type: "AI_TURN" }).lastAiDecision?.actionOverride?.action).toBe(expected);
  });

  it("includes signed match comparison bonuses", () => {
    expect(gameReducer(fixture(["10", "10"], ["10", "8"], [], { player: 0, opponent: 3 }), { type: "AI_TURN" }).lastAiDecision?.actionOverride?.action).toBe("stand");
    expect(gameReducer(fixture(["10", "7"], ["10", "8"], [], { player: 3, opponent: 0 }), { type: "AI_TURN" }).lastAiDecision?.actionOverride?.action).toBe("hit");
  });

  it("uses A values under the live bust limit instead of the ordinary 21-point total", () => {
    const state = fixture(["10", "10"], ["A", "10", "3"], [{ id: "raised-limit", trigger: "before-bust-check", effects: [{ type: "add-to-pending-bust-limit", target: "event-actor", amount: 4 }] }]);
    const next = gameReducer(state, { type: "AI_TURN" });
    expect(next.lastAiDecision?.actionOverride?.action).toBe("stand");
    expect(next.round.outcome?.comparisonScores).toEqual({ player: 20, opponent: 24 });
  });

  it("reads a status created earlier in the same decision transaction", () => {
    const state = fixture(["10", "9"], ["10", "8"], [{ id: "gain-live-score", trigger: "before-ai-decision", priority: -10, effects: [{ type: "add-status", target: "owner", statusDefinitionId: "example-live-score" }] }]);
    const next = gameReducer(state, { type: "AI_TURN" });
    expect(next.lastAiDecision?.actionOverride?.action).toBe("stand");
    expect(next.round.outcome?.comparisonScores).toEqual({ player: 19, opponent: 21 });
    expect(state.abilities.statuses).toEqual([]);
  });

  it("does not spend counters or RNG, or publish comparison events during preview", () => {
    const state = fixture(["10", "9"], ["10", "8"], [{ id: "score-once", trigger: "before-round-resolution", chance: 1, limit: { perRound: 1 }, effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 2 }] }]);
    const snapshot = JSON.stringify(state);
    const expectedRng = SeededRng.fromSnapshot(state.abilities.rng); expectedRng.next();
    const next = gameReducer(state, { type: "AI_TURN" });
    expect(next.lastAiDecision?.actionOverride?.action).toBe("stand");
    expect(next.round.outcome?.comparisonScores).toEqual({ player: 19, opponent: 20 });
    expect(next.history.filter(event => event.type === "ABILITY_TRIGGERED" && event.ruleId === "score-once")).toHaveLength(1);
    expect(next.abilities.rng).toEqual(expectedRng.snapshot());
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("uses the pending comparison directly when the condition appears inside comparison rules", () => {
    const state = fixture(["10", "7"], ["10", "8"], [{ id: "winner-bonus", trigger: "before-round-resolution", conditions: [{ type: "comparison-would-win", target: "owner" }], effects: [{ type: "add-to-pending-comparison-score", target: "owner", amount: 1 }] }]);
    const next = gameReducer(state, { type: "AI_TURN" });
    expect(next.round.outcome?.comparisonScores).toEqual({ player: 17, opponent: 19 });
    expect(next.history.some(event => event.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
  });

  it("never calls an already busted owner a winner because of a large comparison bonus", () => {
    const state = fixture(["10", "8"], ["10", "10", "2"], [], { player: 0, opponent: 100 });
    const opponent = { ...state.opponent, busted: true };
    const next = gameReducer({ ...state, opponent, round: { ...state.round, opponent } }, { type: "AI_TURN" });
    expect(next.lastAiDecision?.actionOverride?.action).toBe("hit");
    expect(next.history.some(event => event.type === "ABILITY_TRIGGERED" && event.ruleId === "winning-stand")).toBe(false);
  });
});
