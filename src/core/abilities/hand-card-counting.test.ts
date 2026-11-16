import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard, EXCLUDED_FROM_POINT_TOTAL_TAG } from "../blackjack/card";
import { handValue } from "../blackjack/hand";
import { SeededRng } from "../rng/seeded";
import { applyEffects } from "./effects";
import { resolveAbilityEvent } from "./engine";
import { createStandaloneAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import type { AbilityInstance, AbilityWorld, Effect } from "./types";

const effect: Effect = { type: "set-matching-hand-cards-counted", target: "rival", attribute: "source", equals: { type: "literal", value: "derived" }, counted: false };
function fixture() {
  const cards = [createCard("clubs", "K", "physical"), createDerivedCard("hearts", "A", "derived-ace"), createDerivedCard("spades", "K", "derived-king")];
  const world: AbilityWorld = { hands: { player: { cards }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [cards[0] as ReturnType<typeof createCard>], cursor: 1, shuffleIndex: 0 }, cards: [], statuses: [], skillDraws: 0 };
  const ability: AbilityInstance = { definitionId: "counting", instanceId: "counting", kind: "ai-skill", owner: "opponent", createdAtSequence: 1, parameters: {} };
  const rng = new SeededRng("counting");
  return { world, ability, rng, runtime: createAbilityRuntime(rng.snapshot()), event: { trigger: "after-hand-changed" as const, sourceEventId: "changed" } };
}

describe("matching hand-card point counting", () => {
  it("excludes only matching original cards from totals while retaining all face and identity facts", () => {
    const input = fixture();
    expect(handValue(input.world.hands.player)).toBe(21);
    const after = applyEffects([effect], input);
    expect(handValue(after.world.hands.player)).toBe(10);
    expect(after.world.hands.player.cards.map(card => [card.id, card.attributes])).toEqual(input.world.hands.player.cards.map(card => [card.id, card.attributes]));
    expect(after.world.hands.player.cards[0]).toBe(input.world.hands.player.cards[0]);
    expect(after.world.hands.player.cards.slice(1).every(card => card.tags.includes(EXCLUDED_FROM_POINT_TOTAL_TAG))).toBe(true);
    expect(after.world.shoe).toBe(input.world.shoe);
    expect(after.events).toEqual([]);
    expect(after.runtime.rng).toEqual(input.runtime.rng);
    expect(input.world.hands.player.cards.every(card => !card.tags.includes(EXCLUDED_FROM_POINT_TOTAL_TAG))).toBe(true);
  });

  it("restores normal counting through the same neutral boolean operation", () => {
    const input = fixture();
    const excluded = applyEffects([effect], input);
    const restored = applyEffects([{ ...effect, counted: true }], { ...input, world: excluded.world, runtime: excluded.runtime });
    expect(restored.world.hands.player.cards).toEqual(input.world.hands.player.cards);
    expect(handValue(restored.world.hands.player)).toBe(21);
  });

  it.each(["rank", "suit", "id"] as const)("filters by %s using typed card observations", attribute => {
    const input = fixture();
    const after = applyEffects([{ ...effect, attribute, equals: { type: "card-attribute", target: "rival", card: "last-card", attribute } }], input);
    const matching = input.world.hands.player.cards.filter(card => (attribute === "id" ? card.id : card.attributes[attribute]) === (attribute === "id" ? "derived-king" : attribute === "rank" ? "K" : "spades"));
    expect(after.world.hands.player.cards.filter(card => card.tags.includes(EXCLUDED_FROM_POINT_TOTAL_TAG)).map(card => card.id)).toEqual(matching.map(card => card.id));
  });

  it("preserves the world on an empty, nonmatching, or already excluded selection", () => {
    const input = fixture();
    const absent = applyEffects([{ ...effect, equals: { type: "literal", value: "absent" } }], input);
    expect(absent.world).toBe(input.world);
    const excluded = applyEffects([effect], input);
    const repeated = applyEffects([effect], { ...input, world: excluded.world, runtime: excluded.runtime });
    expect(repeated.world).toBe(excluded.world);
    expect(repeated.runtime.rng).toEqual(input.runtime.rng);
  });

  it("rolls back exclusion, counters and RNG when a later effect fails", () => {
    const input = fixture();
    const definition = { id: "counting", name: "Counting", description: "Neutral counting transaction", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["neutral"], activation: { type: "automatic" }, rules: [{ id: "exclude", trigger: "after-hand-changed", limit: { perRound: 1 }, effects: [effect, { type: "discard-hand-card", target: "owner", card: "last-card" }] }] };
    const registry = createStandaloneAbilityRegistry([definition], []);
    const runtime = addAbilityInstance(input.runtime, instantiateAbility({ definitionId: "counting", enabled: true, parameters: {} }, "opponent", "counting", 1, registry, "ai-skill"), registry);
    const before = JSON.stringify({ world: input.world, runtime });
    expect(() => resolveAbilityEvent({ ...input, runtime, registry })).toThrow("unavailable");
    expect(JSON.stringify({ world: input.world, runtime })).toBe(before);
  });
});
