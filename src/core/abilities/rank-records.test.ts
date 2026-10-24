import { afterEach, describe, expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import { RANKS } from "../blackjack/types";
import { SeededRng } from "../rng/seeded";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, instantiateAbility, installAbilityRegistry } from "./registry";
import { applyEffects } from "./effects";
import { resolveScalar } from "./conditions";
import { canPlayAbility, playAbility, resolveAbilityEvent } from "./engine";
import { resolveDisplays } from "./displays";
import { AbilityRuleSchema } from "./schema";
import { displayChipsMarkup } from "../../presentation/displays";
import type { AbilityWorld } from "./types";
import { createMatch, gameReducer } from "../match/reducer";
import { createHand } from "../blackjack/hand";
import { createDerivedCard } from "../blackjack/card";

const original = ABILITY_REGISTRY;
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));

const record = "example-ranks", ledger = "example-acquisitions";
function fixture(chance?: number) {
  const registry = createStandaloneAbilityRegistry([{
    id: "example-rank-recorder", name: "Rank recorder", description: "Neutral record mechanism",
    sourceKind: "ai-skill", primaryDomain: "cheater", tags: ["rank-record"], activation: { type: "automatic" },
    rules: [{ id: "choose", trigger: "on-round-start", chance, effects: [{ type: "record-random-rank", target: "owner", statusDefinitionId: record }] }],
    displays: [{ id: "ranks", target: "owner", description: "Recorded ranks", content: [{ type: "text", text: "Records" }, { type: "rank-record", target: "owner", statusDefinitionId: record }] }]
  }], [{ id: record, defaultDuration: "match", rules: [] }, { id: ledger, defaultDuration: "round", rules: [] }]);
  const instance = instantiateAbility({ definitionId: "example-rank-recorder", enabled: true, parameters: {} }, "player", "source", 1, registry, "ai-skill");
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("rank-records").snapshot()), instance, registry);
  const world: AbilityWorld = { hands: { player: { cards: [createCard("spades", "10", "ten"), createCard("hearts", "J", "jack")] }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0, statuses: [] };
  return { registry, instance, runtime, world };
}
describe("generic rank records", () => {
  it("records all thirteen distinct ranks without treating face cards as ten", () => {
    const f = fixture(); let world = f.world, runtime = f.runtime;
    for (const rank of [...RANKS, ...RANKS]) {
      world = { ...world, hands: { ...world.hands, player: { cards: [createCard("clubs", rank, rank)] } } };
      const result = applyEffects([{ type: "record-hand-card-rank", target: "owner", handTarget: "owner", card: "first-public-card", statusDefinitionId: record }], { ...f, ability: f.instance, world, runtime, rng: new SeededRng("unused"), event: { trigger: "on-round-start", sourceEventId: "record" } });
      world = result.world; runtime = result.runtime;
    }
    expect(resolveScalar({ type: "rank-record-count", target: "owner", statusDefinitionId: record }, { world, ability: f.instance, event: { trigger: "before-turn", sourceEventId: "query" } })).toBe(13);
    expect(world.statuses[0].parameters.selectedRank).toBe("K");
  });
  it("selects the public card, counts matches live, and deduplicates by card ID", () => {
    const f = fixture(); const context = { ...f, ability: f.instance, rng: new SeededRng("unused"), event: { trigger: "on-round-start" as const, sourceEventId: "record" } };
    const first = applyEffects([{ type: "record-hand-card-rank", target: "owner", handTarget: "owner", card: "first-public-card", statusDefinitionId: record }], context);
    const effect = { type: "count-new-matching-cards" as const, target: "owner" as const, recordTarget: "owner" as const, recordStatusDefinitionId: record, statusDefinitionId: ledger };
    const charged = applyEffects([effect, effect], { ...context, world: first.world, runtime: first.runtime });
    expect(charged.world.statuses.find(s => s.statusDefinitionId === ledger)?.parameters.count).toBe(1);
    expect(charged.world.statuses.find(s => s.statusDefinitionId === ledger)?.parameters["card:jack"]).toBe(true);
    expect(resolveScalar({ type: "hand-rank-record-count", target: "owner", statusTarget: "owner", statusDefinitionId: record, matched: false }, { ...context, world: charged.world })).toBe(1);
    const removed = { ...charged.world, hands: { ...charged.world.hands, player: { cards: [] } } };
    expect(resolveScalar({ type: "status-number", target: "owner", statusDefinitionId: ledger, key: "count" }, { ...context, world: removed })).toBe(1);
  });
  it("tracks intermediate acquisitions even when another effect removes the new card", () => {
    const f = fixture();
    const result = applyEffects([{ type: "add-derived-card", target: "owner", rank: { type: "static", rank: "3" }, suit: { type: "static", suit: "clubs" } }, { type: "replace-hand-card-with-derived", target: "owner", card: "last-card", rank: { type: "static", rank: "4" }, suit: { type: "static", suit: "clubs" } }], { ...f, ability: f.instance, rng: new SeededRng("acquired"), event: { trigger: "on-ability-played", sourceEventId: "acquired" } });
    expect(result.acquiredCards?.map(entry => entry.card.attributes.rank)).toEqual(["3", "4"]);
  });
  it("replays random selection exactly and projection never mutates the stream", () => {
    const f = fixture(); const input = { ...f, event: { trigger: "on-round-start" as const, sourceEventId: "choose" } };
    const first = resolveAbilityEvent(input), replay = resolveAbilityEvent(input);
    expect(first).toEqual(replay); expect(first.runtime.rng).not.toEqual(f.runtime.rng);
    const before = JSON.stringify(first);
    const display = resolveDisplays(first.runtime, first.world, f.registry);
    const markup = displayChipsMarkup(display, "player");
    expect(markup.match(/class="rank-record-cell/g)).toHaveLength(13);
    expect(markup.match(/is-recorded/g)).toHaveLength(1);
    expect(markup).toContain("is-selected"); expect(JSON.stringify(first)).toBe(before);
  });
  it("renders an empty board from absent state and rejects unknown status references", () => {
    const f = fixture(); const display = resolveDisplays(f.runtime, f.world, f.registry);
    expect(display[0].content[1]).toEqual({ type: "rank-record", ranks: [], selected: null });
    expect(() => createStandaloneAbilityRegistry(f.registry.definitions, [])).toThrow("Unknown status");
  });
  it("validates query references without interpreting literal status parameters as DSL", () => {
    const f = fixture();
    const definition = { ...f.registry.definitions[0], rules: [{ id: "literal-data", trigger: "on-round-start", effects: [{ type: "add-status", target: "owner", statusDefinitionId: record, parameters: { type: "custom", statusDefinitionId: "literal-value", recordStatusDefinitionId: "another-literal" } }] }] };
    expect(() => createStandaloneAbilityRegistry([definition], f.registry.statuses)).not.toThrow();
    const invalid = { ...definition, rules: [{ ...definition.rules[0], effects: [{ type: "count-new-matching-cards", target: "owner", recordTarget: "owner", recordStatusDefinitionId: "missing", statusDefinitionId: ledger }] }] };
    expect(() => createStandaloneAbilityRegistry([invalid], f.registry.statuses)).toThrow("Unknown record status");
  });
  it("failed chance only advances RNG, with no rules, effects or trigger budget consumed", () => {
    const f = fixture(0); const result = resolveAbilityEvent({ ...f, event: { trigger: "on-round-start", sourceEventId: "chance" } });
    expect(result.runtime.rng).not.toEqual(f.runtime.rng); expect(result.runtime.counters).toEqual({});
    expect(result.world.statuses).toEqual([]); expect(result.events).toEqual([]); expect(result.triggered).toEqual([]);
    for (const chance of [-0.01, 1.01, NaN]) expect(AbilityRuleSchema.safeParse({ id: "invalid", trigger: "on-round-start", chance, effects: [{ type: "force-stand", target: "owner" }] }).success).toBe(false);
  });
  it("force stand only accepts the post-Hit window and matching actor", () => {
    const f = fixture(); const context = { ...f, ability: f.instance, rng: new SeededRng("unused"), event: { trigger: "after-hit-resolved" as const, sourceEventId: "hit" } };
    const result = applyEffects([{ type: "force-stand", target: "owner" }], context, { draw: { id: "hit", actor: "player" } });
    expect(result.pendingDraw?.standAfterDraw).toBe(true);
    expect(() => applyEffects([{ type: "force-stand", target: "owner" }], context, { draw: { id: "hit", actor: "opponent" } })).toThrow();
    expect(() => applyEffects([{ type: "force-stand", target: "owner" }], { ...context, event: { ...context.event, trigger: "after-card-draw" } }, { draw: { id: "hit", actor: "player" } })).toThrow();
  });
  it("keeps probabilistic actions available and advances only RNG on a missed activation", () => {
    const f = fixture();
    const definition = { ...f.registry.definitions[0], sourceKind: "player-skill", skillTags: ["cheater"], drop: { enabled: false, baseWeight: 1 }, stackable: false,
      activation: { type: "action", windows: ["owner-turn"], consume: "card" },
      rules: [{ ...f.registry.definitions[0].rules[0], trigger: "on-ability-played", chance: 0, limit: { perMatch: 1 } }] };
    const registry = createStandaloneAbilityRegistry([definition], f.registry.statuses);
    const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "player", "action", 1, registry);
    const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("action-chance").snapshot()), instance, registry);
    const world = { ...f.world, cards: [{ kind: "player-skill" as const, definitionId: definition.id, owner: "player" as const, instanceId: instance.instanceId }] };
    const input = { world, runtime, registry, owner: "player" as const, instanceId: instance.instanceId, window: "owner-turn" as const };
    const before = JSON.stringify(input);
    expect(canPlayAbility(input)).toBe(true); expect(JSON.stringify(input)).toBe(before);
    const missed = playAbility(input);
    expect(missed.world).toEqual(world); expect(missed.runtime.rng).not.toEqual(runtime.rng);
    expect(missed.runtime.counters).toEqual({}); expect(missed.triggered).toEqual([]); expect(missed.events).toEqual([]);
    const successfulRegistry = createStandaloneAbilityRegistry([{ ...definition, rules: [{ ...definition.rules[0], chance: 1 }] }], f.registry.statuses);
    const success = playAbility({ ...input, registry: successfulRegistry });
    expect(success.world.cards).toHaveLength(0); expect(success.triggered).toHaveLength(1);
  });
  it("gives distinct acquisition event identities to different instances of the same rule", () => {
    const f = fixture();
    const definition = { ...f.registry.definitions[0], displays: [], rules: [{ id: "create", trigger: "on-round-start", effects: [{ type: "add-derived-card", target: "owner", rank: { type: "static", rank: "2" }, suit: { type: "static", suit: "clubs" } }] }] };
    const observer = { ...definition, id: "example-acquisition-observer", rules: [{ id: "observe", trigger: "after-card-acquired", conditions: [{ type: "actor-is", actor: "owner" }], limit: { perEvent: 1 }, effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }] };
    const registry = createStandaloneAbilityRegistry([definition, observer], []);
    let runtime = createAbilityRuntime(new SeededRng("event-identities").snapshot());
    for (const [id, instanceId] of [[definition.id, "first"], [definition.id, "second"], [observer.id, "observer"]]) runtime = addAbilityInstance(runtime, instantiateAbility({ definitionId: id, enabled: true, parameters: {} }, "player", instanceId, runtime.sequence + 1, registry, "ai-skill"), registry);
    const result = resolveAbilityEvent({ world: f.world, runtime, registry, event: { trigger: "on-round-start", sourceEventId: "round" } });
    expect(result.world.skillDraws).toBe(2);
  });
  it("rechecks hand mutations made in the post-Hit window before applying forced Stand", () => {
    const definition = { id: "example-post-hit-mutation", name: "Post Hit", description: "Post-Hit hand mutation", sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["hand-mutation"], activation: { type: "automatic" },
      rules: [{ id: "mutate", trigger: "after-hit-resolved", effects: [
        { type: "add-derived-card", target: "owner", rank: { type: "static", rank: "K" }, suit: { type: "static", suit: "clubs" } },
        { type: "add-derived-card", target: "owner", rank: { type: "static", rank: "K" }, suit: { type: "static", suit: "hearts" } },
        { type: "force-stand", target: "owner" }
      ] }] };
    installAbilityRegistry([...original.definitions, definition], original.statuses, original.catalogVersion);
    const base = createMatch("post-hit-check", { opponentAiSkills: [{ definitionId: definition.id, enabled: true, parameters: {} }] });
    const opponent = { ...base.opponent, hand: createHand([createDerivedCard("clubs", "2", "low-2", "fixture"), createDerivedCard("hearts", "3", "low-3", "fixture")]), stood: false, busted: false, bustLimit: undefined };
    const state = { ...base, opponent, round: { ...base.round, opponent, currentActor: "opponent" as const, phase: "turns" as const } };
    const result = gameReducer(state, { type: "AI_HIT" });
    expect(result.opponent).toMatchObject({ busted: true, stood: true });
    expect(result.round.outcome).toBeNull();
    expect(result.round.currentActor).toBe("player");
    expect(gameReducer(result, { type: "PLAYER_STAND" }).round.outcome).toMatchObject({ reason: "bust", penaltyTarget: "opponent" });
  });
});
