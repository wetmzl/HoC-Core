import { matchesSkillCard } from "../abilities/skill-card-selection";
import { BINARY_SCALAR_OPERATIONS, UNARY_SCALAR_OPERATIONS, resolveBinaryScalarOperation, resolveUnaryScalarOperation,
  type BinaryScalarOperation, type UnaryScalarOperation } from "../expressions/arithmetic";
import { compareNumbers } from "../expressions/comparison";
import { AchievementNumberSchema, AchievementValueSchema, AchievementConditionSchema } from "./schema";
import type { AchievementCondition, AchievementMetric, AchievementNumber, AchievementObservation, AchievementScalarValue, AchievementValue } from "./types";

export interface AchievementReadContext {
  readonly observation: AchievementObservation;
  readonly metrics: Readonly<Record<string, AchievementMetric>>;
  readonly onUnavailable?: (message: string) => void;
}
function unavailable(context: AchievementReadContext, message: string): undefined {
  context.onUnavailable?.(message); return undefined;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}
function read(key: string, context: AchievementReadContext): AchievementScalarValue | undefined {
  if (!Object.hasOwn(context.observation.values, key)) return unavailable(context, `观察值不可用：${key}`);
  const value = context.observation.values[key];
  return value === null || typeof value === "string" || typeof value === "boolean" || finite(value)
    ? value : unavailable(context, `观察值类型无效：${key}`);
}
function number(expression: AchievementNumber, context: AchievementReadContext): number | undefined {
  if (typeof expression === "number") return finite(expression) ? expression : unavailable(context, "数值超出有限安全范围");
  if (expression.type === "constant") return finite(expression.value) ? expression.value : unavailable(context, "常量超出有限安全范围");
  if (expression.type === "observation") {
    const value = read(expression.key, context);
    return finite(value) ? value : unavailable(context, `观察值不是数字：${expression.key}`);
  }
  if (expression.type === "metric") {
    const metric = Object.hasOwn(context.metrics, expression.id) ? context.metrics[expression.id] : undefined;
    const value = metric?.type === "distinct" ? metric.values.length : metric?.value;
    return finite(value) ? value : unavailable(context, `统计值不可用：${expression.id}`);
  }
  if (expression.type === "skill-card-count") {
    const cards = Object.hasOwn(context.observation.skillCards, expression.collection) ? context.observation.skillCards[expression.collection] : undefined;
    return cards ? cards.filter(card => matchesSkillCard(card, expression.filter)).length : unavailable(context, `技能集合不可用：${expression.collection}`);
  }
  try {
    let result: number;
    if (BINARY_SCALAR_OPERATIONS.includes(expression.type as BinaryScalarOperation) && "left" in expression) {
      const left = number(expression.left, context), right = number(expression.right, context);
      if (left === undefined || right === undefined) return undefined;
      result = resolveBinaryScalarOperation(expression.type as BinaryScalarOperation, left, right);
    } else if (UNARY_SCALAR_OPERATIONS.includes(expression.type as UnaryScalarOperation) && "value" in expression) {
      const operand = number(expression.value, context);
      if (operand === undefined) return undefined;
      result = resolveUnaryScalarOperation(expression.type as UnaryScalarOperation, operand);
    } else return unavailable(context, "未知数值表达式");
    return finite(result) ? result : unavailable(context, "算术结果超出有限安全范围");
  } catch { return unavailable(context, "算术表达式不可用（零除、非有限值或非法操作）"); }
}
function value(expression: AchievementValue, context: AchievementReadContext): AchievementScalarValue | undefined {
  if (expression.type === "numeric") return number(expression.value, context);
  if (expression.type === "observation") return read(expression.key, context);
  return typeof expression.value !== "number" || finite(expression.value) ? expression.value : unavailable(context, "字面值不是有限数字");
}
function condition(expression: AchievementCondition, context: AchievementReadContext): boolean | undefined {
  if (expression.type === "topic-is") return expression.topic.type === context.observation.topic.type && expression.topic.apiVersion === context.observation.topic.apiVersion;
  if (expression.type === "available") return Object.hasOwn(context.observation.values, expression.key);
  if (expression.type === "not") {
    const child = condition(expression.condition, context); return child === undefined ? undefined : !child;
  }
  if (expression.type === "all" || expression.type === "any") {
    // Evaluate all children so missing-data diagnostics are independent of declaration order.
    const children = expression.conditions.map(child => condition(child, context));
    if (expression.type === "all") return children.includes(false) ? false : children.includes(undefined) ? undefined : true;
    return children.includes(true) ? true : children.includes(undefined) ? undefined : false;
  }
  if (expression.type === "scalar-compare") {
    const left = number(expression.left, context), right = number(expression.right, context);
    return left === undefined || right === undefined ? undefined : compareNumbers(left, expression.operator, right);
  }
  if (expression.type === "value-compare") {
    const left = value(expression.left, context), right = value(expression.right, context);
    return left === undefined || right === undefined ? undefined : expression.operator === "eq" ? left === right : left !== right;
  }
  return undefined;
}

/** unknown propagates through not; only an explicitly true root proves completion. */
export function evaluateAchievementCondition(expression: AchievementCondition, context: AchievementReadContext): boolean | undefined {
  return condition(AchievementConditionSchema.parse(expression), context);
}
export function evaluateAchievementNumber(expression: AchievementNumber, context: AchievementReadContext): number | undefined {
  return number(AchievementNumberSchema.parse(expression), context);
}
export function evaluateAchievementValue(expression: AchievementValue, context: AchievementReadContext): AchievementScalarValue | undefined {
  return value(AchievementValueSchema.parse(expression), context);
}
