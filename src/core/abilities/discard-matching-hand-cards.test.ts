import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard, isDerivedCard } from "../blackjack/card";
import type { PhysicalCard } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { applyEffects } from "./effects";
import { resolveAbilityEvent } from "./engine";
import { createStandaloneAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import type { AbilityInstance, AbilityWorld, AiSkillAbilityDefinition, Effect } from "./types";

const cards = [createCard("hearts", "2", "public"), createCard("hearts", "9", "private"), createCard("clubs", "3", "keep"), createDerivedCard("hearts", "8", "derived"), createCard("hearts", "K", "last")];
const ability: AbilityInstance = { kind: "ai-skill", definitionId: "neutral-bulk-discard", owner: "opponent", instanceId: "bulk-discard", parameters: {}, createdAtSequence: 1 };
const effect: Effect = { type: "discard-matching-hand-cards", target: "rival", attribute: "suit", equals: { type: "card-attribute", target: "rival", card: "first-public-card", attribute: "suit" }, exclude: ["first-public-card"] };
function fixture() {
  const rng = new SeededRng("bulk-discard");
  const world: AbilityWorld = { hands: { player: { cards }, opponent: { cards: [] } }, guns: { player: { bullets: 0, capacity: 6 }, opponent: { bullets: 0, capacity: 6 } }, shoe: { cards: cards.filter((card): card is PhysicalCard => !isDerivedCard(card)), cursor: 4, shuffleIndex: 0 }, cards: [], statuses: [], skillDraws: 0 };
  return { world, runtime: createAbilityRuntime(rng.snapshot()), ability, rng, event: { trigger: "after-card-draw" as const, sourceEventId: "draw" } };
}

describe("discarding matching hand cards", () => {
  it("removes every matching physical/derived card, preserves the public card and order, and emits normal discard events", () => {
    const context = fixture();
    const after = applyEffects([effect], context);
    expect(after.world.hands.player.cards).toEqual([cards[0], cards[2]]);
    expect(after.world.hands.opponent).toBe(context.world.hands.opponent);
    expect(after.world.shoe).toBe(context.world.shoe);
    expect(after.runtime.rng).toEqual(context.runtime.rng);
    expect(after.events).toEqual([1, 3, 4].map(i => ({ type: "HAND_CARD_DISCARDED", actor: "player", cardId: cards[i].id })));
    expect(context.world.hands.player.cards).toEqual(cards);
  });
  it("resolves selectors against the original positions, including a selected card that would otherwise disappear", () => {
    const after = applyEffects([{ ...effect, exclude: ["first-private-card", "last-card"] }], fixture());
    expect(after.world.hands.player.cards).toEqual([cards[1], cards[2], cards[4]]);
  });
  it.each(["rank", "source", "id"] as const)("supports matching %s against a typed card observation", attribute => {
    const after = applyEffects([{ ...effect, attribute, equals: { type: "card-attribute", target: "rival", card: "last-card", attribute }, exclude: [] }], fixture());
    expect(after.world.hands.player.cards.some(card => card.id === cards[4].id)).toBe(false);
    expect(after.world.shoe).toEqual(fixture().world.shoe);
  });
  it("does nothing for no matches or an empty hand without consuming random state", () => {
    for (const context of [fixture(), { ...fixture(), world: { ...fixture().world, hands: { player: { cards: [] }, opponent: { cards: [] } } } }]) {
      const after = applyEffects([{ ...effect, equals: { type: "literal", value: "spades" } }], context);
      expect(after.world).toBe(context.world);
      expect(after.events).toEqual([]);
      expect(after.runtime.rng).toEqual(context.runtime.rng);
    }
  });
  it("validates the new effect and rolls back the whole rule if a later effect fails", () => {
    const definition: AiSkillAbilityDefinition = { id: ability.definitionId, name: "Neutral bulk discard", description: "Neutral bulk discard", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["neutral"], activation: { type: "automatic" }, rules: [{ id: "bulk-discard", trigger: "after-card-draw", limit: { perRound: 1 }, effects: [effect, { type: "discard-hand-card", target: "owner", card: "last-card" }] }] };
    const registry = createStandaloneAbilityRegistry([definition], []);
    const context = fixture();
    const runtime = addAbilityInstance(context.runtime, instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", ability.instanceId, 1, registry, "ai-skill"), registry);
    expect(() => resolveAbilityEvent({ ...context, runtime, registry })).toThrow("unavailable");
    expect(runtime.counters).toEqual({});
    expect(context.world).toEqual(fixture().world);
  });
});
