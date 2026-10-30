import { describe, expect, it } from "vitest";
import { addCardTag, createCard, createDerivedCard } from "../blackjack/card";
import { createHand } from "../blackjack/hand";
import { drawCard, reshuffleIfLow } from "../blackjack/shoe";
import { SeededRng } from "../rng/seeded";
import { createMatch, gameReducer } from "../match/reducer";
import { moveHandCardToDrawPile } from "./card-zone-adapter";
import { resolveScalar, type ConditionContext } from "./conditions";
import { applyEffects } from "./effects";
import { resolveAbilityEvent } from "./engine";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, installAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import type { AbilityInstance, AbilityWorld, AiSkillAbilityDefinition, Effect, NumberValue, StatusDefinition } from "./types";

const held = [createCard("clubs", "2", "held-2"), createCard("hearts", "9", "held-9")];
const remaining = [createCard("spades", "4", "remaining-4"), createCard("diamonds", "7", "remaining-7")];
function world(): AbilityWorld {
  return {
    hands: { player: createHand(held), opponent: createHand() },
    guns: { player: { bullets: 0, capacity: 6 }, opponent: { bullets: 0, capacity: 6 } },
    shoe: { cards: [...held, ...remaining], cursor: held.length, shuffleIndex: 3 },
    cards: [], skillDraws: 0, statuses: []
  };
}
const ability: AbilityInstance = { kind: "ai-skill", definitionId: "example-card-controller", owner: "opponent", instanceId: "controller", parameters: {}, createdAtSequence: 1 };
const acquiredValue: NumberValue = { type: "acquired-card-value" };
function context(card = createDerivedCard("clubs", "3", "acquired-3")): ConditionContext {
  return { world: world(), ability, event: { trigger: "after-card-acquired", sourceEventId: "acquisition", eventActor: "player", acquiredCards: [card] } };
}

describe("acquired card numeric facts", () => {
  it("reads the event card after it left the hand, independently of the current last card", () => {
    expect(resolveScalar(acquiredValue, context(createDerivedCard("clubs", "8", "removed-8")))).toBe(8);
    expect(resolveScalar(acquiredValue, context(createDerivedCard("clubs", "K", "removed-king")))).toBe(10);
  });

  it("requires the acquisition window and exactly one acquired card", () => {
    const ctx = context();
    for (const event of [
      { ...ctx.event, trigger: "before-turn" as const },
      { ...ctx.event, acquiredCards: undefined },
      { ...ctx.event, acquiredCards: [] },
      { ...ctx.event, acquiredCards: [...ctx.event.acquiredCards!, ...ctx.event.acquiredCards!] }
    ]) expect(() => resolveScalar(acquiredValue, { ...ctx, event })).toThrow("one acquired card event");
  });

  it("offers explicit A values and effective values under the acquiring hand's live limit", () => {
    const ace = createDerivedCard("clubs", "A", "acquired-ace");
    const ctx = context(ace);
    expect(resolveScalar({ type: "acquired-card-value", aceValue: "one" }, ctx)).toBe(1);
    expect(resolveScalar({ type: "acquired-card-value", aceValue: "eleven" }, ctx)).toBe(11);
    // The hand already contains 11 points, so its newly acquired A is worth 1.
    expect(resolveScalar(acquiredValue, ctx)).toBe(1);
    expect(resolveScalar(acquiredValue, { ...ctx, bustLimitFor: () => 22 })).toBe(11);
    const withAce = { ...ctx.world, hands: { ...ctx.world.hands, player: createHand([held[0], ace]) } };
    expect(resolveScalar(acquiredValue, { ...ctx, world: withAce })).toBe(11);
    expect(() => resolveScalar(acquiredValue, { ...ctx, event: { ...ctx.event, eventActor: undefined } })).toThrow("acquiring actor");
  });

  it("accumulates every event value when a batch creates and replaces different derived cards", () => {
    const status: StatusDefinition = { id: "example-value-sum", defaultDuration: "round", rules: [] };
    const creator: AiSkillAbilityDefinition = {
      id: ability.definitionId, name: "Card controller", description: "Neutral acquisition fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
      rules: [{ id: "create", trigger: "on-round-start", effects: [
        { type: "acquire-card", target: "rival", reportResult: true, choices: [{ source: "derived", rank: { type: "static", rank: "2" }, suit: { type: "static", suit: "clubs" } }] },
        { type: "acquire-card", target: "rival", reportResult: true, choices: [{ source: "derived", rank: { type: "static", rank: "8" }, suit: { type: "static", suit: "clubs" } }] },
        { type: "replace-hand-card-with-derived", target: "rival", card: "last-card", rank: { type: "static", rank: "3" }, suit: { type: "static", suit: "clubs" } }
      ] }]
    };
    const observer: AiSkillAbilityDefinition = {
      ...creator, id: "example-acquisition-observer", rules: [{ id: "observe", trigger: "after-card-acquired", conditions: [{ type: "actor-is", actor: "rival" }, { type: "acquired-card-source-is", source: "derived" }], effects: [
        { type: "assign-status-values", target: "owner", statusDefinitionId: status.id, values: { ["sum"]: { type: "numeric", value: { type: "add", left: { type: "status-number", target: "owner", statusDefinitionId: status.id, key: "sum" }, right: acquiredValue } } } }
      ] }]
    };
    const registry = createStandaloneAbilityRegistry([creator, observer], [status]);
    let runtime = createAbilityRuntime(new SeededRng("acquired-value-batch").snapshot());
    for (const definition of [creator, observer]) runtime = addAbilityInstance(runtime, instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "opponent", definition.id, runtime.sequence + 1, registry, "ai-skill"), registry);
    const input = { world: world(), runtime, registry, event: { trigger: "on-round-start" as const, sourceEventId: "round-start" } };
    const result = resolveAbilityEvent(input);
    expect(result.world.hands.player.cards.slice(-2).map(card => card.attributes.rank)).toEqual(["2", "3"]);
    expect(result.world.statuses.find(entry => entry.statusDefinitionId === status.id)?.parameters.sum).toBe(13);
    expect(resolveAbilityEvent(input)).toEqual(result);
  });
});

describe("returning a held physical card to the shared draw pile", () => {
  it.each(["top", "bottom"] as const)("moves the existing identity to the %s and preserves the consumed ledger", position => {
    const initial = world();
    const tagged = addCardTag(held[1], "example-retained-tag");
    const result = moveHandCardToDrawPile(initial.shoe, createHand([held[0], tagged]), 1, position)!;
    expect(result.hand.cards).toEqual([held[0]]);
    expect(result.shoe.cursor).toBe(1);
    expect(result.shoe.shuffleIndex).toBe(3);
    expect(result.shoe.cards.slice(0, result.shoe.cursor)).toEqual([held[0]]);
    expect(result.shoe.cards.slice(result.shoe.cursor)).toEqual(position === "top" ? [tagged, ...remaining] : [...remaining, tagged]);
    expect(result.shoe.cards.find(card => card.id === tagged.id)).toBe(tagged);
    expect(new Set(result.shoe.cards.map(card => card.id)).size).toBe(initial.shoe.cards.length);
    expect(initial).toEqual(world());
    const reshuffled = reshuffleIfLow(result.shoe, new SeededRng("returned-card-reshuffle"));
    expect(reshuffled.cursor).toBe(0);
    expect(reshuffled.cards.filter(card => card.id === tagged.id)).toHaveLength(1);
  });

  it("can return a card when no cards remain and immediately draw that same entity", () => {
    const shoe = { cards: [...held], cursor: held.length, shuffleIndex: 0 };
    const result = moveHandCardToDrawPile(shoe, createHand(held), 1, "bottom")!;
    const drawn = drawCard(result.shoe);
    expect(drawn.card).toBe(held[1]);
    expect(drawn.shoe.cursor).toBe(drawn.shoe.cards.length);
  });

  it("rejects derived, missing, unconsumed or duplicate-ledger sources without mutating input", () => {
    const initial = world();
    const derived = createDerivedCard("clubs", "9", "derived-9");
    expect(moveHandCardToDrawPile(initial.shoe, createHand([derived]), 0, "bottom")).toBeUndefined();
    expect(moveHandCardToDrawPile(initial.shoe, initial.hands.player, 99, "bottom")).toBeUndefined();
    expect(moveHandCardToDrawPile(initial.shoe, createHand([remaining[0]]), 0, "bottom")).toBeUndefined();
    expect(moveHandCardToDrawPile({ ...initial.shoe, cards: [] }, initial.hands.player, 0, "bottom")).toBeUndefined();
    expect(moveHandCardToDrawPile({ ...initial.shoe, cards: [...initial.shoe.cards, held[0]] }, initial.hands.player, 0, "bottom")).toBeUndefined();
    expect(initial).toEqual(world());
  });

  it.each(["last-card", "first-public-card", "first-private-card"] as const)("executes the %s selector without replacement draws or acquisition events", card => {
    const initial = world();
    const rng = new SeededRng("return-selector");
    const runtime = createAbilityRuntime(rng.snapshot());
    const result = applyEffects([{ type: "move-hand-card-to-draw-pile", target: "rival", card, position: "bottom" }], { world: initial, runtime, ability, rng, event: { trigger: "after-card-draw", sourceEventId: "draw", eventActor: "player" } });
    const expectedCard = card === "first-public-card" ? held[0] : held[1];
    expect(result.world.shoe.cards.at(-1)).toBe(expectedCard);
    expect(result.world.hands.player.cards).toEqual(held.filter(entry => entry !== expectedCard));
    expect(result.acquiredCards).toEqual([]);
    expect(result.events.map(event => event.type)).toEqual(["PENDING_EVENT_MODIFIED"]);
    expect(rng.snapshot()).toEqual(runtime.rng);
  });

  it("rolls back prior effects and rule budgets when the selected card cannot be returned", () => {
    const status: StatusDefinition = { id: "example-return-budget", defaultDuration: "match", rules: [] };
    const effects: readonly Effect[] = [
      { type: "assign-status-values", target: "owner", statusDefinitionId: status.id, values: { ["spent"]: { type: "numeric", value: 1 } } },
      { type: "move-hand-card-to-draw-pile", target: "rival", card: "last-card", position: "bottom" }
    ];
    const definition: AiSkillAbilityDefinition = {
      id: ability.definitionId, name: "Card controller", description: "Neutral return fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
      rules: [{ id: "return", trigger: "before-turn", effects, limit: { perRound: 1 } }]
    };
    const registry = createStandaloneAbilityRegistry([definition], [status]);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("return-atomic").snapshot()), ability, registry);
    const initial = world();
    const input = { world: { ...initial, hands: { ...initial.hands, player: createHand([createDerivedCard("clubs", "9", "invalid-derived")]) } }, runtime, registry, event: { trigger: "before-turn" as const, sourceEventId: "turn" } };
    const before = JSON.stringify(input);
    expect(() => resolveAbilityEvent(input)).toThrow("cannot return to the draw pile");
    expect(JSON.stringify(input)).toBe(before);
    expect(runtime.statuses).toEqual([]);
    expect(runtime.counters).toEqual({});
  });

  it("returns a real Hit before its bust check once per round without drawing or broadcasting a replacement acquisition", () => {
    const original = ABILITY_REGISTRY;
    const status: StatusDefinition = { id: "example-real-hit-acquisitions", defaultDuration: "round", rules: [] };
    const definition: AiSkillAbilityDefinition = {
      id: ability.definitionId, name: "Card controller", description: "Neutral return integration fixture", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" },
      rules: [
        { id: "return", trigger: "before-bust-resolution", conditions: [{ type: "actor-is", actor: "owner" }, { type: "pending-bust-would-bust", target: "owner" }, { type: "scalar-compare", left: { type: "hand-card-value", target: "owner", card: "last-card" }, operator: "gt", right: 7 }], limit: { perRound: 1 }, effects: [{ type: "move-hand-card-to-draw-pile", target: "owner", card: "last-card", position: "bottom" }] },
        { id: "observe", trigger: "after-card-acquired", conditions: [{ type: "actor-is", actor: "owner" }], effects: [{ type: "assign-status-values", target: "owner", statusDefinitionId: status.id, values: { ["count"]: { type: "numeric", value: { type: "add", left: { type: "status-number", target: "owner", statusDefinitionId: status.id, key: "count" }, right: 1 } } } }] }
      ]
    };
    try {
      installAbilityRegistry([...original.definitions, definition], [...original.statuses, status], original.catalogVersion);
      const base = createMatch("return-before-bust", { opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }] });
      const playerCards = [createCard("clubs", "2", "integration-p2"), createCard("clubs", "3", "integration-p3")];
      const opponentCards = [createCard("clubs", "K", "integration-ok"), createCard("clubs", "9", "integration-o9")];
      const hits = [createCard("spades", "9", "integration-hit9"), createCard("hearts", "8", "integration-hit8")];
      const player = { ...base.player, hand: createHand(playerCards), stood: false, busted: false, bustLimit: undefined };
      const opponent = { ...base.opponent, hand: createHand(opponentCards), stood: false, busted: false, bustLimit: undefined };
      const state = { ...base, player, opponent, playerSkills: { ...base.playerSkills, drawOffer: null }, abilities: { ...base.abilities, statuses: [] }, shoe: { cards: [...playerCards, ...opponentCards, ...hits], cursor: 4, shuffleIndex: 0 }, round: { ...base.round, phase: "turns" as const, currentActor: "opponent" as const, outcome: null, player, opponent } };
      const first = gameReducer(state, { type: "AI_HIT" });
      expect(first.opponent.hand.cards).toEqual(opponentCards);
      expect(first.opponent.busted).toBe(false);
      expect(first.shoe.cards.slice(first.shoe.cursor)).toEqual([hits[1], hits[0]]);
      expect(first.abilities.statuses.find(entry => entry.statusDefinitionId === status.id)?.parameters.count).toBe(1);
      expect(first.history.slice(state.history.length).filter(event => event.type === "CARD_DEALT")).toEqual([{ type: "CARD_DEALT", actor: "opponent", card: hits[0], private: true }]);
      const second = gameReducer({ ...first, round: { ...first.round, currentActor: "opponent" } }, { type: "AI_HIT" });
      expect(second.opponent.busted).toBe(true);
      expect(second.opponent.hand.cards).toEqual([...opponentCards, hits[1]]);
      expect(second.abilities.statuses.find(entry => entry.statusDefinitionId === status.id)?.parameters.count).toBe(2);
      expect(second.shoe.cards.slice(second.shoe.cursor)).toEqual([hits[0]]);
      expect(second.history.filter(event => event.type === "ABILITY_TRIGGERED" && event.ruleId === "return")).toHaveLength(1);
    } finally {
      installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion);
    }
  });
});
