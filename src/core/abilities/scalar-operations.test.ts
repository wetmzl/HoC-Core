import { describe, expect, it } from "vitest";
import { resolveBinaryScalarOperation, resolveUnaryScalarOperation } from "./scalar-operations";
import { resolveBinaryScalarOperation as sharedBinaryOperation, type BinaryScalarOperation } from "../expressions/arithmetic";
import { resolveScalar, type ConditionContext } from "./conditions";

const context: ConditionContext = {
  ability: { instanceId: "neutral-observer", definitionId: "neutral-observer", owner: "player", kind: "talent", createdAtSequence: 1, parameters: {} },
  event: { trigger: "before-turn", sourceEventId: "neutral-observation" },
  world: { hands: { player: { cards: [] }, opponent: { cards: [] } }, guns: { player: { capacity: 6, bullets: 0 }, opponent: { capacity: 6, bullets: 0 } },
    shoe: { cards: [], cursor: 0, shuffleIndex: 0 }, cards: [], skillDraws: 0,
    statuses: [{ statusDefinitionId: "legacy-observation", owner: "player", sourceInstanceId: "neutral-observer", stacks: 1, duration: "match", createdAtSequence: 1, parameters: { upper: Infinity, lower: -Infinity, invalid: NaN } }] }
};

describe("scalar operations", () => {
  it("retains the old import as the same shared implementation", () => {
    expect(resolveBinaryScalarOperation).toBe(sharedBinaryOperation);
  });

  it.each<[BinaryScalarOperation, number, number, number]>([
    ["add", -2, 0.5, -1.5], ["subtract", -2, 0.5, -2.5], ["multiply", -2, 0.5, -1],
    ["power", -2, 3, -8], ["min", -2, 0.5, -2], ["max", -2, 0.5, 0.5],
    ["divide", -2, 0.5, -4], ["modulo", -2, 1.5, -0.5]
  ])("uses the same %s arithmetic for shared and ability expressions", (type, left, right, expected) => {
    expect(sharedBinaryOperation(type, left, right)).toBe(expected);
    expect(resolveScalar({ type, left, right }, context)).toBe(expected);
  });

  it("preserves finite-result handling for legacy observation leaves", () => {
    const observation = (key: string) => ({ type: "status-number" as const, target: "owner" as const, statusDefinitionId: "legacy-observation", key });
    expect(resolveScalar({ type: "min", left: observation("upper"), right: 2 }, context)).toBe(2);
    expect(resolveScalar({ type: "max", left: observation("lower"), right: 2 }, context)).toBe(2);
    expect(resolveScalar({ type: "power", left: observation("invalid"), right: 0 }, context)).toBe(1);
    expect(() => resolveScalar({ type: "divide", left: observation("upper"), right: 2 }, context)).toThrow("Scalar expression result is not finite");
    expect(() => resolveScalar({ type: "add", left: Infinity, right: 2 }, context)).toThrow("Scalar value is not finite");
  });

  it.each<[BinaryScalarOperation, number, number]>([
    ["add", Number.MAX_VALUE, Number.MAX_VALUE], ["subtract", -Number.MAX_VALUE, Number.MAX_VALUE],
    ["multiply", Number.MAX_VALUE, 2], ["power", -2, 0.5]
  ])("retains the finite-result error for %s", (type, left, right) => {
    expect(() => resolveScalar({ type, left, right }, context)).toThrow("Scalar expression result is not finite");
  });

  it("combines fractional division with explicit rounding for threshold calculations", () => {
    const ratio = resolveBinaryScalarOperation("divide", 7, 2);
    expect(ratio).toBe(3.5);
    expect(resolveUnaryScalarOperation("floor", ratio)).toBe(3);
    expect(resolveUnaryScalarOperation("ceil", ratio)).toBe(4);
    expect(resolveUnaryScalarOperation("round", ratio)).toBe(4);
    expect(resolveUnaryScalarOperation("abs", -ratio)).toBe(3.5);
  });

  it("defines negative rounding and remainder without implicitly clamping counters", () => {
    expect(resolveUnaryScalarOperation("floor", -2.5)).toBe(-3);
    expect(resolveUnaryScalarOperation("ceil", -2.5)).toBe(-2);
    expect(resolveUnaryScalarOperation("round", -2.5)).toBe(-2);
    expect(resolveBinaryScalarOperation("modulo", -7, 3)).toBe(-1);
    expect(resolveBinaryScalarOperation("modulo", 7, -3)).toBe(1);
    expect(resolveBinaryScalarOperation("modulo", 7.5, 2)).toBe(1.5);
  });

  it.each([0, -0])("rejects a zero divisor (%s) for both binary operations", divisor => {
    expect(() => resolveBinaryScalarOperation("divide", 2, divisor)).toThrow(/zero/);
    expect(() => resolveBinaryScalarOperation("modulo", 2, divisor)).toThrow(/zero/);
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite inputs (%s) even if an operation could hide them", value => {
    for (const type of ["divide", "modulo"] as const) {
      expect(() => resolveBinaryScalarOperation(type, value, 2)).toThrow(/finite/);
      expect(() => resolveBinaryScalarOperation(type, 2, value)).toThrow(/finite/);
    }
    for (const type of ["floor", "ceil", "round", "abs"] as const) {
      expect(() => resolveUnaryScalarOperation(type, value)).toThrow(/finite/);
    }
  });

  it("rejects finite operands whose quotient overflows", () => {
    expect(() => resolveBinaryScalarOperation("divide", Number.MAX_VALUE, Number.MIN_VALUE)).toThrow(/finite/);
    expect(resolveBinaryScalarOperation("divide", 0, Number.MIN_VALUE)).toBe(0);
  });
});
