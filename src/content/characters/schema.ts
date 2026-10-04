import { z } from "zod";
import { DIALOGUE_EVENT_CODES, type DialogueEvent } from "../../dialogue/types";
import { AbilityBindingSchema, validateBinding } from "../../core/abilities/schema";
import type { AbilityDefinition } from "../../core/abilities/types";

// Package handlers validate portable, declared paths before a host resolves
// them. Runtime definitions may therefore contain blob:, Capacitor or future
// desktop-WebView URLs and must not encode a particular storage backend here.
const characterResourceUrl = z.string().min(1, "角色图片地址不能为空");
const portraitScale = z.number().finite().min(0.75).max(1.5).default(1);
const portraitScales = z.object({ selection: portraitScale, table: portraitScale }).strict().default({ selection: 1, table: 1 });
const characterTag = z.string().min(1).regex(/^[a-z0-9][a-z0-9:_-]*$/, "角色 tag 必须是安全标识");
const unlockCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("defeat-any") }).strict(),
  z.object({ type: z.literal("defeat-count"), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("defeat-any-tag"), tag: characterTag }).strict(),
  z.object({ type: z.literal("defeat-character"), characterId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("defeat-tag-percentage"), tag: characterTag, percentage: z.number().finite().gt(0).max(100) }).strict()
]);
const metadataEntry = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), name: z.string().min(1), subtitle: z.string().min(1),
  tier: z.enum(["D", "C", "B", "A", "S", "SS"]), tags: z.array(characterTag).default([]), unlock: unlockCondition.optional(),
  previewImage: characterResourceUrl, portraitScales
}).strict();
export const CharacterCatalogSchema = z.object({ defaultCharacterId: z.string().min(1), characters: z.array(metadataEntry).min(1) }).strict().superRefine((catalog, ctx) => {
  const ids = new Set<string>();
  for (const [index, character] of catalog.characters.entries()) {
    if (ids.has(character.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characters", index, "id"], message: `角色 ID 重复：${character.id}` });
    if (character.previewImage.startsWith("/characters/") && !character.previewImage.startsWith(`/characters/${character.id}/`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characters", index, "previewImage"], message: "角色预览图必须位于自己的公共目录" });
    ids.add(character.id);
    if (new Set(character.tags).size !== character.tags.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characters", index, "tags"], message: "角色 tag 重复" });
    if (character.tags.some((tag) => tag.startsWith("tier:"))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characters", index, "tags"], message: "tier: 命名空间由角色等级自动生成" });
    const condition = character.unlock;
    if (condition?.type === "defeat-character" && !catalog.characters.some((entry) => entry.id === condition.characterId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characters", index, "unlock", "characterId"], message: "解锁条件引用了未知角色" });
    }
    if (condition && (condition.type === "defeat-any-tag" || condition.type === "defeat-tag-percentage")) {
      const knownTags = new Set(catalog.characters.flatMap((entry) => [`tier:${entry.tier.toLowerCase()}`, ...entry.tags]));
      if (!knownTags.has(condition.tag)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["characters", index, "unlock", "tag"], message: "解锁条件引用了未知 tag" });
    }
  }
  const defaultCharacter = catalog.characters.find((character) => character.id === catalog.defaultCharacterId);
  if (!defaultCharacter) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultCharacterId"], message: "默认角色未注册" });
  else if (defaultCharacter.unlock) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultCharacterId"], message: "默认角色必须初始解锁" });
});

const dialoguePool = z.array(z.string().min(1)).min(1);
const dialogueShape = Object.fromEntries(DIALOGUE_EVENT_CODES.map((code) => [code, dialoguePool])) as Record<DialogueEvent, typeof dialoguePool>;
const dialogue = z.object(dialogueShape).strict();
export const CharacterDataSchema = z.object({
  assets: z.object({
    cover: characterResourceUrl, relaxed: characterResourceUrl, conflicted: characterResourceUrl, mocking: characterResourceUrl, threatened: characterResourceUrl,
    unconscious: characterResourceUrl, defeatedSummary: characterResourceUrl.optional()
  }).strict(),
  profile: z.object({ description: z.string().min(1) }).strict(),
  matchSummary: z.object({ playerVictory: z.string().min(1), playerDefeat: z.string().min(1), escaped: z.string().min(1) }).strict(),
  revolverPlacement: z.object({ top: z.number().finite(), left: z.number().finite() }).strict(),
  ai: z.object({ P: z.number().finite(), A: z.number().finite(), B: z.number().finite(), C: z.number().finite() }).strict(),
  aiSkills: z.array(AbilityBindingSchema).default([]),
  dialogue: dialogue
}).strict();

export function validateCharacterAbilityBindings(
  aiSkills: readonly unknown[],
  definitionsById: Readonly<Record<string, AbilityDefinition>>
): void {
  for (const bindingValue of aiSkills) {
    const binding = AbilityBindingSchema.parse(bindingValue);
    const definition = definitionsById[binding.definitionId];
    if (!definition) throw new Error(`未知能力机制：${binding.definitionId}`);
    if (definition.sourceKind !== "ai-skill") throw new Error(`角色技能必须引用 AI Skill 定义：${binding.definitionId}`);
    validateBinding(binding, definition);
  }
}

export { DIALOGUE_EVENT_CODES };
