import { describe, expect, it } from "vitest";
import { resolveBinaryScalarOperation, resolveUnaryScalarOperation } from "./scalar-operations";

describe("scalar operations", () => {
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
