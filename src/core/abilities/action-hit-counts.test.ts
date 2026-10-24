import { describe, expect, it } from "vitest";
import { SeededRng } from "../rng/seeded";
import { addAbilityInstance, createAbilityRuntime } from "./runtime";
import { createStandaloneAbilityRegistry, instantiateAbility } from "./registry";
import { canPlayAbility, playAbility } from "./engine";
import type { AbilityWorld } from "./types";

describe("action round facts", () => {
  for (const owner of ["player", "opponent"] as const) {
    it(`shares round Hit counts across availability, dry run and execution for ${owner}`, () => {
      const registry = createStandaloneAbilityRegistry([{
        id: "example-round-action", name: "Round facts", description: "Generic action context", sourceKind: "player-skill", primaryDomain: "gambler", tags: ["active-skill-card"], skillTags: ["gambler"], drop: { enabled: false, baseWeight: 1 }, stackable: false,
        activation: { type: "action", windows: ["owner-turn"], consume: "card", availability: [{ type: "round-hit-count", target: "owner", operator: "gt", value: 1 }] },
        rules: [{ id: "query", trigger: "on-ability-played", effects: [{ type: "set-status-stacks", target: "owner", statusDefinitionId: "example-round-value", amount: { type: "round-hit-count", target: "rival" } }] }]
      }], [{ id: "example-round-value", defaultDuration: "round", rules: [] }]);
      const instance = instantiateAbility({ definitionId: "example-round-action", enabled: true, parameters: {} }, owner, "action", 1, registry, "player-skill");
      const runtime = addAbilityInstance(createAbilityRuntime(new SeededRng("round-facts").snapshot()), instance, registry);
      const world: AbilityWorld = { hands: { player: { cards: [] }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [{ kind: "player-skill", owner, instanceId: instance.instanceId, definitionId: instance.definitionId }], skillDraws: 0, statuses: [] };
      const input = { world, runtime, registry, owner, instanceId: instance.instanceId, window: "owner-turn" as const };
      expect(canPlayAbility(input)).toBe(false);
      expect(canPlayAbility({ ...input, roundHitCounts: { player: 1, opponent: 1 } })).toBe(false);
      const ready = { ...input, roundHitCounts: owner === "player" ? { player: 2, opponent: 3 } : { player: 3, opponent: 2 } };
      const before = JSON.stringify(ready);
      expect(canPlayAbility(ready)).toBe(true);
      expect(JSON.stringify(ready)).toBe(before);
      const result = playAbility(ready);
      expect(result.world.statuses).toContainEqual(expect.objectContaining({ owner, stacks: 3 }));
      expect(result.world.cards).toHaveLength(0);
      expect(result.runtime.rng).toEqual(runtime.rng);
    });
  }
});
