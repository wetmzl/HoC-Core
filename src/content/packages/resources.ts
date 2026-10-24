import { z } from "zod";
import { CharacterDialogueResourceSchema } from "../../dialogue/schema";
import { activeDialogueRegistry, type DialoguePrimitiveRegistry } from "../../dialogue/registry";
import type { DialogueCondition } from "../../dialogue/types";
import type { CharacterDialogue } from "../../dialogue/types";
import { AbilityDefinitionSchema, StatusDefinitionSchema, validateBinding } from "../../core/abilities/schema";
import type { AiSkillAbilityDefinition, StatusDefinition, TalentAbilityDefinition } from "../../core/abilities/types";
import type { HocpkgManifest, HocpkgResourceDescriptor } from "./schema";
import { HocpkgPortablePathSchema, HocpkgResourceKeySchema } from "./schema";
import { tablePortraitSchema } from "../characters/table-portrait";
import { boundedContentJson } from "./json-budget";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const resourceReference = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/);
const relativeImage = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*\.(?:png|webp|jpg|jpeg)$/i);
const relativeAudio = HocpkgPortablePathSchema.refine(path => /\.(?:ogg|opus|mp3|wav|m4a)$/i.test(path), "音乐必须是包内音频路径");
export const TablePortraitResourceSchema = tablePortraitSchema(relativeImage);
const characterTag = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/);
const characterUnlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("defeat-any") }).strict(),
  z.object({ type: z.literal("defeat-count"), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("defeat-any-tag"), tag: characterTag }).strict(),
  z.object({ type: z.literal("defeat-character"), characterId: identifier }).strict(),
  z.object({ type: z.literal("defeat-tag-percentage"), tag: characterTag, percentage: z.number().finite().gt(0).max(100) }).strict()
]);

export const CharacterMatchResourceSchema = boundedContentJson(z.object({
  metadata: z.object({
    id: identifier,
    name: z.string().min(1),
    subtitle: z.string().min(1),
    tier: z.enum(["D", "C", "B", "A", "S", "SS"]),
    tags: z.array(characterTag),
    unlock: characterUnlock.optional(),
    previewImage: relativeImage,
    faction: HocpkgResourceKeySchema.optional(),
    matchMusic: relativeAudio.optional(),
    badge: z.object({ image: relativeImage, label: z.string().trim().min(1).max(80) }).strict().optional(),
    portraitScales: z.object({ selection: z.number().finite().min(0.75).max(1.5), table: z.number().finite().min(0.75).max(1.5) }).strict()
  }).strict(),
  dialogueResourceId: resourceReference,
  definition: z.record(z.string(), z.unknown()),
  aiSkills: z.array(z.object({
    resourceId: resourceReference,
    enabled: z.boolean(),
    parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()]))
  }).strict()),
  rewardSkillResourceIds: z.array(resourceReference)
}).strict().superRefine((data, ctx) => {
  if (data.definition && typeof data.definition === "object") {
    const allowed = new Set(["assets", "profile", "matchSummary", "revolverPlacement", "tablePortrait", "ai", "aiSkills"]);
    for (const key of Object.keys(data.definition)) {
      if (!allowed.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["definition", key], message: "角色定义包含未知字段" });
    }
    if (data.definition.tablePortrait !== undefined) {
      const result = TablePortraitResourceSchema.safeParse(data.definition.tablePortrait);
      if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ["definition", "tablePortrait", ...issue.path] });
    }
  }
}));

export type CharacterMatchResource = z.infer<typeof CharacterMatchResourceSchema>;

/** Optional presentation content. Affiliation has no effect on game rules. */
export const FactionResourceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  badge: relativeImage.optional(),
  matchMusic: relativeAudio.optional()
}).strict();
export type FactionResource = z.infer<typeof FactionResourceSchema>;

export function createFactionResourceHandler(): HocpkgResourceHandler<FactionResource> {
  return {
    type: "presentation.faction", apiVersions: [1, 2],
    async parse(payload, context) {
      const parsed = FactionResourceSchema.parse(payload);
      if (parsed.matchMusic && context.descriptor.apiVersion < 2) throw new Error("阵营音乐需要 presentation.faction API 2");
      await prepareMatchMusic(parsed.matchMusic, context);
      if (parsed.badge) {
        const file = context.manifest.files.find(file => file.path === parsed.badge);
        if (!file?.mediaType.startsWith("image/")) throw new Error("阵营徽标必须引用同包已声明的图片");
        await context.resolvePath(parsed.badge);
      }
      return parsed;
    }
  };
}

export const PlayerSkillAcquisitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("installed") }).strict(),
  z.object({ type: z.literal("defeat-character"), characterResourceId: z.string().min(1), label: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("none") }).strict()
]);

export const PlayerSkillResourceSchema = z.object({
  definition: AbilityDefinitionSchema.refine((definition) => definition.sourceKind === "player-skill", "definition 必须是 Player Skill"),
  acquisition: PlayerSkillAcquisitionSchema
}).strict().superRefine((resource, ctx) => {
  if (resource.definition.sourceKind === "player-skill" && resource.definition.unlock !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["definition", "unlock"], message: "角色卡技能必须使用 acquisition，不得沿用静态注册表 unlock" });
  }
});

export type PlayerSkillResource = z.infer<typeof PlayerSkillResourceSchema>;

export interface ResourceHandlerContext {
  readonly manifest: HocpkgManifest;
  readonly descriptor: HocpkgResourceDescriptor;
  readonly packageBaseUrl: string;
  readonly dependencies: ReadonlyMap<string, unknown>;
  resolvePath(path: string): string | Promise<string>;
}

/** Declarations are strict; an unavailable optional media file must not block gameplay. */
async function prepareMatchMusic(path: string | undefined, context: ResourceHandlerContext): Promise<void> {
  if (!path) return;
  if (!context.manifest.files.some(file => file.path === path && file.mediaType.startsWith("audio/"))) {
    throw new Error(`牌局音乐必须引用同包已声明的音频：${path}`);
  }
  try { await context.resolvePath(path); } catch { /* runtime records the failure and uses the next source */ }
}

export interface HocpkgResourceHandler<T = unknown> {
  readonly type: string;
  readonly apiVersions: readonly number[];
  parse(payload: unknown, context: ResourceHandlerContext): T | Promise<T>;
}

export interface ContentDiagnostic {
  readonly packageId: string;
  readonly resourceId: string;
  readonly type: string;
  readonly state: "dormant" | "blocked" | "invalid";
  readonly reason?: string;
  readonly error?: string;
}

export interface ExtensionResource<T = unknown> {
  readonly packageId: string;
  readonly descriptor: HocpkgResourceDescriptor;
  readonly value: T;
  readonly packageManifest: HocpkgManifest;
  resolvePath(path: string): string;
}

export function createPlayerSkillResourceHandler(): HocpkgResourceHandler<PlayerSkillResource> {
  return {
    type: "game.player-skill",
    apiVersions: [2],
    parse(payload, context) {
      const parsed = PlayerSkillResourceSchema.parse(payload);
      if (parsed.acquisition.type !== "defeat-character") return parsed;
      const characterResourceId = parsed.acquisition.characterResourceId;
      const characterResource = context.manifest.resources.find((resource) => resource.id === characterResourceId);
      if (!characterResource || characterResource.type !== "game.character-match") {
        throw new Error(`defeat-character 必须引用同包的 game.character-match：${characterResourceId}`);
      }
      return parsed;
    }
  };
}

export function createAiSkillResourceHandler(): HocpkgResourceHandler<AiSkillAbilityDefinition> {
  return {
    type: "game.ai-skill",
    apiVersions: [2],
    parse(payload) {
      const definition = AbilityDefinitionSchema.parse(payload);
      if (definition.sourceKind !== "ai-skill") throw new Error("game.ai-skill 必须包含 AI Skill 定义");
      return definition as AiSkillAbilityDefinition;
    }
  };
}

export function createStatusResourceHandler(): HocpkgResourceHandler<StatusDefinition> {
  return {
    type: "game.status",
    apiVersions: [1],
    parse(payload) { return StatusDefinitionSchema.parse(payload) as StatusDefinition; }
  };
}

export function createTalentResourceHandler(): HocpkgResourceHandler<TalentAbilityDefinition> {
  return {
    type: "game.talent",
    apiVersions: [2],
    parse(payload) {
      const definition = AbilityDefinitionSchema.parse(payload);
      if (definition.sourceKind !== "talent") throw new Error("game.talent 必须包含 Talent 定义");
      return definition as TalentAbilityDefinition;
    }
  };
}

function requireResourceType(context: ResourceHandlerContext, id: string, type: string): HocpkgResourceDescriptor {
  const resource = context.manifest.resources.find((candidate) => candidate.id === id);
  if (!resource || resource.type !== type) throw new Error(`${id} 必须引用同包的 ${type}`);
  return resource;
}

function collectImagePaths(value: unknown): string[] {
  if (typeof value === "string" && /\.(?:png|webp|jpe?g)$/i.test(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(collectImagePaths);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectImagePaths);
}

export function createCharacterMatchResourceHandler(): HocpkgResourceHandler<CharacterMatchResource> {
  return {
    type: "game.character-match",
    apiVersions: [4, 5, 6, 7, 8],
    async parse(payload, context) {
      const parsed = CharacterMatchResourceSchema.parse(payload);
      if (parsed.metadata.matchMusic && context.descriptor.apiVersion < 8) throw new Error("角色音乐需要 game.character-match API 8");
      await prepareMatchMusic(parsed.metadata.matchMusic, context);
      if (parsed.metadata.faction && context.descriptor.apiVersion < 7) throw new Error("阵营归属需要 game.character-match API 7");
      if (parsed.definition.tablePortrait !== undefined) {
        if (context.descriptor.apiVersion < 6) throw new Error("牌桌立绘定位需要 game.character-match API 6");
        const placement = TablePortraitResourceSchema.parse(parsed.definition.tablePortrait);
        for (const entry of placement.images ?? []) {
          if (!context.manifest.files.some(file => file.path === entry.image && file.mediaType.startsWith("image/"))) throw new Error(`立绘定位必须引用同包已声明的图片：${entry.image}`);
        }
      }
      if (parsed.metadata.badge) {
        if (context.descriptor.apiVersion < 5) throw new Error("角色徽标需要 game.character-match API 5");
        const file = context.manifest.files.find(file => file.path === parsed.metadata.badge!.image);
        if (!file?.mediaType.startsWith("image/")) throw new Error("角色徽标必须引用同包已声明的图片");
      }
      requireResourceType(context, parsed.dialogueResourceId, "game.character-dialogue");
      if (!context.descriptor.requires.includes(parsed.dialogueResourceId) || !context.dependencies.has(parsed.dialogueResourceId)) throw new Error("角色必须声明对白资源依赖");
      const mediaPaths = [
        parsed.metadata.previewImage,
        ...(parsed.metadata.badge ? [parsed.metadata.badge.image] : []),
        ...collectImagePaths(parsed.definition)
      ];
      for (const path of mediaPaths) await context.resolvePath(path);
      for (const binding of parsed.aiSkills) {
        requireResourceType(context, binding.resourceId, "game.ai-skill");
        const definition = context.dependencies.get(binding.resourceId);
        if (!definition) throw new Error(`AI Skill 依赖未激活：${binding.resourceId}`);
        validateBinding({ definitionId: (definition as AiSkillAbilityDefinition).id, enabled: binding.enabled, parameters: binding.parameters }, definition as AiSkillAbilityDefinition);
      }
      for (const id of parsed.rewardSkillResourceIds) requireResourceType(context, id, "game.player-skill");
      return parsed;
    }
  };
}

export function createCharacterDialogueResourceHandler(registry = activeDialogueRegistry()): HocpkgResourceHandler<CharacterDialogue> {
  return {
    type: "game.character-dialogue", apiVersions: [2, 3],
    async parse(payload, context) {
      const parsed = CharacterDialogueResourceSchema.parse(payload);
      if (context.descriptor.apiVersion < 3 && (parsed.poolExtensions || Object.values((payload as { pools: Record<string, unknown> }).pools).some(pool => !Array.isArray(pool)))) throw new Error("对象对白池及池扩展需要 game.character-dialogue API 3");
      const available = (c: DialogueCondition): boolean => "primitive" in c
        ? registry.validateArgs(c.primitive, c.apiVersion, c.args)
        : "not" in c ? available(c.not) : ("all" in c ? c.all : c.any).every(available);
      for (const rule of parsed.rules) if (rule.portrait) {
        const file = context.manifest.files.find(f => f.path === rule.portrait!.image);
        if (!file?.mediaType.startsWith("image/")) continue;
        if (!available(rule.when)) continue;
        try { await context.resolvePath(rule.portrait.image); } catch { /* runtime skips this rule, not the entire character */ }
      }
      return parsed;
    }
  };
}

export function createHocpkgResourceHandlers(registry?: DialoguePrimitiveRegistry): readonly HocpkgResourceHandler[] {
  return Object.freeze([
    createCharacterMatchResourceHandler(),
    createCharacterDialogueResourceHandler(registry),
    createAiSkillResourceHandler(),
    createPlayerSkillResourceHandler(),
    createStatusResourceHandler(),
    createTalentResourceHandler(),
    createFactionResourceHandler()
  ]);
}

export function mergeResourceHandlers(
  base: readonly HocpkgResourceHandler[],
  overrides: readonly HocpkgResourceHandler[] = []
): readonly HocpkgResourceHandler[] {
  const byType = new Map(base.map((handler) => [handler.type, handler]));
  for (const handler of overrides) {
    if (handler.type.startsWith("game.") || base.some(entry => entry.type === handler.type)) {
      throw new Error(`插件处理器不得注册或覆盖核心资源类型：${handler.type}`);
    }
    byType.set(handler.type, handler);
  }
  return Object.freeze([...byType.values()]);
}
