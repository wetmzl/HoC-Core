import { describe, expect, it } from "vitest";
import { createCard } from "../blackjack/card";
import { SeededRng } from "../rng/seeded";
import { resolveDisplays } from "./displays";
import { resolveAbilityEvent } from "./engine";
import { createStandaloneAbilityRegistry, instantiateAbility } from "./registry";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import type { AbilityActor, AbilityRule, AbilityStatus, AbilityWorld, AiSkillAbilityDefinition, Condition, StatusDefinition } from "./types";

const sourceId = "example-source";
const source: AiSkillAbilityDefinition = {
  id: "example-state-controller", name: "State controller", description: "Neutral state composition fixture",
  sourceKind: "ai-skill", primaryDomain: "gambler", tags: ["neutral"], activation: { type: "automatic" }, rules: []
};
const event = { trigger: "before-turn" as const, sourceEventId: "example-turn", eventActor: "opponent" as const };
const status = (id: string, owner: AbilityActor, sequence = 2): AbilityStatus => ({
  statusDefinitionId: id, owner, sourceInstanceId: sourceId, stacks: 1,
  duration: "match", parameters: {}, createdAtSequence: sequence
});

function fixture(rules: readonly AbilityRule[], definitions: readonly StatusDefinition[], statuses: readonly AbilityStatus[] = [], extra: Partial<AiSkillAbilityDefinition> = {}) {
  const definition: AiSkillAbilityDefinition = { ...source, ...extra, rules };
  const registry = createStandaloneAbilityRegistry([definition], definitions);
  const instance = instantiateAbility({ definitionId: definition.id, enabled: true, parameters: {} }, "player", sourceId, 1, registry, "ai-skill");
  const base = addAbilityInstance(createAbilityRuntime(new SeededRng("neutral-state").snapshot()), instance, registry);
  const runtime = { ...base, statuses, sequence: Math.max(base.sequence, ...statuses.map(entry => entry.createdAtSequence)) };
  const world: AbilityWorld = {
    hands: { player: { cards: [createCard("spades", "2", "p-2"), createCard("hearts", "3", "p-3"), createCard("clubs", "4", "p-4")] }, opponent: { cards: [] } },
    guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0, statuses
  };
  return { registry, runtime, world, event };
}

describe("composable state rules", () => {
  it("does not run the remaining collected rules after their status consumes its last layer", () => {
    const id = "example-once";
    const input = fixture([], [{ id, defaultDuration: "match", rules: [
      { id: "consume", trigger: "before-turn", effects: [{ type: "remove-status", target: "status-owner", statusDefinitionId: id }] },
      { id: "late", trigger: "before-turn", priority: 10, effects: [{ type: "add-gun-bullets", target: "status-owner", amount: 1 }] }
    ] }], [status(id, "opponent")]);
    const result = resolveAbilityEvent(input);
    expect(result.world.statuses).toEqual([]);
    expect(result.world.guns.opponent.bullets).toBe(0);
    expect(result.triggered).toEqual([`${sourceId}:consume`]);
  });

  it("does not run a replaced status snapshot until a subsequent event", () => {
    const id = "example-replaced";
    const input = fixture([
      { id: "replace", trigger: "before-turn", priority: -10, limit: { perMatch: 1 }, effects: [{ type: "add-status", target: "rival", statusDefinitionId: id }] }
    ], [{ id, defaultDuration: "match", rules: [
      { id: "observe", trigger: "before-turn", effects: [{ type: "add-gun-bullets", target: "status-owner", amount: 1 }] }
    ] }], [status(id, "opponent")]);
    const replaced = resolveAbilityEvent(input);
    expect(replaced.world.guns.opponent.bullets).toBe(0);
    expect(replaced.world.statuses[0].createdAtSequence).toBeGreaterThan(input.runtime.statuses[0].createdAtSequence);
    const next = resolveAbilityEvent({ ...input, runtime: replaced.runtime, world: replaced.world, event: { ...event, sourceEventId: "next-turn" } });
    expect(next.world.guns.opponent.bullets).toBe(1);
  });

  it("keeps later rules eligible after a numeric update that preserves the status identity", () => {
    const id = "example-snapshot";
    const input = fixture([], [{ id, defaultDuration: "match", rules: [
      { id: "write", trigger: "before-turn", effects: [{ type: "assign-status-values", target: "status-owner", statusDefinitionId: id, values: { ["load"]: { type: "numeric", value: 2 } } }] },
      { id: "read", trigger: "before-turn", priority: 10, effects: [{ type: "add-gun-bullets", target: "status-owner", amount: { type: "status-number", target: "status-owner", statusDefinitionId: id, key: "load" } }] }
    ] }], [status(id, "opponent")]);
    const result = resolveAbilityEvent(input);
    expect(result.world.guns.opponent.bullets).toBe(2);
    expect(result.world.guns.player.bullets).toBe(0);
    expect(result.world.statuses[0].createdAtSequence).toBe(2);
  });

  it("isolates limits for ability rules, different statuses, and each affected owner", () => {
    const effect = { type: "add-gun-bullets" as const, target: "status-owner" as const, amount: 1 };
    const sharedRule: AbilityRule = { id: "shared", trigger: "before-turn", limit: { perMatch: 1 }, effects: [effect] };
    const input = fixture([
      { ...sharedRule, effects: [{ ...effect, target: "owner" }] }
    ], ["example-first", "example-second"].map(id => ({ id, defaultDuration: "match", rules: [sharedRule] })), [
      status("example-first", "player", 2), status("example-first", "opponent", 3), status("example-second", "player", 4)
    ]);
    const result = resolveAbilityEvent(input);
    expect(result.world.guns.player.bullets).toBe(3);
    expect(result.world.guns.opponent.bullets).toBe(1);
    expect(Object.values(result.runtime.counters)).toEqual([1, 1, 1, 1]);
    const repeated = resolveAbilityEvent({ ...input, runtime: result.runtime, world: result.world, event: { ...event, sourceEventId: "another-turn" } });
    expect(repeated.world.guns).toEqual(result.world.guns);
    expect(repeated.triggered).toEqual([]);
  });

  it("does not expose status-owner to ordinary rules or leak it into acquisition broadcasts", () => {
    const id = "example-acquisition";
    const input = fixture([
      { id: "ordinary", trigger: "before-turn", conditions: [{ type: "actor-is", actor: "status-owner" }], effects: [{ type: "add-gun-bullets", target: "owner", amount: 1 }] },
      { id: "nested", trigger: "after-card-acquired", conditions: [{ type: "actor-is", actor: "status-owner" }], effects: [{ type: "add-gun-bullets", target: "owner", amount: 2 }] }
    ], [{ id, defaultDuration: "match", rules: [
      { id: "acquire", trigger: "before-turn", conditions: [{ type: "actor-is", actor: "status-owner" }], effects: [{ type: "acquire-card", target: "status-owner", reportResult: true, choices: [{ source: "derived", rank: { type: "static", rank: "2" }, suit: { type: "static", suit: "spades" } }] }] }
    ] }], [status(id, "opponent")]);
    const result = resolveAbilityEvent({ ...input, event: { ...event, statusOwner: "opponent" } });
    expect(result.world.hands.opponent.cards).toHaveLength(1);
    expect(result.world.guns.player.bullets).toBe(0);
    expect(result.triggered).toEqual([`${sourceId}:acquire`]);
  });

  it.each<Condition>([
    { type: "actor-is", actor: "status-owner" },
    { type: "round-penalty-target-is", target: "status-owner" }
  ])("does not match an unavailable status actor to absent event data: $type", condition => {
    const input = fixture([
      { id: "unavailable", trigger: "before-turn", conditions: [condition], effects: [{ type: "add-gun-bullets", target: "owner", amount: 1 }] }
    ], []);
    const result = resolveAbilityEvent({ ...input, event: { trigger: "before-turn", sourceEventId: "without-actor" } });
    expect(result.world.guns.player.bullets).toBe(0);
    expect(result.triggered).toEqual([]);
  });

  it("rolls back numeric writes, sequence, RNG, and limits when a subsequent effect fails", () => {
    const id = "example-reserve";
    const input = fixture([
      { id: "atomic", trigger: "before-turn", chance: 1, limit: { perMatch: 1 }, effects: [
        { type: "assign-status-values", target: "owner", statusDefinitionId: id, values: { ["reserve"]: { type: "numeric", value: 5 } } },
        { type: "add-to-pending-load", target: "owner", amount: 1 }
      ] }
    ], [{ id, defaultDuration: "match", rules: [] }]);
    const before = JSON.stringify({ world: input.world, runtime: input.runtime });
    expect(() => resolveAbilityEvent(input)).toThrow(/outside load event/);
    expect(JSON.stringify({ world: input.world, runtime: input.runtime })).toBe(before);
    const committed = resolveAbilityEvent({ ...input, pendingLoad: { id: "example-load", actor: "player", amount: 0, reason: "comparison" } });
    expect(committed.world.statuses[0].parameters.reserve).toBe(5);
    expect(committed.pendingLoad?.amount).toBe(1);
    expect(Object.values(committed.runtime.counters)).toEqual([1]);
  });

  it("composes arithmetic in real conditions, numeric writes, subsequent effects, and read-only displays", () => {
    const id = "example-calculation";
    const input = fixture([
      { id: "calculate", trigger: "before-turn", conditions: [{ type: "scalar-compare", operator: "eq", left: { type: "floor", value: { type: "divide", left: { type: "hand-card-count", target: "owner" }, right: 2 } }, right: 1 }], effects: [
        { type: "assign-status-values", target: "owner", statusDefinitionId: id, values: { ["fraction"]: { type: "numeric", value: { type: "divide", left: { type: "abs", value: { type: "subtract", left: { type: "hand-total", target: "owner" }, right: 20 } }, right: 2 } } } },
        { type: "assign-status-values", target: "owner", statusDefinitionId: id, values: { ["rounded"]: { type: "numeric", value: { type: "ceil", value: { type: "status-number", target: "owner", statusDefinitionId: id, key: "fraction" } } } } },
        { type: "add-gun-bullets", target: "owner", amount: { type: "round", value: { type: "modulo", left: { type: "status-number", target: "owner", statusDefinitionId: id, key: "fraction" }, right: 4 } } }
      ] }
    ], [{ id, defaultDuration: "match", rules: [] }], [], {
      displays: [{ id: "calculated", target: "owner", description: "Calculated snapshot", content: [{ type: "number", value: { type: "floor", value: { type: "divide", left: { type: "status-number", target: "owner", statusDefinitionId: id, key: "rounded" }, right: 2 } } }] }]
    });
    const result = resolveAbilityEvent(input);
    expect(result.world.statuses[0].parameters).toEqual({ fraction: 5.5, rounded: 6 });
    expect(result.world.statuses[0].stacks).toBe(1);
    expect(result.world.guns.player.bullets).toBe(2);
    const before = JSON.stringify(result);
    expect(resolveDisplays(result.runtime, result.world, input.registry)[0].content).toEqual([{ type: "number", value: 3, format: "number" }]);
    expect(JSON.stringify(result)).toBe(before);
  });
});
