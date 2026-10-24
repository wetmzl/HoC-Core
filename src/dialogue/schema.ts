import { z } from "zod";
import { HocpkgPortablePathSchema } from "../content/packages/schema";
import { boundedContentJson, assertContentJsonBudget } from "../content/packages/json-budget";
import type { CharacterDialogue, DialogueCondition, DialoguePortrait } from "./types";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);
const range = z.object({ min: z.number().finite().optional(), max: z.number().finite().optional(), minInclusive: z.boolean().optional(), maxInclusive: z.boolean().optional() }).strict().superRefine((v, ctx) => {
  if (v.min === undefined && v.max === undefined) ctx.addIssue({ code: "custom", message: "区间至少包含一个边界" });
  if (v.min !== undefined && v.max !== undefined && (v.min > v.max || (v.min === v.max && (v.minInclusive === false || v.maxInclusive === false)))) ctx.addIssue({ code: "custom", message: "概率或数值区间为空" });
});
const recursive: z.ZodType<DialogueCondition> = z.lazy(() => z.union([
  z.object({ primitive: z.string().min(1), apiVersion: z.number().int().positive(), args: z.record(z.string(), z.unknown()), test: z.union([z.object({ eq: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]) }).strict(), z.object({ range }).strict()]) }).strict(),
  z.object({ all: z.array(recursive).min(1) }).strict(), z.object({ any: z.array(recursive).min(1) }).strict(), z.object({ not: recursive }).strict()
]));
export const DialogueConditionSchema = z.preprocess((value, ctx) => {
  try { assertContentJsonBudget(value); }
  catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > 32) { ctx.addIssue({ code: "custom", message: "对白条件嵌套超过32层" }); return null; }
    if (item.value && typeof item.value === "object") for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  return value;
}, recursive);
export const DialoguePortraitSchema = z.object({ image: HocpkgPortablePathSchema.refine(v => /\.(png|webp|jpe?g)$/i.test(v), "立绘必须是图片路径"), alt: z.string().min(1).optional(), scale: z.number().finite().min(0.75).max(1.5).optional(), revolverPlacement: z.object({ top: z.number().finite(), left: z.number().finite() }).strict().optional() }).strict();
/** Runtime URLs have already passed package-path validation. */
const runtimePortrait = DialoguePortraitSchema.extend({ image: z.string().min(1) });
const lines = z.array(z.string().min(1)).min(1);
const extensions = z.record(z.string().regex(/^[a-z0-9_-]+\/[a-z0-9_-]+$/), z.record(z.string(), z.unknown()));
const pool = z.union([lines, z.object({ lines, extensions: extensions.optional() }).strict()]);
function program(portrait: z.ZodType<DialoguePortrait, unknown>) {
  return z.object({ pools: z.record(id, pool), poolExtensions: z.record(id, extensions).optional(), rules: z.array(z.object({ id, on: z.array(z.object({ type: z.string().regex(/^(?:core\.[a-z][a-z0-9-]*|[a-z0-9_-]+\/[a-z0-9_-]+#[a-z][a-z0-9-]*)$/), apiVersion: z.number().int().positive() }).strict()).min(1), when: DialogueConditionSchema, poolId: id, anchor: z.enum(["dialogue-event", "round-start", "last-action", "last-player-action", "last-opponent-action", "round-result", "round-acknowledged", "trigger-result"]).optional(), portrait: portrait.optional() }).strict()).max(10000), fallbackPoolId: id }).strict().superRefine((v, ctx) => {
    if (!Object.hasOwn(v.pools, v.fallbackPoolId)) ctx.addIssue({ code: "custom", path: ["fallbackPoolId"], message: "必须存在 fallback 对白池" });
    for (const poolId of Object.keys(v.poolExtensions ?? {})) {
      if (!Object.hasOwn(v.pools, poolId)) ctx.addIssue({ code: "custom", path: ["poolExtensions", poolId], message: "扩展必须对应已存在的对白池" });
      const entry = v.pools[poolId];
      if (entry && !Array.isArray(entry) && entry.extensions) ctx.addIssue({ code: "custom", path: ["pools", poolId], message: "对白池扩展不得重复声明" });
    }
    const seen = new Set<string>();
    v.rules.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: "规则 ID 重复" });
      seen.add(r.id);
      if (!Object.hasOwn(v.pools, r.poolId)) ctx.addIssue({ code: "custom", path: ["rules", i, "poolId"], message: "对白池引用不存在" });
    });
  }).transform(v => {
    const poolExtensions = { ...v.poolExtensions };
    const pools = Object.fromEntries(Object.entries(v.pools).map(([key, entry]) => {
      if (Array.isArray(entry)) return [key, entry];
      if (entry.extensions) poolExtensions[key] = entry.extensions;
      return [key, entry.lines];
    }));
    return { ...v, pools, ...(Object.keys(poolExtensions).length ? { poolExtensions } : {}) };
  });
}
export const CharacterDialogueResourceSchema: z.ZodType<CharacterDialogue, unknown> = boundedContentJson(program(DialoguePortraitSchema));
export const CharacterDialogueSchema: z.ZodType<CharacterDialogue, unknown> = boundedContentJson(program(runtimePortrait));
