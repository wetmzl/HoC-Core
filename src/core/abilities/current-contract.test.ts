import { describe, expect, it } from "vitest";
import { AbilityDefinitionSchema, ScalarSchema } from "./schema";
import { evaluateCondition } from "./conditions";
import { createHocpkgResourceHandlers } from "../../content/packages/resources";
import type { ConditionContext } from "./conditions";

const definition = {
  id: "neutral-contract", name: "Contract", description: "Neutral contract boundary",
  sourceKind: "ai-skill", primaryDomain: "gambler", activation: { type: "passive" },
  rules: [{ id: "observe", trigger: "on-round-start", effects: [{ type: "add-skill-draws", target: "owner", amount: 1 }] }]
};
describe("current ability contract", () => {
  const status = { target: "owner", statusDefinitionId: "state" };
  const rank = { type: "static", rank: "A" }, suit = { type: "uniform-ability-rng" };
  it.each([
    { type: "remember-last-card", ...status, cardTarget: "rival" },
    { type: "set-status-suit-to-hand-majority", ...status, handTarget: "rival" },
    { type: "replace-bust-hand-card-with-memory-card", ...status },
    { type: "split-last-card-into-derived", target: "owner" },
    { type: "add-derived-card-to-limit", target: "owner", fallback: { rank, suit } },
    { type: "add-derived-card-for-exact-total", target: "owner", total: 21 },
    { type: "draw-physical-card", target: "owner", policy: "exact-limit-or-lowest" },
    { type: "grant-player-skill-card", target: "owner", source: "last-successful-player-skill", fallback: "self" },
    { type: "publish-action-advice", target: "owner", policy: "current-optimal-hit-stand" },
    { type: "set-status-number", ...status, key: "count", value: 1 },
    { type: "add-derived-card", target: "owner", rank, suit },
    { type: "copy-last-hand-card-as-derived", target: "owner" },
    { type: "transfer-last-physical-hand-card", from: "rival", target: "owner" }
  ])("rejects the retired effect $type", effect => {
    expect(AbilityDefinitionSchema.safeParse({ ...definition, rules: [{ ...definition.rules[0], effects: [effect] }] }).success).toBe(false);
  });
  it.each([
    { type: "hand-last-card-splittable", target: "owner" },
    { type: "status-card-rank-is", ...status, rank: "Q" }
  ])("rejects the retired condition $type", condition => {
    expect(AbilityDefinitionSchema.safeParse({ ...definition, rules: [{ ...definition.rules[0], conditions: [condition] }] }).success).toBe(false);
  });
  it("rejects the retired scalar and resource API versions", () => {
    expect(ScalarSchema.safeParse({ type: "hand-card-status-suit-count", target: "owner", statusTarget: "rival", statusDefinitionId: "state" }).success).toBe(false);
    for (const type of ["game.player-skill", "game.ai-skill", "game.talent"])
      expect(createHocpkgResourceHandlers().find(handler => handler.type === type)?.apiVersions).toEqual([4]);
  });
  it("compares typed values without coercion and fails closed for unavailable values", () => {
    const context = { ability: { owner: "player" }, world: { statuses: [{ owner: "player", statusDefinitionId: "state", stacks: 1, parameters: { rank: "Q", ready: true } }] } } as unknown as ConditionContext;
    const state = (key: string) => ({ type: "status-value" as const, target: "owner" as const, statusDefinitionId: "state", key });
    expect(evaluateCondition({ type: "value-compare", left: state("rank"), operator: "eq", right: { type: "literal", value: "Q" } }, context)).toBe(true);
    expect(evaluateCondition({ type: "value-compare", left: state("ready"), operator: "neq", right: { type: "literal", value: false } }, context)).toBe(true);
    expect(evaluateCondition({ type: "value-compare", left: { type: "literal", value: "2" }, operator: "eq", right: { type: "literal", value: 2 } }, context)).toBe(false);
    expect(evaluateCondition({ type: "value-compare", left: state("missing"), operator: "neq", right: { type: "literal", value: "Q" } }, context)).toBe(false);
  });
});
