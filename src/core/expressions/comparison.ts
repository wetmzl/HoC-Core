export const COMPARISON_OPERATORS = ["eq", "neq", "lt", "lte", "gt", "gte"] as const;
export type ComparisonOperator = typeof COMPARISON_OPERATORS[number];

/** Compare numbers without coercion or changing the caller's missing-value policy. */
export function compareNumbers(left: number, operator: ComparisonOperator, right: number): boolean {
  if (operator === "eq") return left === right;
  if (operator === "neq") return left !== right;
  if (operator === "lt") return left < right;
  if (operator === "lte") return left <= right;
  if (operator === "gt") return left > right;
  return left >= right;
}
