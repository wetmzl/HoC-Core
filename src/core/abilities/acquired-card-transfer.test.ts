import { afterEach, describe, expect, it } from "vitest";
import { addCardTag, createCard, createDerivedCard, EXCLUDED_FROM_POINT_TOTAL_TAG } from "../blackjack/card";
import { SeededRng } from "../rng/seeded";
import { acquiredHandCard } from "./acquired-card-selection";
import { evaluateCondition, resolveScalar, type ConditionContext } from "./conditions";
import { applyEffects } from "./effects";
import { resolveAbilityEvent } from "./engine";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, installAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import type { AbilityActor, AbilityEventContext, AbilityInstance, AbilityWorld, AiSkillAbilityDefinition, Effect, StatusDefinition } from "./types";
import { createMatch, gameReducer, getRoundHitCounts } from "../match/reducer";
import { createRuntimeSave } from "../../persistence/boot";
import { validateRuntimeSave } from "../../persistence/schema";

const originalRegistry = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(originalRegistry.definitions, originalRegistry.statuses, originalRegistry.catalogVersion));

const publicCard = createCard("spades", "2", "source-public");
const acquired = createDerivedCard("hearts", "A", "acquired-exact");
const later = createCard("clubs", "4", "later-card");
const recipient = createCard("diamonds", "3", "recipient");
function world(owner: AbilityActor = "opponent", current = acquired): AbilityWorld {
  return {
    hands: owner === "player"
      ? { player: { cards: [publicCard, current, later] }, opponent: { cards: [recipient] } }
      : { opponent: { cards: [publicCard, current, later] }, player: { cards: [recipient] } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [publicCard, recipient, later], cursor: 3, shuffleIndex: 1 }, cards: [], skillDraws: 0, statuses: []
  };
}
function event(owner: AbilityActor = "opponent"): AbilityEventContext {
  return { trigger: "after-card-acquired", sourceEventId: "acquisition", eventActor: owner, acquiredCards: [acquired], roundHitCounts: { player: 2, opponent: 1 } };
}
function context(owner: AbilityActor = "opponent"): ConditionContext {
  const ability: AbilityInstance = { kind: "ai-skill", definitionId: "sample-forwarder", owner, instanceId: "forwarder", createdAtSequence: 1, parameters: {} };
  return { ability, world: world(owner), event: event(owner) };
}
function definition(id: string, effects: readonly Effect[], trigger: "after-card-acquired" | "on-round-start" = "after-card-acquired"): AiSkillAbilityDefinition {
  return { id, name: "Neutral acquisition observer", description: "Exact acquisition identity fixture", sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["neutral"], activation: { type: "automatic" },
    rules: [{ id: "apply", trigger, effects }] };
}
function forwarding(id = "sample-forwarder"): AiSkillAbilityDefinition {
  const base = definition(id, [{ type: "transfer-hand-card", from: "owner", target: "rival", card: "acquired-card" }]);
  return { ...base, rules: base.rules.map(rule => ({ ...rule, conditions: [{ type: "actor-is", actor: "owner" }, { type: "acquired-card-source-is", source: "derived" }, { type: "acquired-card-is-held", target: "owner" }] })) };
}

describe("exact acquired card selection and transfer", () => {
  it("selects the acquired identity even after another card was appended", () => {
    const initial = world();
    expect(acquiredHandCard(initial, "opponent", event())).toBe(acquired);
    expect(initial.hands.opponent.cards.at(-1)).toBe(later);
  });

  it("returns the current held object so later point tags survive transfer", () => {
    const marked = addCardTag(acquired, EXCLUDED_FROM_POINT_TOTAL_TAG);
    const initial = world("opponent", marked);
    expect(acquiredHandCard(initial, "opponent", event())).toBe(marked);
    const ctx = context();
    const runtime = createAbilityRuntime(new SeededRng("acquired-selection").snapshot());
    const after = applyEffects([{ type: "transfer-hand-card", from: "owner", target: "rival", card: "acquired-card" }], { ...ctx, world: initial, runtime, rng: SeededRng.fromSnapshot(runtime.rng) });
    expect(after.world.hands.player.cards.at(-1)).toBe(marked);
    expect(after.world.hands.opponent.cards).toEqual([publicCard, later]);
    expect(after.world.shoe).toBe(initial.shoe);
    expect(after.runtime.rng).toEqual(runtime.rng);
  });

  it("requires the acquisition window, exactly one event card and its acquiring actor", () => {
    const initial = world();
    for (const invalid of [
      { ...event(), trigger: "after-card-draw" as const }, { ...event(), eventActor: "player" as const },
      { ...event(), acquiredCards: undefined }, { ...event(), acquiredCards: [] }, { ...event(), acquiredCards: [acquired, later] }
    ]) expect(acquiredHandCard(initial, "opponent", invalid)).toBeUndefined();
    expect(acquiredHandCard(initial, "player", event())).toBeUndefined();
  });

  it.each(["player", "opponent"] as const)("checks held identity relative to an ability owned by %s", owner => {
    const ctx = context(owner);
    expect(evaluateCondition({ type: "acquired-card-is-held", target: "owner" }, ctx)).toBe(true);
    expect(evaluateCondition({ type: "acquired-card-is-held", target: "rival" }, ctx)).toBe(false);
    expect(evaluateCondition({ type: "acquired-card-is-held", target: "event-actor" }, ctx)).toBe(true);
    const removed = { ...ctx.world, hands: { ...ctx.world.hands, [owner]: { cards: [publicCard, later] } } };
    expect(evaluateCondition({ type: "acquired-card-is-held", target: "owner" }, { ...ctx, world: removed })).toBe(false);
  });

  it("rejects an absent acquisition rather than taking a different held card", () => {
    const ctx = context();
    const initial = { ...ctx.world, hands: { ...ctx.world.hands, opponent: { cards: [publicCard, later] } } };
    const runtime = createAbilityRuntime(new SeededRng("missing-acquired").snapshot());
    const before = JSON.stringify(initial);
    expect(() => applyEffects([{ type: "transfer-hand-card", from: "owner", target: "rival", card: "acquired-card" }], { ...ctx, world: initial, runtime, rng: SeededRng.fromSnapshot(runtime.rng) })).toThrow("unavailable");
    expect(JSON.stringify(initial)).toBe(before);
    expect(runtime.rng).toEqual(new SeededRng("missing-acquired").snapshot());
  });

  it("forwards each surviving member of a derived batch exactly once and keeps physical acquisitions", () => {
    const counter: StatusDefinition = { id: "sample-received", defaultDuration: "match", rules: [] };
    const creator = definition("sample-creator", [
      { type: "acquire-card", target: "owner", choices: [{ source: "derived", rank: { type: "static", rank: "2" }, suit: { type: "static", suit: "clubs" } }] },
      { type: "acquire-card", target: "owner", choices: [{ source: "derived", rank: { type: "static", rank: "8" }, suit: { type: "static", suit: "clubs" } }] },
      { type: "replace-hand-card-with-derived", target: "owner", card: "last-card", rank: { type: "static", rank: "3" }, suit: { type: "static", suit: "clubs" } },
      { type: "acquire-card", target: "owner", choices: [{ source: "draw-pile", pick: "first" }] }
    ], "on-round-start");
    const observer = definition("sample-received-observer", [{ type: "assign-status-values", target: "owner", statusDefinitionId: counter.id, values: {
      count: { type: "numeric", value: { type: "add", left: { type: "status-number", target: "owner", statusDefinitionId: counter.id, key: "count" }, right: 1 } },
      sum: { type: "numeric", value: { type: "add", left: { type: "status-number", target: "owner", statusDefinitionId: counter.id, key: "sum" }, right: { type: "acquired-card-value" } } }
    } }]);
    const observed: AiSkillAbilityDefinition = { ...observer, rules: observer.rules.map(rule => ({ ...rule, conditions: [{ type: "actor-is", actor: "rival" }] })) };
    const definitions = [creator, forwarding(), observed];
    const registry = createStandaloneAbilityRegistry(definitions, [counter]);
    let runtime = createAbilityRuntime(new SeededRng("batch-forwarding").snapshot());
    for (const source of definitions) runtime = addAbilityInstance(runtime, instantiateAbility({ definitionId: source.id, enabled: true, parameters: {} }, "opponent", source.id, runtime.sequence + 1, registry, "ai-skill"), registry);
    const physical = createCard("hearts", "5", "physical-acquisition");
    const initial = { ...world(), hands: { player: { cards: [recipient] }, opponent: { cards: [publicCard] } }, shoe: { cards: [publicCard, recipient, physical], cursor: 2, shuffleIndex: 1 } };
    const input = { registry, runtime, world: initial, event: { trigger: "on-round-start" as const, sourceEventId: "batch" }, bustLimitFor: () => 21 };
    const after = resolveAbilityEvent(input);
    expect(after.world.hands.opponent.cards).toEqual([publicCard, physical]);
    expect(after.world.hands.player.cards.map(card => card.attributes.rank)).toEqual(["3", "2", "3"]);
    expect(after.runtime.statuses.find(status => status.statusDefinitionId === counter.id)?.parameters).toEqual({ count: 2, sum: 5 });
    expect(new Set([...after.world.hands.player.cards, ...after.world.hands.opponent.cards].map(card => card.id)).size).toBe(5);
    expect(after.world.shoe.cursor).toBe(3);
    expect(after.world.shoe.cards).toEqual(initial.shoe.cards);
    expect(after.events.filter(entry => entry.type === "ABILITY_TRIGGERED" && entry.definitionId === "sample-forwarder")).toHaveLength(2);
    expect(resolveAbilityEvent(input)).toEqual(after);
  });

  it("rolls back the exact transfer and its rule budget when a later effect fails", () => {
    const source = definition("sample-forwarder", [
      { type: "transfer-hand-card", from: "owner", target: "rival", card: "acquired-card" },
      { type: "discard-hand-card", target: "owner", card: "last-card" }
    ]);
    const registry = createStandaloneAbilityRegistry([source], []);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("acquired-rollback").snapshot()), instantiateAbility({ definitionId: source.id, enabled: true, parameters: {} }, "opponent", "forwarder", 1, registry, "ai-skill"), registry);
    const initial = { ...world(), hands: { player: { cards: [recipient] }, opponent: { cards: [acquired] } } };
    const input = { world: initial, runtime, registry, event: event() };
    const before = JSON.stringify(input);
    expect(() => resolveAbilityEvent(input)).toThrow("Selected hand card is unavailable");
    expect(JSON.stringify(input)).toBe(before);
    expect(runtime.counters).toEqual({});
  });

  it("transfers a derived Hit through the match reducer without adding another Hit and survives save restore", () => {
    const replacement = definition("sample-replacement", [{ type: "replace-pending-draw", target: "owner", policy: { type: "exact-resulting-total", total: 12, fallback: "create-derived-card" } }]);
    const replacer: AiSkillAbilityDefinition = { ...replacement, rules: replacement.rules.map(rule => ({ ...rule, trigger: "before-card-draw", conditions: [{ type: "actor-is", actor: "owner" }] })) };
    installAbilityRegistry([...originalRegistry.definitions, forwarding(), replacer], originalRegistry.statuses, originalRegistry.catalogVersion);
    const base = createMatch("acquired-transfer-save", { opponentId: "chatgpt", skillDeckIds: [], opponentAiSkills: [forwarding().id, replacer.id].map(definitionId => ({ definitionId, enabled: true, parameters: {} })) });
    const cards = [createCard("spades", "2", "p-1"), createCard("clubs", "3", "p-2"), createCard("hearts", "2", "o-1"), createCard("diamonds", "3", "o-2"), createCard("spades", "K", "draw")];
    const player = { ...base.player, hand: { cards: cards.slice(0, 2) }, stood: false, busted: false, bustLimit: undefined };
    const opponent = { ...base.opponent, hand: { cards: cards.slice(2, 4) }, stood: false, busted: false, bustLimit: undefined };
    const state = { ...base, player, opponent, shoe: { cards, cursor: 4, shuffleIndex: 1 }, history: [{ type: "ROUND_STARTED" as const, roundIndex: base.roundIndex }], round: { ...base.round, player, opponent, phase: "turns" as const, currentActor: "opponent" as const, outcome: null } };
    const after = gameReducer(state, { type: "OPPONENT_HIT" });
    expect(after.opponent.hand.cards).toEqual(opponent.hand.cards);
    expect(after.player.hand.cards.at(-1)?.attributes).toMatchObject({ source: "derived", rank: "7" });
    expect(getRoundHitCounts(after)).toEqual({ player: 0, opponent: 1 });
    expect(after.shoe.cursor).toBe(state.shoe.cursor);
    expect(after.history.some(entry => entry.type === "ABILITY_RESOLUTION_FAILED")).toBe(false);
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(createRuntimeSave(after)))).activeMatch!;
    expect(restored.player.hand.cards).toEqual(after.player.hand.cards);
    expect(restored.opponent.hand.cards).toEqual(after.opponent.hand.cards);
  });
});

describe("point-value queries of excluded cards", () => {
  it("observes a preceding point exclusion and transfer in the same acquisition transaction", () => {
    const status: StatusDefinition = { id: "sample-acquired-points", defaultDuration: "round", rules: [] };
    const source = definition("sample-forwarder", [
      { type: "set-matching-hand-cards-counted", target: "owner", attribute: "source", equals: { type: "literal", value: "derived" }, counted: false },
      { type: "transfer-hand-card", from: "owner", target: "rival", card: "acquired-card" },
      { type: "assign-status-values", target: "owner", statusDefinitionId: status.id, values: { value: { type: "numeric", value: { type: "acquired-card-value" } } } }
    ]);
    const guarded: AiSkillAbilityDefinition = { ...source, rules: source.rules.map(rule => ({ ...rule, conditions: [{ type: "actor-is", actor: "owner" }] })) };
    const registry = createStandaloneAbilityRegistry([guarded], [status]);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("current-acquired-value").snapshot()), instantiateAbility({ definitionId: source.id, enabled: true, parameters: {} }, "opponent", "point-observer", 1, registry, "ai-skill"), registry);
    const after = resolveAbilityEvent({ registry, runtime, world: world(), event: event() });
    expect(after.world.hands.player.cards.at(-1)?.tags).toContain(EXCLUDED_FROM_POINT_TOTAL_TAG);
    expect(after.runtime.statuses.find(entry => entry.statusDefinitionId === status.id)?.parameters.value).toBe(0);
    expect(acquired.tags).not.toContain(EXCLUDED_FROM_POINT_TOTAL_TAG);
  });

  it.each(["one", "eleven", "effective"] as const)("reads an excluded Ace as zero with aceValue %s", aceValue => {
    const marked = addCardTag(acquired, EXCLUDED_FROM_POINT_TOTAL_TAG);
    const ctx = { ...context(), world: world("opponent", marked), event: { ...event(), acquiredCards: [marked] } };
    expect(resolveScalar({ type: "hand-card-value", target: "owner", card: "first-private-card", aceValue }, ctx)).toBe(0);
    expect(resolveScalar({ type: "acquired-card-value", aceValue }, ctx)).toBe(0);
    expect(acquired.attributes.rank).toBe("A");
    expect(acquired.attributes.source).toBe("derived");
  });

  it("sees an earlier observer's point tag on the same acquired identity, including after transfer", () => {
    const marked = addCardTag(acquired, EXCLUDED_FROM_POINT_TOTAL_TAG);
    const ctx = context();
    expect(resolveScalar({ type: "acquired-card-value" }, { ...ctx, world: world("opponent", marked) })).toBe(0);
    const transferred = { ...ctx.world, hands: { opponent: { cards: [publicCard, later] }, player: { cards: [recipient, marked] } } };
    expect(resolveScalar({ type: "acquired-card-value" }, { ...ctx, world: transferred })).toBe(0);
    expect(evaluateCondition({ type: "acquired-card-source-is", source: "derived" }, { ...ctx, world: transferred })).toBe(true);
    expect(ctx.event.acquiredCards![0]).toBe(acquired);
  });

  it("keeps the captured zero-point value available after the card leaves both hands", () => {
    const marked = addCardTag(acquired, EXCLUDED_FROM_POINT_TOTAL_TAG);
    const ctx = context();
    const removed = { ...ctx.world, hands: { opponent: { cards: [publicCard, later] }, player: { cards: [recipient] } } };
    expect(resolveScalar({ type: "acquired-card-value" }, { ...ctx, world: removed, event: { ...ctx.event, acquiredCards: [marked] } })).toBe(0);
  });
});
