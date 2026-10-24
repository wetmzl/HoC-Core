import { z } from "zod";
import type { PluginRuntimeContribution } from "./plugin-contracts";

export interface PluginTutorialImageResource {
  readonly type: "image";
  readonly src: string;
  readonly alt: string;
  readonly caption?: string;
}
export type PluginTutorialResource = PluginTutorialImageResource;
export interface PluginTutorialPage {
  readonly body: string;
  readonly resources?: readonly PluginTutorialResource[];
}
export interface PluginTutorialDefinition {
  /** Stable within the package, including when multiple modules share one package. */
  readonly id: string;
  readonly title: string;
  readonly pages: readonly [PluginTutorialPage, ...PluginTutorialPage[]];
  readonly presentation?: "popover" | "sidebar" | "modal";
  /** Null disables automatic dismissal. Omitted values use the presentation default. */
  readonly autoSkipMs?: number | null;
}
export interface PluginTutorialShowOptions {
  /** Explicit player-requested review may show an already completed tutorial. */
  readonly replay?: boolean;
  readonly signal?: AbortSignal;
}
export interface PluginTutorialApi {
  /** Cancelling removes the request without marking the tutorial completed. */
  show(definition: PluginTutorialDefinition, options?: PluginTutorialShowOptions): () => void;
  isCompleted(id: string): boolean;
}

const tutorialIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(80);

function safeImageUrl(value: string): boolean {
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^data:/i.test(value)) return /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[a-zA-Z0-9+/]+={0,2}$/i.test(value);
  const origin = typeof location === "undefined" ? "https://hoc.invalid" : location.origin;
  try {
    const url = new URL(value, `${origin}/`);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
    if (url.protocol === "blob:") return url.origin === origin;
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

const resourceSchema = z.object({
  type: z.literal("image"),
  src: z.string().min(1).max(2_000_000).refine(safeImageUrl, "教程图片 URL 不受支持"),
  alt: z.string().max(500),
  caption: z.string().max(1_000).optional()
}).strict();
const definitionSchema = z.object({
  id: tutorialIdSchema,
  title: z.string().trim().min(1).max(120),
  pages: z.array(z.object({
    body: z.string().trim().min(1).max(8_000),
    resources: z.array(resourceSchema).max(8).optional()
  }).strict()).min(1).max(32),
  presentation: z.enum(["popover", "sidebar", "modal"]).optional(),
  autoSkipMs: z.number().int().min(1_000).max(300_000).nullable().optional()
}).strict();

/** Parse, copy and freeze plugin data before it becomes a queued presentation. */
export function validatePluginTutorialDefinition(input: unknown): PluginTutorialDefinition {
  const parsed = definitionSchema.parse(input);
  const pages = parsed.pages.map(page => Object.freeze({
    ...page,
    ...(page.resources ? { resources: Object.freeze(page.resources.map(resource => Object.freeze(resource))) } : {})
  }));
  return Object.freeze({ ...parsed, pages: Object.freeze(pages) }) as PluginTutorialDefinition;
}

/** Version-independent package scope, disjoint from all built-in completion IDs. */
export function pluginTutorialProgressId(packageId: string, id: string): string {
  tutorialIdSchema.parse(id);
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(packageId)) throw new Error("教程包身份无效");
  const key = `plugin:${packageId}:${id}`;
  if (key.length > 128) throw new Error("教程包身份与 ID 合计过长，完成标识最多 128 个字符");
  return key;
}

export interface PluginTutorialIdentity {
  readonly packageId: string;
  readonly apiVersion: number;
}
const identities = new WeakMap<PluginRuntimeContribution, PluginTutorialIdentity>();

/** Only the loader binds ownership; plugin-supplied object fields have no authority. */
export function bindPluginTutorialIdentity<T extends PluginRuntimeContribution>(contribution: T, identity: PluginTutorialIdentity): T {
  identities.set(contribution, Object.freeze({ ...identity }));
  return contribution;
}
export function getPluginTutorialIdentity(contribution: PluginRuntimeContribution): PluginTutorialIdentity | undefined {
  return identities.get(contribution);
}
