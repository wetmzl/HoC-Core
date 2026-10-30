export type BinaryScalarOperation = "divide" | "modulo";
export type UnaryScalarOperation = "floor" | "ceil" | "round" | "abs";

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Scalar expression result is not finite");
  return value;
}

/** Modulo uses the JavaScript remainder convention, including a negative dividend. */
export function resolveBinaryScalarOperation(type: BinaryScalarOperation, left: number, right: number): number {
  finite(left);
  finite(right);
  if (right === 0) throw new Error("Scalar division or modulo by zero");
  return finite(type === "divide" ? left / right : left % right);
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
