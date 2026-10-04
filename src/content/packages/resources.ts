import { z } from "zod";
import { AbilityDefinitionSchema, StatusDefinitionSchema, validateBinding } from "../../core/abilities/schema";
import type { AiSkillAbilityDefinition, StatusDefinition, TalentAbilityDefinition } from "../../core/abilities/types";
import type { HocpkgManifest, HocpkgResourceDescriptor } from "./schema";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const resourceReference = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/);
const relativeImage = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*\.(?:png|webp|jpg|jpeg)$/i);
const characterTag = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/);
const characterUnlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("defeat-any") }).strict(),
  z.object({ type: z.literal("defeat-count"), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("defeat-any-tag"), tag: characterTag }).strict(),
  z.object({ type: z.literal("defeat-character"), characterId: identifier }).strict(),
  z.object({ type: z.literal("defeat-tag-percentage"), tag: characterTag, percentage: z.number().finite().gt(0).max(100) }).strict()
]);

export const CharacterMatchResourceSchema = z.object({
  metadata: z.object({
    id: identifier,
    name: z.string().min(1),
    subtitle: z.string().min(1),
    tier: z.enum(["D", "C", "B", "A", "S", "SS"]),
    tags: z.array(characterTag),
    unlock: characterUnlock.optional(),
    previewImage: relativeImage,
    portraitScales: z.object({ selection: z.number().finite().min(0.75).max(1.5), table: z.number().finite().min(0.75).max(1.5) }).strict()
  }).strict(),
  definition: z.record(z.unknown()),
  aiSkills: z.array(z.object({
    resourceId: resourceReference,
    enabled: z.boolean(),
    parameters: z.record(z.union([z.string(), z.number().finite(), z.boolean()]))
  }).strict()),
  rewardSkillResourceIds: z.array(resourceReference)
}).strict().superRefine((data, ctx) => {
  if (data.definition && typeof data.definition === "object") {
    const allowed = new Set(["assets", "profile", "matchSummary", "revolverPlacement", "ai", "aiSkills", "dialogue"]);
    for (const key of Object.keys(data.definition)) {
      if (!allowed.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["definition", key], message: "角色定义包含未知字段" });
    }
  }
});

export type CharacterMatchResource = z.infer<typeof CharacterMatchResourceSchema>;

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
    apiVersions: [3],
    async parse(payload, context) {
      const parsed = CharacterMatchResourceSchema.parse(payload);
      const mediaPaths = [
        parsed.metadata.previewImage,
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

export function createHocpkgResourceHandlers(): readonly HocpkgResourceHandler[] {
  return Object.freeze([
    createCharacterMatchResourceHandler(),
    createAiSkillResourceHandler(),
    createPlayerSkillResourceHandler(),
    createStatusResourceHandler(),
    createTalentResourceHandler()
  ]);
}

export function mergeResourceHandlers(
  base: readonly HocpkgResourceHandler[],
  overrides: readonly HocpkgResourceHandler[] = []
): readonly HocpkgResourceHandler[] {
  const byType = new Map(base.map((handler) => [handler.type, handler]));
  for (const handler of overrides) {
    if (handler.type.startsWith("game.")) {
      throw new Error(`插件处理器不得注册或覆盖核心资源类型：${handler.type}`);
    }
    byType.set(handler.type, handler);
  }
  return Object.freeze([...byType.values()]);
}
