export const BINARY_SCALAR_OPERATIONS = ["add", "subtract", "multiply", "power", "min", "max", "divide", "modulo"] as const;
export const UNARY_SCALAR_OPERATIONS = ["floor", "ceil", "round", "abs"] as const;

export type BinaryScalarOperation = typeof BINARY_SCALAR_OPERATIONS[number];
export type UnaryScalarOperation = typeof UNARY_SCALAR_OPERATIONS[number];

/** Interfaces allow callers to include these nodes in recursive scalar aliases. */
export interface BinaryArithmeticExpression<T> {
  readonly type: BinaryScalarOperation;
  readonly left: T;
  readonly right: T;
}

export interface UnaryArithmeticExpression<T> {
  readonly type: UnaryScalarOperation;
  readonly value: T;
}

export type ArithmeticExpression<T> = BinaryArithmeticExpression<T> | UnaryArithmeticExpression<T>;

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Scalar expression result is not finite");
  return value;
}

/** Preserve scalar arithmetic, including JavaScript's negative remainder convention. */
export function resolveBinaryScalarOperation(type: BinaryScalarOperation, left: number, right: number): number {
  switch (type) {
    case "add": return finite(left + right);
    case "subtract": return finite(left - right);
    case "multiply": return finite(left * right);
    case "power": return finite(left ** right);
    case "min": return finite(Math.min(left, right));
    case "max": return finite(Math.max(left, right));
    case "divide":
    case "modulo":
      // Division and remainder retain their existing operand checks.
      finite(left);
      finite(right);
      if (right === 0) throw new Error("Scalar division or modulo by zero");
      return finite(type === "divide" ? left / right : left % right);
  }
}

/** Round follows Math.round: halfway values are rounded toward positive infinity. */
export function resolveUnaryScalarOperation(type: UnaryScalarOperation, value: number): number {
  finite(value);
  switch (type) {
    case "floor": return finite(Math.floor(value));
    case "ceil": return finite(Math.ceil(value));
    case "round": return finite(Math.round(value));
    case "abs": return finite(Math.abs(value));
  }
}
