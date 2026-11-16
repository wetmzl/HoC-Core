import { describe, expect, it } from "vitest";
import { compareNumbers, type ComparisonOperator } from "./comparison";

describe("shared numeric comparisons", () => {
  it.each<[number, number, readonly ComparisonOperator[]]>([
    [2, 2, ["eq", "lte", "gte"]],
    [-2, 2, ["neq", "lt", "lte"]],
    [2, -2, ["neq", "gt", "gte"]],
    [-0, 0, ["eq", "lte", "gte"]],
    [0.1 + 0.2, 0.3, ["neq", "gt", "gte"]]
  ])("preserves exact numeric comparisons for %s and %s", (left, right, expected) => {
    for (const operator of ["eq", "neq", "lt", "lte", "gt", "gte"] as const) {
      expect(compareNumbers(left, operator, right)).toBe(expected.includes(operator));
    }
  });

  it("leaves non-finite observation policy with the caller", () => {
    expect(compareNumbers(NaN, "eq", NaN)).toBe(false);
    expect(compareNumbers(NaN, "neq", NaN)).toBe(true);
    expect(compareNumbers(Infinity, "gt", 1)).toBe(true);
    expect(compareNumbers(-Infinity, "lt", 1)).toBe(true);
  });
});
