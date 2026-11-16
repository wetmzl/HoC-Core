import { describe, expect, it, vi } from "vitest";
import { createCard } from "../blackjack/card";
import type { Rank } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { evaluateCondition, type ConditionContext } from "./conditions";
import { createAbilityRuntime } from "./runtime";
import type { AbilityInstance, AbilityWorld } from "./types";

const ability: AbilityInstance = { instanceId: "neutral-condition", definitionId: "neutral-condition", owner: "opponent", kind: "ai-skill", parameters: {}, createdAtSequence: 1 };
function context(): ConditionContext {
  const world: AbilityWorld = {
    hands: { player: { cards: [createCard("clubs", "2", "transfer")] }, opponent: { cards: [createCard("hearts", "10", "ten"), createCard("spades", "9", "nine")] } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], statuses: [], skillDraws: 0,
    stood: { player: true, opponent: false }
  };
  return { world, ability, event: { trigger: "before-ai-decision", sourceEventId: "decision", eventActor: "opponent" }, bustLimitFor: () => 21 };
}

describe("neutral stand and projected-comparison conditions", () => {
  it.each<{ ranks: Rank[]; limit: number; busted: boolean }>([
    { ranks: ["A", "9"], limit: 15, busted: false },
    { ranks: ["A", "9", "7"], limit: 15, busted: true },
    { ranks: ["A", "10", "10"], limit: 31, busted: false },
    { ranks: ["10", "10", "10", "2"], limit: 31, busted: true }
  ])("checks the live bust limit $limit with Ace scoring for $ranks", ({ ranks, limit, busted }) => {
    const initial = context();
    const input = { ...initial, world: { ...initial.world, hands: { ...initial.world.hands,
      opponent: { cards: ranks.map((rank, i) => createCard("spades", rank, `bust-${i}`)) }
    } }, bustLimitFor: () => limit };
    const snapshot = structuredClone(input.world);
    expect(evaluateCondition({ type: "hand-is-busted", target: "owner" }, input)).toBe(busted);
    expect(evaluateCondition({ type: "hand-is-busted", target: "status-owner" }, input)).toBe(false);
    expect(input.world).toEqual(snapshot);
    expect(() => evaluateCondition({ type: "hand-is-busted", target: "owner" }, { ...input, bustLimitFor: undefined })).toThrow("bust limit service");
  });

  it("reads actual stood state through actor selectors without treating absent state as false", () => {
    const input = context();
    expect(evaluateCondition({ type: "actor-stood", target: "rival", expected: true }, input)).toBe(true);
    expect(evaluateCondition({ type: "actor-stood", target: "owner", expected: false }, input)).toBe(true);
    expect(evaluateCondition({ type: "actor-stood", target: "rival", expected: false }, input)).toBe(false);
    expect(evaluateCondition({ type: "actor-stood", target: "owner", expected: false }, { ...input, world: { ...input.world, stood: undefined } })).toBe(false);
    expect(evaluateCondition({ type: "actor-stood", target: "status-owner", expected: true }, input)).toBe(false);
  });

  it.each([
    [18, 19, false, false, true],
    [19, 19, false, false, false],
    [20, 19, false, false, false],
    [18, 30, false, true, false],
    [30, 18, true, false, true],
    [30, 31, true, true, false]
  ] as const)("compares scores %i/%i with busted flags %s/%s", (player, opponent, playerBusted, opponentBusted, expected) => {
    const input = { ...context(), previewComparison: () => ({ scores: { player, opponent }, busted: { player: playerBusted, opponent: opponentBusted } }) };
    expect(evaluateCondition({ type: "comparison-would-win", target: "owner" }, input)).toBe(expected);
  });

  it("passes the live runtime and pending comparison to the discarded projection service", () => {
    const runtime = createAbilityRuntime(new SeededRng("condition").snapshot());
    const pendingComparison = { id: "live", scores: { player: 18, opponent: 19 } };
    const previewComparison = vi.fn(() => ({ scores: pendingComparison.scores, busted: { player: false, opponent: false } }));
    const initial = context(), input = { ...initial, runtime, previewComparison, event: { ...initial.event, pendingComparison } };
    expect(evaluateCondition({ type: "comparison-would-win", target: "owner" }, input)).toBe(true);
    expect(previewComparison).toHaveBeenCalledWith(input.world, runtime, pendingComparison);
    expect(() => evaluateCondition({ type: "comparison-would-win", target: "owner" }, initial)).toThrow("comparison preview service");
    expect(evaluateCondition({ type: "comparison-would-win", target: "status-owner" }, initial)).toBe(false);
  });

  it("uses the same projected transfer selection as the transfer effect", () => {
    const initial = context();
    const condition = { type: "hand-transfer-candidate-exists", from: "rival", target: "owner", candidate: "reaches-bust-limit" } as const;
    expect(evaluateCondition(condition, initial)).toBe(true);
    expect(evaluateCondition(condition, { ...initial, bustLimitFor: () => 22 })).toBe(false);
    expect(evaluateCondition({ ...condition, from: "owner" }, initial)).toBe(false);
    expect(evaluateCondition({ ...condition, from: "status-owner" }, initial)).toBe(false);
    expect(() => evaluateCondition(condition, { ...initial, bustLimitFor: undefined })).toThrow("bust limit service");
  });
});
