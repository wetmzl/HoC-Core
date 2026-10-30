import { describe, expect, it } from "vitest";
import { createMatch, gameReducer } from "../match/reducer";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";
import { createCard, createDerivedCard } from "../blackjack/card";
import { SeededRng } from "../rng/seeded";
import { applyEffects } from "./effects";
import { resolveAbilityEvent } from "./engine";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, installAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import type { AbilityInstance, AbilityWorld, AiSkillAbilityDefinition, CardSelector } from "./types";

const cards = [createCard("clubs", "2", "public"), createCard("hearts", "9", "private"), createCard("spades", "K", "last")];
const instance: AbilityInstance = { kind: "ai-skill", definitionId: "neutral-discard", owner: "opponent", instanceId: "discard", parameters: {}, createdAtSequence: 1 };
function world(): AbilityWorld {
  return { hands: { player: { cards }, opponent: { cards: [] } },
    guns: { player: { bullets: 0, capacity: 6 }, opponent: { bullets: 0, capacity: 6 } },
    shoe: { cards: [...cards, createCard("diamonds", "4", "next")], cursor: 3, shuffleIndex: 0 },
    cards: [], statuses: [], skillDraws: 0 };
}
function discard(initial: AbilityWorld, card: CardSelector) {
  const rng = new SeededRng("discard");
  return applyEffects([{ type: "discard-hand-card", target: "rival", card }], {
    world: initial, runtime: createAbilityRuntime(rng.snapshot()), ability: instance, rng,
    event: { trigger: "after-card-draw", sourceEventId: "hit", eventActor: "player" }
  });
}
describe("discarding a hand card", () => {
  it.each([["first-public-card", 0], ["first-private-card", 1], ["last-card", 2]] as const)("discards only %s without returning it to the pile", (selector, index) => {
    const before = world(), after = discard(before, selector);
    expect(after.world.hands.player.cards).toEqual(cards.filter((_, i) => i !== index));
    expect(after.world.hands.opponent).toEqual(before.hands.opponent);
    expect(after.world.shoe).toBe(before.shoe);
    expect(after.events).toEqual([{ type: "HAND_CARD_DISCARDED", actor: "player", cardId: cards[index].id }]);
    expect(after.runtime.rng).toEqual(createAbilityRuntime(new SeededRng("discard").snapshot()).rng);
    expect(before).toEqual(world());
  });
  it("dissipates a derived card without adding it to the physical ledger", () => {
    const before = world(), derived = createDerivedCard("hearts", "8", "derived");
    const after = discard({ ...before, hands: { ...before.hands, player: { cards: [...cards, derived] } } }, "last-card");
    expect(after.world.hands.player.cards).toEqual(cards);
    expect(after.world.shoe).toBe(before.shoe);
  });
  it("allows discarding the only card, and rejects an absent selector", () => {
    const initial = world();
    const one = { ...initial, hands: { ...initial.hands, player: { cards: cards.slice(0, 1) } } };
    expect(discard(one, "last-card").world.hands.player.cards).toEqual([]);
    expect(() => discard(one, "first-private-card")).toThrow("unavailable");
    expect(() => discard({ ...one, hands: { ...one.hands, player: { cards: [] } } }, "last-card")).toThrow("unavailable");
  });
  it("saves a real discarded Hit and retains its successful-use budget", () => {
    const original = ABILITY_REGISTRY;
    const definition: AiSkillAbilityDefinition = { id: instance.definitionId, name: "Neutral discard", description: "Neutral discard", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["neutral"], activation: { type: "automatic" },
      rules: [{ id: "discard", trigger: "after-card-draw", conditions: [{ type: "actor-is", actor: "owner" }], limit: { perRound: 1 }, effects: [{ type: "discard-hand-card", target: "owner", card: "last-card" }] }] };
    try {
      installAbilityRegistry([...original.definitions, definition], original.statuses, original.catalogVersion);
      const base = createMatch("neutral-discard-save", { opponentId: "chatgpt", opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }], skillDeckIds: [] });
      const player = { ...base.player, hand: { cards: cards.slice(0, 1) }, stood: false, busted: false };
      const opponent = { ...base.opponent, hand: { cards: cards.slice(1, 2) }, stood: false, busted: false };
      const state = { ...base, player, opponent, shoe: { ...world().shoe, cards: [...world().shoe.cards, createCard("hearts", "2", "follow")] }, playerSkills: { ...base.playerSkills, drawOffer: null }, round: { ...base.round, player, opponent, phase: "turns" as const, currentActor: "opponent" as const, outcome: null } };
      const after = gameReducer(state, { type: "OPPONENT_HIT" });
      const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(after)))).activeMatch!;
      expect(restored.history.some(e => e.type === "HAND_CARD_DISCARDED")).toBe(true);
      expect(restored.opponent.hand).toEqual(state.opponent.hand);
      const next = gameReducer({ ...restored, round: { ...restored.round, currentActor: "opponent" } }, { type: "OPPONENT_HIT" });
      expect(next.opponent.hand.cards).toHaveLength(state.opponent.hand.cards.length + 1);
      expect(next.history.filter(e => e.type === "HAND_CARD_DISCARDED")).toHaveLength(1);
    } finally { installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion); }
  });
  it("rolls back a failed multi-effect rule without spending its round budget", () => {
    const definition: AiSkillAbilityDefinition = { id: instance.definitionId, name: "Neutral discard", description: "Neutral discard", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["neutral"], activation: { type: "automatic" },
      rules: [{ id: "discard", trigger: "after-card-draw", limit: { perRound: 1 }, effects: [
        { type: "discard-hand-card", target: "rival", card: "last-card" },
        { type: "discard-hand-card", target: "owner", card: "last-card" }
      ] }] };
    const registry = createStandaloneAbilityRegistry([definition], []);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("rollback").snapshot()), instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", instance.instanceId, 1, registry, "ai-skill"), registry);
    const initial = world();
    expect(() => resolveAbilityEvent({ world: initial, runtime, registry, event: { trigger: "after-card-draw", sourceEventId: "hit" } })).toThrow("unavailable");
    expect(runtime.counters).toEqual({}); expect(initial).toEqual(world());
  });
});
