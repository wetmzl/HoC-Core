import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import { SeededRng } from "../rng/seeded";
import { applyEffect } from "./effects";
import { canPlayAbility, isAbilityBlockedByStatus, isActionBlockedByStatus, playAbility, resolveAbilityEvent } from "./engine";
import { ABILITY_REGISTRY, createStandaloneAbilityRegistry, getAbilityDefinition, getStatusDefinition, installAbilityRegistry, instantiateAbility, validateAbilityBinding, type AbilityRegistry } from "./registry";
import { addAbilityInstance, consumeAbilityTriggerTtl, createAbilityRuntime, garbageCollectAbilityInstances } from "./runtime";
import type { AbilityWorld, Effect, PlayerSkillAbilityDefinition, StatusDefinition } from "./types";

const original = ABILITY_REGISTRY;
const globalStatus: StatusDefinition = { id: "global-block", defaultDuration: "match", rules: [], blocksActions: ["hit"], blocksAbilityTags: ["active-skill-card"] };
const action = (id: string, effects: readonly Effect[]): PlayerSkillAbilityDefinition => ({
  id, name: "Neutral action", description: "Catalog isolation fixture", sourceKind: "player-skill", primaryDomain: "gambler",
  tags: ["active-skill-card"], skillTags: ["gambler"], drop: { enabled: true, baseWeight: 1 }, stackable: false,
  activation: { type: "action", windows: ["owner-turn"], consume: "card" },
  rules: [{ id: "apply", trigger: "on-ability-played", effects }],
  displays: [{ id: "label", target: "owner", description: "Fixture", content: [{ type: "text", text: "Neutral" }] }]
});
const globalAction = action("global-action", [{ type: "add-skill-draws", target: "owner", amount: 99 }]);
const globalTrigger = {
  id: "global-trigger", name: "Neutral trigger", description: "Catalog isolation fixture", sourceKind: "ai-skill",
  primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" }, ttl: { type: "triggers", amount: 2 }, rules: []
};
const empty = createStandaloneAbilityRegistry([], []);

beforeEach(() => installAbilityRegistry([globalAction, globalTrigger], [globalStatus], original.catalogVersion));
afterEach(() => installAbilityRegistry(original.definitions, original.statuses, original.catalogVersion));

function fixture(registry: AbilityRegistry = ABILITY_REGISTRY, definitionId = globalAction.id) {
  const instance = instantiateAbility({ definitionId, enabled: true, parameters: {} }, "player", "source", 1, registry);
  const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("isolation").snapshot()), instance, registry);
  const world: AbilityWorld = {
    hands: { player: { cards: [createCard("spades", "2", "player-card")] }, opponent: { cards: [] } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [], cursor: 0, shuffleIndex: 0 },
    cards: [{ kind: "player-skill", owner: "player", instanceId: instance.instanceId, definitionId }], skillDraws: 0, statuses: []
  };
  return { instance, world, runtime, registry, owner: "player" as const, instanceId: instance.instanceId, window: "owner-turn" as const };
}

describe("authoritative isolated ability catalogs", () => {
  it("rejects globally installed definitions when binding or instantiating against an empty catalog", () => {
    const binding = { definitionId: globalAction.id, enabled: true, parameters: {} };
    expect(getAbilityDefinition(globalAction.id)).toBeDefined();
    expect(getAbilityDefinition(globalAction.id, empty)).toBeUndefined();
    expect(getStatusDefinition(globalStatus.id, empty)).toBeUndefined();
    expect(validateAbilityBinding(binding)).toEqual({ ...binding, level: 1 });
    expect(() => validateAbilityBinding(binding, empty)).toThrow("Unknown ability definition");
    expect(() => instantiateAbility(binding, "player", "source", 1, empty)).toThrow("Unknown ability definition");
  });

  it("cannot preflight, play or trigger an instance missing from the selected catalog", () => {
    const input = { ...fixture(), registry: empty };
    expect(canPlayAbility(input)).toBe(false);
    expect(() => playAbility(input)).toThrow("not available");
    expect(() => resolveAbilityEvent({ ...input, event: { trigger: "before-turn", sourceEventId: "turn" } })).toThrow("Unknown ability definition");
  });

  it("does not inherit global status rules or blockers", () => {
    const local = createStandaloneAbilityRegistry([globalAction], []);
    const input = fixture(local);
    const status = { statusDefinitionId: globalStatus.id, owner: "player" as const, sourceInstanceId: input.instanceId, stacks: 1, duration: "match" as const, parameters: {}, createdAtSequence: 2 };
    const world = { ...input.world, statuses: [status] };
    expect(isActionBlockedByStatus(world, "player", "hit")).toBe(true);
    expect(isActionBlockedByStatus(world, "player", "hit", local)).toBe(false);
    expect(isAbilityBlockedByStatus(world, "player", globalAction, local)).toBe(false);
    expect(() => resolveAbilityEvent({ ...input, world, runtime: { ...input.runtime, statuses: [status] }, event: { trigger: "before-turn", sourceEventId: "turn" } })).toThrow("Unknown status definition");
  });

  const statusEffects: readonly Effect[] = [
    { type: "record-random-rank", target: "owner", statusDefinitionId: globalStatus.id },
    { type: "add-status", target: "owner", statusDefinitionId: globalStatus.id },
    { type: "set-status-stacks", target: "owner", statusDefinitionId: globalStatus.id, amount: 1 },
    { type: "assign-status-values", target: "owner", statusDefinitionId: globalStatus.id, mode: "replace", stacks: 1, values: { suit: { type: "hand-dominant-suit", target: "owner", tieBreak: ["spades", "hearts", "diamonds", "clubs"] } } },
    { type: "assign-status-values", target: "owner", statusDefinitionId: globalStatus.id, mode: "replace", stacks: 1, values: { rank: { type: "card-attribute", target: "owner", card: "last-card", attribute: "rank" }, suit: { type: "card-attribute", target: "owner", card: "last-card", attribute: "suit" }, source: { type: "card-attribute", target: "owner", card: "last-card", attribute: "source" }, cardId: { type: "card-attribute", target: "owner", card: "last-card", attribute: "id" } } }
  ];
  it.each(statusEffects)("cannot create a globally defined status through $type", effect => {
    const input = fixture();
    expect(() => applyEffect(effect, { world: input.world, runtime: input.runtime, ability: input.instance, registry: empty,
      rng: new SeededRng("status"), event: { trigger: "on-ability-played", sourceEventId: "status" }
    })).toThrow("Unknown status definition");
  });

  it("rejects dynamic card grants for a definition outside the selected catalog atomically", () => {
    const local = createStandaloneAbilityRegistry([action("local-grant", [{ type: "grant-skill-card", target: "owner", initialize: false, choices: [{ type: "last-successful-player-skill" }, { type: "self" }] }])], []);
    const input = fixture(local, "local-grant");
    input.runtime = { ...input.runtime, lastPlayedPlayerSkillDefinitionId: globalAction.id };
    const before = structuredClone(input);
    expect(() => playAbility(input)).toThrow(`Cannot grant a non-player skill definition: ${globalAction.id}`);
    expect(input).toEqual(before);
  });

  it("executes two independent catalogs identically before and after replacing installed globals", () => {
    const catalog = (amount: number, duration: StatusDefinition["defaultDuration"]) => createStandaloneAbilityRegistry([
      action("shared-action", [{ type: "add-skill-draws", target: "owner", amount }, { type: "add-status", target: "owner", statusDefinitionId: "shared-status" }])
    ], [{ id: "shared-status", defaultDuration: duration, rules: [] }]);
    const first = fixture(catalog(1, "round"), "shared-action");
    const second = fixture(catalog(2, "turn"), "shared-action");
    const conflicting = catalog(99, "match");
    installAbilityRegistry(conflicting.definitions, conflicting.statuses, conflicting.catalogVersion);
    const results = [playAbility(first), playAbility(second)];
    expect(results.map(result => result.world.skillDraws)).toEqual([1, 2]);
    expect(results.map(result => result.world.statuses[0].duration)).toEqual(["round", "turn"]);
    installAbilityRegistry([], [], original.catalogVersion);
    expect([playAbility(first), playAbility(second)]).toEqual(results);
  });

  it("does not attach global displays, consume global TTLs or collect instances using an absent definition", () => {
    const input = fixture();
    const runtime = createAbilityRuntime(new SeededRng("lifecycle").snapshot());
    expect(addAbilityInstance(runtime, input.instance, empty).displays).toEqual([]);
    expect(garbageCollectAbilityInstances(input.runtime, [], empty).instances).toEqual([input.instance]);
    expect(garbageCollectAbilityInstances(input.runtime, []).instances).toEqual([]);
    const trigger = instantiateAbility({ definitionId: globalTrigger.id, enabled: true, parameters: {} }, "player", "trigger", 1, undefined, "ai-skill");
    const withTrigger = addAbilityInstance(runtime, trigger);
    expect(consumeAbilityTriggerTtl(withTrigger, [], trigger.instanceId, empty).runtime).toBe(withTrigger);
    expect(consumeAbilityTriggerTtl(withTrigger, [], trigger.instanceId).runtime.instances[0].ttl?.remaining).toBe(1);
  });
});
