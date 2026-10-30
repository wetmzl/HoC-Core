import { describe, expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import { createHand, handValueAtLimit } from "../blackjack/hand";
import type { Rank } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { applyEffect } from "./effects";
import { createAbilityRuntime } from "./runtime";
import type { AbilityInstance, AbilityWorld, Effect } from "./types";

const effect: Effect = { type: "acquire-card", target: "rival", reveal: true, choices: [{ source: "derived", candidate: { type: "resulting-hand-total-exactly", value: { type: "bust-limit", target: "rival" } }, evaluationLimit: { type: "bust-limit", target: "rival" }, pick: "uniform-ability-rng" }, { source: "derived", rank: { type: "static", rank: "A" }, suit: { type: "uniform-ability-rng" } }] };
function run(ranks: Rank[], limit = 21, empty = false) {
  const rng = new SeededRng("derived-limit");
  const world: AbilityWorld = { hands: { player: createHand(), opponent: createHand(ranks.map((rank, i) => createCard("clubs", rank, `held-${i}`))) },
    shoe: { cards: empty ? [] : [createCard("hearts", "8", "shoe-eight")], cursor: 0, shuffleIndex: 0 },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, cards: [], skillDraws: 0, statuses: [] };
  const ability = { definitionId: "neutral-derived-limit", instanceId: "neutral", owner: "player", parameters: {}, createdAtSequence: 1 } as AbilityInstance;
  const result = applyEffect(effect, { world, ability, rng, runtime: createAbilityRuntime(rng.snapshot()),
    event: { trigger: "on-ability-played", sourceEventId: "neutral-play" }, bustLimitFor: () => limit });
  return { world, result };
}
describe("derived card to effective limit", () => {
  it.each([false, true])("creates an exact derived card without consuming the shoe (empty=%s)", empty => {
    const { world, result } = run(["10", "3"], 21, empty);
    expect(result.world.hands.opponent.cards.at(-1)?.attributes).toMatchObject({ rank: "8", source: "derived" });
    expect(result.world.shoe).toBe(world.shoe);
    expect(result.events).toContainEqual(expect.objectContaining({ type: "CARD_DEALT", actor: "opponent", private: false }));
    expect(world.hands.opponent.cards).toHaveLength(2);
  });
  it.each([["2", "3"], ["K", "Q", "5"]] as Rank[][])("uses the configured fallback when no single rank reaches the limit: %j", (...ranks) => {
    const { world, result } = run(ranks);
    expect(result.world.hands.opponent.cards.at(-1)?.attributes).toMatchObject({ rank: "A", source: "derived" });
    expect(result.world.shoe).toBe(world.shoe);
  });
  it("uses modified limits including a soft ace above 21, and replays deterministically", () => {
    const first = run(["A", "K"], 25);
    expect(first.result.world.hands.opponent.cards.at(-1)?.attributes.rank).toBe("4");
    expect(handValueAtLimit(first.result.world.hands.opponent, 25)).toBe(25);
    expect(run(["A", "K"], 25).result).toEqual(first.result);
  });
});
