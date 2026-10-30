import { z } from "zod";
import { FlowDefinitionSchema } from "../../core/flow/schema";
import { ProgramDefinitionSchema, type ProgramDefinition } from "../../core/flow/program";
import { compileLegacyFlow } from "../../core/flow/program-templates";
import { AbilityBindingSchema } from "../../core/abilities/schema";
import type { AbilityBinding } from "../../core/abilities/types";
import { challengeFlow } from "../../core/challenge/flow";
import { getChallenges } from "../challenges/catalog";
import type { ChallengeDefinition } from "../../core/challenge/schema";
import { getAbilityDefinition, validateAbilityBinding, supportsAbilitySourceKind, type AbilityRegistry } from "../../core/abilities/registry";
import type { MatchInitSpec } from "../../core/flow/initialization";
import type { CharacterMetadata } from "../characters/types";

const id = z.string().min(1);
export const EncounterFlowResourceSchema = z.object({
  id, name: id, description: id, ownerId: id,
  unlock: z.discriminatedUnion("type", [
    z.object({ type: z.literal("always") }).strict(),
    z.object({ type: z.literal("defeat-count"), count: z.number().int().positive().safe() }).strict(),
    z.object({ type: z.literal("defeat-character"), characterId: id }).strict(),
    z.object({ type: z.literal("defeat-faction-count"), faction: id, count: z.number().int().positive().safe(), exclude: z.array(id).default([]) }).strict()
  ]),
  invitationHint: z.string().optional(), definition: FlowDefinitionSchema,
  rematchSkills: z.array(z.object({ slot: id, label: id.optional(), binding: AbilityBindingSchema, weakenedBinding: AbilityBindingSchema }).strict()).optional()
}).strict().superRefine((entry, context) => {
  if (entry.id !== entry.definition.id || (entry.definition.completionId && entry.definition.completionId !== entry.id)) context.addIssue({ code: "custom", message: "Flow resource identity must match its definition" });
  const slots = entry.rematchSkills?.map(slot => slot.slot) ?? [];
  if (new Set(slots).size !== slots.length) context.addIssue({ code: "custom", message: "Duplicate rematch skill slot" });
}).transform(entry => ({ ...entry, definition: { ...entry.definition, completionId: entry.definition.completionId ?? entry.id } }));
export type EncounterFlowResource = z.infer<typeof EncounterFlowResourceSchema> & {
  readonly program?: ProgramDefinition;
  /** Package-local helper programs need not create a second lobby entry. */
  readonly entryVisible?: boolean;
  readonly repeatable?: boolean;
};

/** API 2 keeps discovery metadata separate from the executable node graph. */
export const EncounterProgramResourceSchema = z.object({
  id, name: id, description: id, ownerId: id,
  unlock: z.discriminatedUnion("type", [
    z.object({ type: z.literal("always") }).strict(),
    z.object({ type: z.literal("defeat-count"), count: z.number().int().positive().safe() }).strict(),
    z.object({ type: z.literal("defeat-character"), characterId: id }).strict(),
    z.object({ type: z.literal("defeat-faction-count"), faction: id, count: z.number().int().positive().safe(), exclude: z.array(id).default([]) }).strict()
  ]),
  invitationHint: z.string().optional(), entry: z.boolean().default(true), repeatable: z.boolean().default(false), definition: ProgramDefinitionSchema,
  rematchSkills: z.array(z.object({ slot: id, label: id.optional(), binding: AbilityBindingSchema, weakenedBinding: AbilityBindingSchema }).strict()).optional()
}).strict().superRefine((entry, context) => {
  if (entry.id !== entry.definition.id) context.addIssue({ code: "custom", message: "Flow resource identity must match its definition" });
  const slots = entry.rematchSkills?.map(slot => slot.slot) ?? [];
  if (new Set(slots).size !== slots.length) context.addIssue({ code: "custom", message: "Duplicate rematch skill slot" });
}).transform((entry): EncounterFlowResource => {
  const { definition: program, entry: entryVisible, ...metadata } = entry;
  const nodes = program.nodes.filter(node => node.type === "match");
  // Existing invitation/ability previews consume this projection only. Runtime always uses program.
  const definition = program.legacyDefinition ?? FlowDefinitionSchema.parse({
    id: program.id, playerGun: { capacity: 6, bullets: 0 }, presentation: program.presentation,
    nodes: (nodes.length ? nodes : [{ id: "preview", opponentId: entry.ownerId }]).map(node => ({
      id: node.id, opponentId: node.opponentId,
      ...("abilities" in node ? { abilities: node.abilities?.map(slot => ({ ...slot, overrides: [] })), presentation: node.presentation } : {}),
      routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } }
    }))
  });
  return { ...metadata, definition: { ...definition, completionId: definition.completionId ?? entry.id }, program, entryVisible };
});
export type EncounterProgramDeclaration = z.input<typeof EncounterProgramResourceSchema>;
let entries: readonly EncounterFlowResource[] = [];
export function installEncounterFlows(definitions: readonly EncounterFlowResource[]): void { entries = structuredClone(definitions); }
/** Only old resource APIs are compiled from the four-guard compatibility model. */
export function getEncounterFlows(): readonly EncounterFlowResource[] {
  return [...getChallenges().map(legacyChallengeEncounter), ...entries.filter(entry => entry.entryVisible !== false)];
}
export function legacyChallengeEncounter(definition: ChallengeDefinition): EncounterFlowResource {
  return { id: definition.id, name: definition.name, description: definition.description, ownerId: definition.bossId,
    unlock: definition.unlock.type === "defeat-faction-count" ? { ...definition.unlock, faction: definition.faction, exclude: [definition.bossId] } : definition.unlock,
    invitationHint: "可先挑战守卫削弱技能；左轮、剩余技能和抽数在本次挑战中继承。", definition: { ...challengeFlow(definition), completionId: definition.id },
    rematchSkills: definition.bossAbilities.map(slot => ({ ...slot, weakenedBinding: slot.weakenedBinding ?? { ...slot.binding, enabled: false } }))
  };
}
export function getEncounterPrograms() {
  return getEncounterFlows().map(entry => ({ ...entry, definition: entry.program ?? compileLegacyFlow(entry.definition) }));
}
export function encounterUnlockProgress(entry: EncounterFlowResource, defeats: readonly { opponentId: string }[], characters: readonly CharacterMetadata[]) {
  const ids = new Set(defeats.map(defeat => defeat.opponentId));
  const unlock = entry.unlock;
  const required = unlock.type === "always" ? 0 : unlock.type === "defeat-character" ? 1 : unlock.count;
  const current = unlock.type === "always" ? 0 : unlock.type === "defeat-character" ? Number(ids.has(unlock.characterId))
    : unlock.type === "defeat-count" ? ids.size : new Set(characters.filter(character => character.faction === unlock.faction && !unlock.exclude.includes(character.id) && ids.has(character.id)).map(character => character.id)).size;
  return { current, required, unlocked: current >= required };
}
export function validateEncounterFlow(entry: EncounterFlowResource, characters: readonly CharacterMetadata[], registry: AbilityRegistry): void {
  for (const id of [entry.ownerId, ...entry.definition.nodes.map(node => node.opponentId)]) if (!characters.some(character => character.id === id)) throw new Error(`Encounter character is unavailable: ${id}`);
  const unlock = entry.unlock;
  if (unlock.type === "defeat-character" && !characters.some(character => character.id === unlock.characterId)) throw new Error("Encounter unlock character is unavailable");
  const bindings = [...entry.definition.nodes.flatMap(node => (node.abilities ?? []).flatMap(slot => [slot.binding, ...slot.overrides.map(override => override.binding)])), ...(entry.rematchSkills ?? []).flatMap(slot => [slot.binding, slot.weakenedBinding])];
  for (const binding of bindings) {
    validateAbilityBinding(binding, registry);
    const definition = registry.definitionsById[binding.definitionId];
    if (!definition || !supportsAbilitySourceKind(definition, "ai-skill")) throw new Error(`Encounter binding must be an AI skill: ${binding.definitionId}`);
  }
  if (entry.program) validateEncounterProgram(entry.program, characters, registry);
}

export function validateEncounterProgram(program: ProgramDefinition, characters: readonly CharacterMetadata[], registry: AbilityRegistry): void {
  ProgramDefinitionSchema.parse(program);
  for (const init of [program.defaults, ...program.nodes.flatMap(node => node.type === "match" ? [node.init] : [])]) {
    if (init) validateProgramInitialization(init, registry);
  }
  for (const node of program.nodes) {
    const effects = node.type === "effect" || node.type === "end" ? node.effects
      : node.type === "settlement" ? [...node.effects, ...node.rewards.flatMap(reward => reward.effects)] : [];
    for (const effect of effects) if (effect.type === "grant-skill") validateProgramSkillGrant(effect.binding, registry);
    if (node.type === "choice") for (const option of node.options) {
      if (option.characterId && !characters.some(character => character.id === option.characterId)) throw new Error(`Encounter choice character is unavailable: ${option.characterId}`);
    }
    if (node.type !== "match") continue;
    if (!characters.some(character => character.id === node.opponentId)) throw new Error(`Encounter character is unavailable: ${node.opponentId}`);
    for (const binding of (node.abilities ?? []).flatMap(slot => [slot.binding, ...slot.overrides.map(override => override.binding)])) {
      validateAbilityBinding(binding, registry);
      const definition = registry.definitionsById[binding.definitionId];
      if (!definition || !supportsAbilitySourceKind(definition, "ai-skill")) throw new Error(`Encounter binding must be an AI skill: ${binding.definitionId}`);
    }
  }
}

export function validateProgramSkillGrant(binding: AbilityBinding, registry: AbilityRegistry, localOnly = false): void {
  if (localOnly && !registry.definitionsById[binding.definitionId]) return;
  validateAbilityBinding(binding, registry);
  const definition = getAbilityDefinition(binding.definitionId, registry, binding.level);
  if (definition?.sourceKind !== "player-skill" || definition.hidden) throw new Error(`流程奖励必须是非隐藏玩家技能：${binding.definitionId}`);
}

/** The authoring SDK checks local definitions; activation checks the complete installed registry. */
export function validateProgramInitialization(init: MatchInitSpec, registry: AbilityRegistry, localOnly = false): void {
  for (const [bindings, kind, intrinsic] of [[init.opponentAbilities, "ai-skill", false], [init.intrinsicAbilities, "player-skill", true], [init.playerSkills?.cards, "player-skill", false]] as const) {
    for (const binding of bindings ?? []) {
      if (localOnly && !registry.definitionsById[binding.definitionId]) continue;
      validateAbilityBinding(binding, registry);
      const definition = getAbilityDefinition(binding.definitionId, registry, binding.level);
      if (!definition || !supportsAbilitySourceKind(definition, kind)) throw new Error(`初始化能力类型不匹配：${binding.definitionId}`);
      if (intrinsic && (definition.sourceKind !== "player-skill" || !definition.hidden || definition.drop.enabled || definition.activation.type !== "automatic"))
        throw new Error(`初始化固有能力无效：${binding.definitionId}`);
      if (!intrinsic && kind === "player-skill" && definition.hidden) throw new Error(`初始手牌不能引用隐藏固有能力：${binding.definitionId}`);
    }
  }
  for (const [source, kind] of [[init.skillPool, "player-skill"], [init.talents, "talent"]] as const) if (source?.source === "fixed") {
    if (new Set(source.ids).size !== source.ids.length) throw new Error("初始化资源不能重复");
    for (const id of source.ids) {
      const definition = getAbilityDefinition(id, registry);
      if (!definition && localOnly) continue;
      if (!definition || !supportsAbilitySourceKind(definition, kind)) throw new Error(`初始化资源不可用或类型不匹配：${id}`);
      if (kind === "player-skill" && (definition.sourceKind !== "player-skill" || definition.hidden || !definition.drop.enabled || definition.drop.baseWeight <= 0))
        throw new Error(`初始化技能池不能包含不可抽取的技能：${id}`);
    }
  }
}
