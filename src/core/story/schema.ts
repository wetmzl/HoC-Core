import { z } from "zod";
import { PublicConditionSchema, PublicTriggerSpecSchema } from "../events/triggers";
import { PublicQuerySchema } from "../events/public-queries";
import type { StoryAction, StoryBinding, StoryCondition, StoryNode, StoryRun, StoryScene, StoryValue } from "./types";

export const STORY_LIMITS = Object.freeze({ depth: 32, values: 50_000, collection: 4096, text: 65_536, automaticSteps: 1024, callDepth: 32 });
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const sceneReference = z.string().max(400).regex(/^(?:[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*#)?[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,99}$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const extensionId = z.string().regex(/^[a-z][a-z0-9-]*(?::|\.)[a-z][a-z0-9._-]*$/);
const text = z.string().max(STORY_LIMITS.text);
const scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);
const mediaPath = z.string().max(1024).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/).refine(path => path.split("/").every(segment => segment !== "." && segment !== ".."), "媒体必须是包内相对路径");
const runtimeMediaPath = z.union([mediaPath, z.string().max(1400).regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*#/).refine(token => mediaPath.safeParse(token.slice(token.indexOf("#") + 1)).success)]);
const duration = z.number().finite().min(0).max(3_600_000);
const transform = { x: z.number().finite().min(-10000).max(10000).optional(), y: z.number().finite().min(-10000).max(10000).optional(), scale: z.number().finite().min(0).max(100).optional(), rotation: z.number().finite().min(-36000).max(36000).optional(), opacity: z.number().finite().min(0).max(1).optional() };

/** Validate the budget before Zod enters recursive conditions and timelines. */
export function boundedStoryJson<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.preprocess((input, context) => {
    const active = new WeakSet<object>();
    const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value: input, depth: 0 }];
    let values = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (item.leave) { active.delete(item.value as object); continue; }
      if (++values > STORY_LIMITS.values || item.depth > STORY_LIMITS.depth || typeof item.value === "string" && item.value.length > STORY_LIMITS.text) {
        context.addIssue({ code: "custom", message: "剧情声明超过深度、长度或节点预算" }); return z.NEVER;
      }
      if (!item.value || typeof item.value !== "object") continue;
      if (active.has(item.value)) { context.addIssue({ code: "custom", message: "剧情声明不得循环引用" }); return z.NEVER; }
      const children = Object.values(item.value);
      if (children.length > STORY_LIMITS.collection) { context.addIssue({ code: "custom", message: "剧情集合超过预算" }); return z.NEVER; }
      active.add(item.value); pending.push({ ...item, leave: true });
      for (const child of children) pending.push({ value: child, depth: item.depth + 1 });
    }
    return input;
  }, schema);
}
export const StoryValueSchema: z.ZodType<StoryValue> = z.union([
  z.object({ type: z.literal("literal"), value: scalar }).strict(),
  z.object({ type: z.literal("variable"), key }).strict(),
  z.object({ type: z.literal("query"), query: PublicQuerySchema }).strict()
]);
const conditionNode: z.ZodType<StoryCondition> = z.lazy(() => z.union([
  z.object({ type: z.enum(["all", "any"]), conditions: z.array(conditionNode).max(128) }).strict(),
  z.object({ type: z.literal("not"), condition: conditionNode }).strict(),
  z.object({ type: z.literal("public"), condition: PublicConditionSchema }).strict(),
  z.object({ type: z.literal("compare"), left: StoryValueSchema, operator: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]), right: StoryValueSchema }).strict()
]));
export const StoryConditionSchema = boundedStoryJson(conditionNode);
const args = z.record(key, z.json());
function makeActionSchema(media: z.ZodType<string>): z.ZodType<StoryAction> {
  const action: z.ZodType<StoryAction> = z.lazy(() => z.union([
  z.object({ type: z.enum(["sequence", "parallel"]), actions: z.array(action).max(128) }).strict(),
  z.object({ type: z.literal("wait"), durationMs: duration }).strict(),
  z.object({ type: z.literal("stage"), background: media.nullable().optional(), overlay: z.number().finite().min(0).max(1).optional(), actors: z.array(z.object({ id, image: media.optional(), visible: z.boolean().optional(), anchorX: z.number().finite().min(0).max(1).optional(), anchorY: z.number().finite().min(0).max(1).optional(), layer: z.number().int().min(-1000).max(1000).optional(), ...transform }).strict()).max(128).optional(), remove: z.array(id).max(128).optional() }).strict(),
  z.object({ type: z.literal("animate"), actor: id, durationMs: duration, delayMs: duration.optional(), easing: z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]).optional(), keyframes: z.array(z.object({ offset: z.number().finite().min(0).max(1).optional(), ...transform }).strict()).min(1).max(256) }).strict(),
  z.object({ type: z.literal("audio"), channel: z.enum(["sound", "voice", "music"]), operation: z.enum(["play", "stop"]), src: media.optional(), volume: z.number().finite().min(0).max(1).optional(), loop: z.boolean().optional(), fadeMs: duration.optional(), wait: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("extension"), typeId: extensionId, apiVersion: z.number().int().positive().max(10000), args, required: z.boolean().optional() }).strict()
  ]));
  return action;
}
const actionNode = makeActionSchema(mediaPath);
const runtimeActionNode = makeActionSchema(runtimeMediaPath);

function writes(action: StoryAction): Set<string> {
  if (action.type === "sequence" || action.type === "parallel") return new Set(action.actions.flatMap(child => [...writes(child)]));
  if (action.type === "animate") return new Set(action.keyframes.flatMap(frame => Object.keys(frame).filter(key => key !== "offset").map(key => `actor:${action.actor}:${key}`)));
  if (action.type === "stage") return new Set([
    ...(action.background !== undefined ? ["background"] : []), ...(action.overlay !== undefined ? ["overlay"] : []),
    ...(action.actors ?? []).flatMap(actor => Object.keys(actor).filter(key => key !== "id").map(key => `actor:${actor.id}:${key}`)),
    ...(action.remove ?? []).map(actor => `actor:${actor}:*`)
  ]);
  if (action.type === "audio") return new Set([`audio:${action.channel}`]);
  return new Set();
}
function collides(left: string, right: string): boolean { return left === right || left.endsWith(":*") && right.startsWith(left.slice(0, -1)) || right.endsWith(":*") && left.startsWith(right.slice(0, -1)); }
function validateAction(action: StoryAction, context: z.RefinementCtx, path: (string | number)[]): void {
  if (action.type === "parallel") {
    const occupied: string[] = [];
    action.actions.forEach((child, index) => {
      const properties = writes(child);
      for (const property of properties) {
        if (occupied.some(previous => collides(previous, property))) context.addIssue({ code: "custom", path: [...path, "actions", index], message: `并行动画争写属性：${property}` });
      }
      occupied.push(...properties);
    });
  }
  if (action.type === "sequence" || action.type === "parallel") action.actions.forEach((child, index) => validateAction(child, context, [...path, "actions", index]));
  if (action.type === "animate") {
    let offset = -1;
    action.keyframes.forEach((frame, index) => {
      const next = frame.offset ?? (action.keyframes.length === 1 ? 1 : index / (action.keyframes.length - 1));
      if (next < offset) context.addIssue({ code: "custom", path: [...path, "keyframes", index, "offset"], message: "关键帧 offset 必须递增" });
      offset = next;
      if (Object.keys(frame).every(key => key === "offset")) context.addIssue({ code: "custom", path: [...path, "keyframes", index], message: "关键帧必须声明变换属性" });
    });
  }
  if (action.type === "audio" && action.operation === "play" && !action.src) context.addIssue({ code: "custom", path, message: "播放音频必须声明 src" });
  if (action.type === "audio" && action.loop && action.wait) context.addIssue({ code: "custom", path, message: "循环音频不能等待播放结束" });
  if (action.type === "stage" && new Set((action.actors ?? []).map(actor => actor.id)).size !== (action.actors?.length ?? 0)) context.addIssue({ code: "custom", path, message: "同一舞台动作不得重复声明人物" });
}
export const StoryActionSchema = boundedStoryJson(actionNode.superRefine((action, context) => validateAction(action, context, [])));
function makeNodeSchema(action: z.ZodType<StoryAction>): z.ZodType<StoryNode> { return z.union([
  z.object({ id, type: z.literal("say"), speaker: text.optional(), segments: z.array(z.union([z.object({ text }).strict(), z.object({ pauseMs: duration }).strict()])).min(1).max(1024), speed: z.number().finite().min(1).max(1000).optional(), next: id }).strict(),
  z.object({ id, type: z.literal("choice"), prompt: text.optional(), options: z.array(z.object({ id, text, when: conditionNode.optional(), enabledWhen: conditionNode.optional(), disabledReason: text.optional(), next: id }).strict()).min(1).max(128), required: z.boolean().optional(), skipTo: id.optional() }).strict(),
  z.object({ id, type: z.literal("present"), action, next: id }).strict(),
  z.object({ id, type: z.literal("command"), command: z.object({ type: extensionId, apiVersion: z.number().int().positive().max(10000), args }).strict(), onSkip: z.literal("omit").optional(), next: id }).strict(),
  z.object({ id, type: z.literal("branch"), branches: z.array(z.object({ when: conditionNode, next: id }).strict()).max(128), otherwise: id }).strict(),
  z.object({ id, type: z.literal("set"), values: z.record(key, StoryValueSchema), next: id }).strict(),
  z.object({ id, type: z.literal("call"), sceneId: sceneReference, entry: id.optional(), next: id }).strict(),
  z.object({ id, type: z.literal("return") }).strict(),
  z.object({ id, type: z.literal("end"), result: scalar.optional() }).strict()
]); }
const nodeSchema = makeNodeSchema(actionNode);
const runtimeNodeSchema = makeNodeSchema(runtimeActionNode);
export const StorySceneSchema: z.ZodType<StoryScene> = boundedStoryJson(z.object({
  title: text.optional(), description: text.optional(), cover: mediaPath.optional(), archiveUnlock: PublicConditionSchema.optional(), entry: id, variables: z.record(key, scalar).optional(),
  actors: z.record(id, z.object({ name: text, image: mediaPath.optional(), images: z.record(id, mediaPath).optional(), scale: transform.scale }).strict()).optional(),
  nodes: z.array(nodeSchema).min(1).max(4096)
}).strict().superRefine((scene, context) => {
  const ids = new Set<string>();
  for (const [index, node] of scene.nodes.entries()) {
    if (ids.has(node.id)) context.addIssue({ code: "custom", path: ["nodes", index, "id"], message: "剧情节点 ID 重复" });
    ids.add(node.id);
  }
  if (!ids.has(scene.entry)) context.addIssue({ code: "custom", path: ["entry"], message: "剧情入口不存在" });
  for (const [index, node] of scene.nodes.entries()) {
    const targets = [
      ...("next" in node ? [node.next] : []),
      ...(node.type === "choice" ? [...node.options.map(option => option.next), ...(node.skipTo ? [node.skipTo] : [])] : []),
      ...(node.type === "branch" ? [...node.branches.map(branch => branch.next), node.otherwise] : [])
    ];
    for (const target of targets) if (!ids.has(target)) context.addIssue({ code: "custom", path: ["nodes", index], message: `目标剧情节点不存在：${target}` });
    if (node.type === "choice") {
      if (new Set(node.options.map(option => option.id)).size !== node.options.length) context.addIssue({ code: "custom", path: ["nodes", index, "options"], message: "选项 ID 重复" });
      if (node.required === false && !node.skipTo) context.addIssue({ code: "custom", path: ["nodes", index], message: "可跳过选项必须声明 skipTo" });
      if (node.required !== false && node.skipTo) context.addIssue({ code: "custom", path: ["nodes", index], message: "必选选项不得声明跳过路径" });
    }
    if (node.type === "present") validateAction(node.action, context, ["nodes", index, "action"]);
  }
}));
export const StoryBindingSchema: z.ZodType<StoryBinding> = boundedStoryJson(z.object({ sceneId: sceneReference, trigger: PublicTriggerSpecSchema, frequency: z.enum(["always", "round", "match", "flow", "game", "save"]).optional(), priority: z.number().int().min(-10000).max(10000).optional(), queue: z.enum(["append", "replace-pending", "drop-if-busy"]).optional(), recheck: z.boolean().optional(), scope: z.enum(["global", "match", "flow"]).optional() }).strict());
const anyId = z.string().min(1).max(1024);
const actorState = z.object({ id, image: runtimeMediaPath.optional(), visible: z.boolean(), x: transform.x.unwrap(), y: transform.y.unwrap(), scale: transform.scale.unwrap(), rotation: transform.rotation.unwrap(), opacity: transform.opacity.unwrap(), anchorX: z.number().finite().min(0).max(1), anchorY: z.number().finite().min(0).max(1), layer: z.number().int().min(-1000).max(1000) }).strict();
const command = z.object({ type: extensionId, apiVersion: z.number().int().positive().max(10000), args, id: anyId }).strict();
const waiting = z.union([
  z.object({ type: z.literal("say"), node: runtimeNodeSchema.refine(node => node.type === "say") }).strict(),
  z.object({ type: z.literal("choice"), node: runtimeNodeSchema.refine(node => node.type === "choice"), options: z.array(z.object({ id, text, enabled: z.boolean(), disabledReason: text.optional() }).strict()).max(128) }).strict(),
  z.object({ type: z.literal("presentation"), node: runtimeNodeSchema.refine(node => node.type === "present"), action: runtimeActionNode }).strict(),
  z.object({ type: z.literal("command"), node: runtimeNodeSchema.refine(node => node.type === "command"), intent: command }).strict()
]);
/** A separately versioned host envelope may embed this stable, JSON-only semantic checkpoint. */
export const StoryRunSchema: z.ZodType<StoryRun> = boundedStoryJson(z.object({
  id: anyId, sceneId: sceneReference, cursor: id, stack: z.array(z.object({ sceneId: sceneReference, cursor: id }).strict()).max(STORY_LIMITS.callDepth),
  variables: z.record(key, scalar), stage: z.object({ background: runtimeMediaPath.nullable().optional(), overlay: z.number().finite().min(0).max(1), actors: z.record(id, actorState) }).strict(),
  lastSpeaker: z.object({ sceneId: sceneReference, actorId: id }).strict().optional(),
  status: z.enum(["running", "waiting", "completed", "skipped", "interrupted", "failed"]), waiting: waiting.optional(), skipping: z.boolean(), sequence: z.number().int().nonnegative().safe(),
  choices: z.array(z.object({ sceneId: sceneReference, nodeId: id, optionId: id }).strict()).max(4096), receipts: z.array(z.object({ id: anyId, result: z.record(key, scalar).optional() }).strict()).max(4096), error: text.optional(), result: scalar.optional()
}).strict().superRefine((run, context) => {
  if (run.status === "waiting" && !run.waiting) context.addIssue({ code: "custom", path: ["waiting"], message: "等待中的剧情缺少当前节点" });
  if (run.waiting && run.waiting.node.id !== run.cursor) context.addIssue({ code: "custom", path: ["waiting"], message: "剧情等待节点与游标不一致" });
  if (run.waiting?.type === "presentation") validateAction(run.waiting.action, context, ["waiting", "action"]);
}) as z.ZodType<StoryRun>);
