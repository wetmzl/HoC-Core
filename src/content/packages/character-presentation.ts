import { z } from "zod";
import { HocpkgPortablePathSchema, HocpkgResourceKeySchema } from "./schema";
import { DialoguePortraitSchema } from "../../dialogue/schema";
import { boundedContentJson } from "./json-budget";
import type { HocpkgResourceHandler } from "./resources";
import { SkinUnlockConditionSchema } from "../characters/skin-unlock";

const id = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/);
export const CharacterSkinPreferencesSchema = z.record(HocpkgResourceKeySchema, id);
export type CharacterSkinPreferences = z.infer<typeof CharacterSkinPreferencesSchema>;
/** Locale is an independent selector, reserved for a later localization implementation. */
export interface PresentationContext { readonly skinId?: string; readonly locale?: string }
export const PresentationReferenceSchema = z.object({
  presentationRef: id,
  path: z.string().regex(/^(?:\/(?:[^~]|~[01])*)?$/).optional()
}).strict();
export type PresentationReference = z.infer<typeof PresentationReferenceSchema>;
export function isPresentationReference(value: unknown): value is PresentationReference {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "presentationRef");
}

export const CharacterPresentationSchema = boundedContentJson(z.object({
  skins: z.array(z.object({ id, name: z.string().trim().min(1).max(80), unlock: SkinUnlockConditionSchema.optional() }).strict()).min(1).max(128),
  resources: z.record(id, z.object({
    type: z.enum(["text", "image", "audio", "portrait", "data"]),
    variants: z.array(z.object({ skinId: id, value: z.unknown() }).strict()).min(1).max(128)
  }).strict())
}).strict().superRefine((value, ctx) => {
  const skins = new Set(value.skins.map(skin => skin.id));
  if (skins.size !== value.skins.length) ctx.addIssue({ code: "custom", path: ["skins"], message: "皮肤 ID 必须唯一" });
  if (Object.keys(value.resources).length > 4096) ctx.addIssue({ code: "custom", path: ["resources"], message: "表现资源不得超过4096项" });
  for (const [key, resource] of Object.entries(value.resources)) {
    const seen = new Set<string>();
    resource.variants.forEach((entry, index) => {
      const path = ["resources", key, "variants", index];
      if (!skins.has(entry.skinId) || seen.has(entry.skinId)) ctx.addIssue({ code: "custom", path, message: "资源皮肤必须已声明且不可重复" });
      seen.add(entry.skinId);
      const schema = resource.type === "portrait" ? DialoguePortraitSchema : resource.type === "data" ? z.unknown()
        : resource.type === "text" ? z.string() : HocpkgPortablePathSchema;
      if (!Object.hasOwn(entry, "value") || !schema.safeParse(entry.value).success) ctx.addIssue({ code: "custom", path, message: `表现资源值与 ${resource.type} 类型不符` });
    });
  }
}));
export type CharacterPresentation = z.infer<typeof CharacterPresentationSchema>;

function project(value: unknown, path = ""): unknown {
  for (const segment of path ? path.slice(1).split("/") : []) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`表现资源字段不存在：${path}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** No deep merging: every reference selects one complete value before projecting a field. */
export function resolvePresentation(value: unknown, presentation: CharacterPresentation, context: PresentationContext = {}): unknown {
  let nodes = 0;
  const visit = (value: unknown, trail: readonly string[] = [], depth = 0): unknown => {
    if (++nodes > 100_000 || depth > 64) throw new Error("表现资源展开超过内容 JSON 预算");
    if (isPresentationReference(value)) {
      const ref = PresentationReferenceSchema.parse(value);
      if (trail.includes(ref.presentationRef)) throw new Error(`表现资源引用成环：${[...trail, ref.presentationRef].join(" -> ")}`);
      const resource = Object.hasOwn(presentation.resources, ref.presentationRef) ? presentation.resources[ref.presentationRef] : undefined;
      if (!resource) throw new Error(`表现资源不存在：${ref.presentationRef}`);
      const variant = resource.variants.find(entry => entry.skinId === (context.skinId ?? presentation.skins[0].id)) ?? resource.variants[0];
      return project(visit(variant.value, [...trail, ref.presentationRef], depth + 1), ref.path);
    }
    if (Array.isArray(value)) return value.map(entry => visit(entry, trail, depth + 1));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry, trail, depth + 1)]));
  };
  return visit(value);
}

/** Resolve selected media only. An unreadable alternate falls back as a complete resource. */
export function createPresentationResolver(presentation: CharacterPresentation, context: PresentationContext, options: {
  resolvePath(path: string): string | Promise<string>;
  onFallback?(resourceId: string, skinId: string, error: unknown): void;
}) {
  const cache = new Map<string, Promise<unknown>>();
  let nodes = 0;
  const visit = async (value: unknown, trail: readonly string[] = [], depth = 0): Promise<unknown> => {
    if (++nodes > 100_000 || depth > 64) throw new Error("表现资源展开超过内容 JSON 预算");
    if (isPresentationReference(value)) {
      const ref = PresentationReferenceSchema.parse(value), key = ref.presentationRef;
      if (trail.includes(key)) throw new Error(`表现资源引用成环：${[...trail, key].join(" -> ")}`);
      const resource = Object.hasOwn(presentation.resources, key) ? presentation.resources[key] : undefined;
      if (!resource) throw new Error(`表现资源不存在：${key}`);
      let pending = cache.get(key);
      if (!pending) {
        const selected = resource.variants.find(entry => entry.skinId === (context.skinId ?? presentation.skins[0].id)) ?? resource.variants[0];
        const prepare = async (variant: typeof selected) => {
          const resolved = await visit(variant.value, [...trail, key], depth + 1);
          const path = resource.type === "image" || resource.type === "audio" ? resolved as string
            : resource.type === "portrait" ? (resolved as { image: string }).image : undefined;
          if (path) await options.resolvePath(path);
          return resolved;
        };
        pending = prepare(selected).catch(error => {
          if (selected === resource.variants[0]) throw error;
          options.onFallback?.(key, selected.skinId, error);
          return prepare(resource.variants[0]);
        });
        cache.set(key, pending);
      }
      return project(await pending, ref.path);
    }
    if (Array.isArray(value)) return Promise.all(value.map(entry => visit(entry, trail, depth + 1)));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await visit(entry, trail, depth + 1)])));
  };
  return visit;
}

/** Explicit host fields prevent a skin from changing identity, AI, effects or unlocks. */
export function assertPresentationReferencesAllowed(value: unknown, type: string, pluginAllows?: (path: readonly string[]) => boolean): number {
  let references = 0;
  const visit = (entry: unknown, path: string[]): void => {
    if (isPresentationReference(entry)) {
      references++;
      const [root, field] = path;
      const allowed = type.startsWith("plugin.") ? pluginAllows?.(path) === true
        : type === "game.character-match" ? root === "metadata" && ["name", "subtitle", "previewImage", "previewFocus", "badge", "portraitScales", "matchMusic"].includes(field)
          || root === "definition" && ["assets", "profile", "matchSummary", "revolverPlacement", "tablePortrait"].includes(field)
        : type === "game.character-dialogue" ? ["pools", "poolPortraits", "poolExtensions"].includes(root) || root === "rules" && path[2] === "portrait"
        : ["game.ai-skill", "game.talent", "game.status"].includes(type) ? ["name", "description", "profileLore", "usage"].includes(root)
        : type === "game.player-skill" ? root === "definition" && ["name", "description", "profileLore", "usage"].includes(field)
        : type === "presentation.faction" && ["name", "badge", "matchMusic"].includes(root);
      if (!allowed) throw new Error(`字段不允许引用表现资源：${type}/${path.join("/")}`);
      PresentationReferenceSchema.parse(entry);
      return;
    }
    if (Array.isArray(entry)) entry.forEach((item, index) => visit(item, [...path, String(index)]));
    else if (entry && typeof entry === "object") for (const [key, item] of Object.entries(entry)) visit(item, [...path, key]);
  };
  visit(value, []);
  return references;
}

export function createCharacterPresentationHandler(): HocpkgResourceHandler<CharacterPresentation> {
  return { type: "presentation.character", apiVersions: [1, 2], parse(payload, context) {
    const parsed = CharacterPresentationSchema.parse(payload);
    if (parsed.skins.some(skin => skin.unlock) && context.descriptor.apiVersion < 2) throw new Error("皮肤解锁条件需要 presentation.character API 2");
    if (context.manifest.resources.filter(resource => resource.type === "presentation.character").length !== 1) throw new Error("一个角色包只能声明一份角色表现资源");
    for (const [key, resource] of Object.entries(parsed.resources)) for (const variant of resource.variants) {
      // Validate every authored variant, including currently unselected ones, without allocating media URLs.
      const resolved = resolvePresentation({ presentationRef: key }, parsed, { skinId: variant.skinId });
      const path = resource.type === "image" || resource.type === "audio" ? resolved as string
        : resource.type === "portrait" ? (resolved as { image: string }).image : undefined;
      if (path && !context.manifest.files.some(file => file.path === path && file.mediaType.startsWith(resource.type === "audio" ? "audio/" : "image/"))) throw new Error(`表现媒体未声明或类型不符：${path}`);
    }
    return parsed;
  } };
}
