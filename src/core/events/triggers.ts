import { z } from "zod";
import { compareNumbers } from "../expressions/comparison";
import { PUBLIC_EVENT_SCOPE_NAMES, type PublicEvent, type PublicEventBatch, type PublicScalar } from "./public-events";
import { PublicQuerySchema, createPublicQueryContext, readPublicQuery, type PublicQuery, type PublicQueryContext } from "./public-queries";
import { getPublicEventDeclaration } from "./public-event-catalog";

export type PublicValue = { readonly type: "literal"; readonly value: PublicScalar } | { readonly type: "query"; readonly query: PublicQuery };
export type PublicCondition =
  | { readonly type: "all" | "any"; readonly conditions: readonly PublicCondition[] }
  | { readonly type: "not"; readonly condition: PublicCondition }
  | { readonly type: "available"; readonly query: PublicQuery }
  | { readonly type: "compare"; readonly left: PublicValue; readonly operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; readonly right: PublicValue };
export const PublicValueSchema: z.ZodType<PublicValue> = z.union([
  z.object({ type: z.literal("literal"), value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ type: z.literal("query"), query: PublicQuerySchema }).strict()
]);
export const PUBLIC_TRIGGER_LIMITS = Object.freeze({ depth: 32, nodes: 4096 });
function bounded<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.preprocess((input, context) => {
    const active = new WeakSet<object>();
    const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value: input, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (item.leave) { active.delete(item.value as object); continue; }
      if (++nodes > PUBLIC_TRIGGER_LIMITS.nodes || item.depth > PUBLIC_TRIGGER_LIMITS.depth) {
        context.addIssue({ code: "custom", message: "公共触发声明超过深度或节点预算" }); return z.NEVER;
      }
      if (item.value === null || typeof item.value !== "object") continue;
      if (active.has(item.value)) { context.addIssue({ code: "custom", message: "公共触发声明不得循环引用" }); return z.NEVER; }
      active.add(item.value);
      pending.push({ ...item, leave: true });
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
    return input;
  }, schema);
}
const ConditionNodeSchema: z.ZodType<PublicCondition> = z.lazy(() => z.union([
  z.object({ type: z.enum(["all", "any"]), conditions: z.array(ConditionNodeSchema).max(128) }).strict(),
  z.object({ type: z.literal("not"), condition: ConditionNodeSchema }).strict(),
  z.object({ type: z.literal("available"), query: PublicQuerySchema }).strict(),
  z.object({ type: z.literal("compare"), left: PublicValueSchema, operator: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]), right: PublicValueSchema }).strict()
]));
export const PublicConditionSchema = bounded(ConditionNodeSchema);
export const PublicTriggerSpecSchema = bounded(z.object({
  on: z.array(z.string().min(1).max(200).refine(type => Boolean(getPublicEventDeclaration(type)), "未知公共事件类型")).min(1).max(128).optional(),
  scope: z.object({ name: z.enum(PUBLIC_EVENT_SCOPE_NAMES), id: z.string().min(1).optional() }).strict().optional(),
  when: PublicConditionSchema.optional()
}).strict());
export type TriggerSpec = z.infer<typeof PublicTriggerSpecSchema>;
export type PublicTriggerSpec = TriggerSpec;

function value(input: PublicValue, context: PublicQueryContext): PublicScalar | undefined {
  return input.type === "literal" ? input.value : readPublicQuery(input.query, context);
}
function evaluate(input: PublicCondition, context: PublicQueryContext): boolean | undefined {
  if (input.type === "available") return readPublicQuery(input.query, context) !== undefined;
  if (input.type === "not") {
    const child = evaluate(input.condition, context); return child === undefined ? undefined : !child;
  }
  if (input.type === "all" || input.type === "any") {
    const children = input.conditions.map(condition => evaluate(condition, context));
    return input.type === "all" ? children.includes(false) ? false : children.includes(undefined) ? undefined : true
      : children.includes(true) ? true : children.includes(undefined) ? undefined : false;
  }
  if (input.type !== "compare") return undefined;
  const left = value(input.left, context), right = value(input.right, context);
  if (left === undefined || right === undefined) return undefined;
  if (input.operator === "eq") return left === right;
  if (input.operator === "neq") return left !== right;
  return typeof left === "number" && typeof right === "number" ? compareNumbers(left, input.operator, right) : undefined;
}
export function evaluatePublicCondition(condition: PublicCondition, context: PublicQueryContext): boolean | undefined {
  const parsed = PublicConditionSchema.safeParse(condition);
  return parsed.success ? evaluate(parsed.data, createPublicQueryContext(context)) : undefined;
}
export function matchPublicTrigger(spec: TriggerSpec, event: PublicEvent, batch: PublicEventBatch): boolean {
  const parsed = PublicTriggerSpecSchema.safeParse(spec);
  if (!parsed.success || batch.restored) return false;
  const input = parsed.data;
  if (input.on && !input.on.includes(event.type)) return false;
  if (input.scope && (!event.scopes[input.scope.name] || input.scope.id !== undefined && event.scopes[input.scope.name] !== input.scope.id)) return false;
  return !input.when || evaluate(input.when, createPublicQueryContext({ event, batch })) === true;
}
export function selectPublicTriggerEvents(spec: TriggerSpec, batch: PublicEventBatch): readonly PublicEvent[] {
  return batch.restored ? [] : batch.facts.filter(event => matchPublicTrigger(spec, event, batch));
}
