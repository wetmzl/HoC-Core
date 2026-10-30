import { describe, expect, it } from "vitest";
import { applyEffect } from "./effects";
import { createStandaloneAbilityRegistry } from "./registry";
import { createAbilityRuntime } from "./runtime";
import { SeededRng } from "../rng/seeded";
import type { AbilityInstance, AbilityWorld } from "./types";
interface AssignmentInput { definition: StatusDefinition; owner: "player" | "opponent"; sourceInstanceId: string; createdAtSequence: number; key: string; value: number }
function assignScalar(existing: AbilityStatus | undefined, input: AssignmentInput): AbilityStatus {
  const registry = createStandaloneAbilityRegistry([], [input.definition]);
  const rng = new SeededRng("assignment");
  const world: AbilityWorld = { hands: { player: { cards: [] }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } }, shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0, statuses: existing ? [existing] : [] };
  const ability: AbilityInstance = { instanceId: input.sourceInstanceId, definitionId: "neutral", owner: input.owner, kind: "player-skill", createdAtSequence: 0, parameters: {} };
  const result = applyEffect({ type: "assign-status-values", target: "owner", statusDefinitionId: input.definition.id, values: { [input.key]: { type: "numeric", value: input.value } } }, { world, registry, rng, ability, runtime: { ...createAbilityRuntime(rng.snapshot()), sequence: input.createdAtSequence - 1 }, event: { trigger: "on-ability-played", sourceEventId: "assignment" } });
  return result.world.statuses.find(status => status.owner === input.owner && status.statusDefinitionId === input.definition.id)!;
}
import type { AbilityStatus, StatusDefinition } from "./types";

const definition: StatusDefinition = { id: "example-reserve", defaultDuration: "match", rules: [] };
const input: AssignmentInput = {
  definition, owner: "player", sourceInstanceId: "example-source", createdAtSequence: 6,
  key: "reserve", value: 3.5
};

describe("numeric status parameters", () => {
  it("creates one layer with the declared lifecycle and supplied source", () => {
    expect(assignScalar(undefined, input)).toEqual({
      statusDefinitionId: "example-reserve", owner: "player", sourceInstanceId: "example-source",
      stacks: 1, duration: "match", parameters: { reserve: 3.5 }, createdAtSequence: 6
    });
    expect(assignScalar(undefined, { ...input, definition: { ...definition, defaultDuration: "round" } }).duration).toBe("round");
  });

  it("updates a snapshot without changing its source, lifetime, layers, or other parameters", () => {
    const existing: AbilityStatus = Object.freeze({
      statusDefinitionId: "example-reserve", owner: "player", sourceInstanceId: "original-source",
      stacks: 4, duration: "until-consumed", createdAtSequence: 2,
      parameters: Object.freeze({ reserve: 8, ready: true, label: "snapshot" })
    });
    const updated = assignScalar(existing, input);
    expect(updated).toEqual({ ...existing, parameters: { reserve: 3.5, ready: true, label: "snapshot" } });
    expect(existing.parameters.reserve).toBe(8);
    expect(updated).not.toBe(existing);
    expect(updated.parameters).not.toBe(existing.parameters);
  });

  it("preserves zero and negative fractional values without removing the status or stacking it", () => {
    const initial = assignScalar(undefined, input);
    const zero = assignScalar(initial, { ...input, value: 0 });
    const negative = assignScalar(zero, { ...input, value: -0.25 });
    const additional = assignScalar(negative, { ...input, key: "threshold", value: 12 });
    expect(additional.parameters).toEqual({ reserve: -0.25, threshold: 12 });
    expect(additional.stacks).toBe(1);
    expect(zero.parameters.reserve).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity])("rejects a non-finite snapshot (%s) without modifying the existing status", value => {
    const existing = assignScalar(undefined, input);
    expect(() => assignScalar(existing, { ...input, value })).toThrow(/finite/);
    expect(existing.parameters.reserve).toBe(3.5);
  });

  it("keeps another actor's status while assigning the requested actor", () => {
    const existing = assignScalar(undefined, input);
    const rival = assignScalar(existing, { ...input, owner: "opponent", value: 9 });
    expect(rival.owner).toBe("opponent");
    expect(rival.parameters.reserve).toBe(9);
    expect(existing.parameters.reserve).toBe(3.5);
  });
});
