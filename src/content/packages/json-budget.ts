import { z } from "zod";

/** Bounds are checked before recursive validators can accumulate element errors. */
export const CONTENT_JSON_LIMITS = Object.freeze({ depth: 64, nodes: 100_000, collection: 10_000, string: 2 * 1024 * 1024 });

export function assertContentJsonBudget(input: unknown): void {
  const pending = [{ value: input, depth: 0 }];
  let nodes = 1;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > CONTENT_JSON_LIMITS.depth) throw new Error("内容 JSON 嵌套超过 64 层限制");
    if (typeof value === "string" && value.length > CONTENT_JSON_LIMITS.string) throw new Error("内容 JSON 字符串超过长度限制");
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value) && value.length > CONTENT_JSON_LIMITS.collection) throw new Error("内容 JSON 集合超过 10000 项限制");
    let entries = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++entries > CONTENT_JSON_LIMITS.collection) throw new Error("内容 JSON 集合超过 10000 项限制");
      if (++nodes > CONTENT_JSON_LIMITS.nodes) throw new Error("内容 JSON 超过 100000 个节点限制");
      pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
}

export function boundedContentJson<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, ctx) => {
    try { assertContentJsonBudget(value); }
    catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
    return value;
  }, schema);
}
