/** Public, DOM-free contracts for standalone character-package tools. */
import { HocpkgManifestSchema, HocpkgPortablePathSchema } from "./content/packages/schema";
import type { HocpkgManifest } from "./content/packages/schema";
import { assertPluginCreditsVersion, PluginModuleResourceSchema } from "./content/packages/plugin-declarations";
import { SUPPORTED_PLUGIN_MODULE_API_VERSIONS } from "./content/packages/plugin-version";
import { authoringPresentationAllows, assertAuthoringSchema, assertAuthoringValue } from "./content/packages/authoring-schema";
import type { AuthoringSchema } from "./content/packages/authoring-schema";
import { validateDialogueResource } from "./dialogue/authoring";
import type { DialoguePrimitiveDeclaration } from "./dialogue/types";
import { CharacterDialogueResourceSchema } from "./dialogue/schema";
import { CORE_DIALOGUE_EVENTS } from "./dialogue/events";
import { CORE_DIALOGUE_PRIMITIVES } from "./dialogue/facts";
import { createDialogueDraft } from "./dialogue/draft";
import type { CharacterDialogue } from "./dialogue/types";
import { CharacterDataSchema } from "./content/characters/schema";
import { CharacterPresentationSchema } from "./content/packages/character-presentation";
import { createHocpkgResourceHandlers } from "./content/packages/resources";
import { loadHocpkgResources } from "./content/packages/loader";
import { buildContentRegistry } from "./content/packages/content-registry";
import { createStandaloneAbilityRegistry, supportsAbilitySourceKind, validateAbilityBinding } from "./core/abilities/registry";
import { instantiateProgramTemplate } from "./core/flow/program-templates";
import { validateProgramInitialization, validateProgramSkillGrant } from "./content/encounter-flows/catalog";

export { HocpkgManifestSchema, HocpkgPortablePathSchema };
export { ProgramDefinitionSchema, ProgramNodeSchema, ProgramConditionSchema, ProgramEffectSchema } from "./core/flow/program";
export type { ProgramDefinition, ProgramNode, ProgramCondition, ProgramEffect } from "./core/flow/program";
export { ProgramTemplateSchema, instantiateProgramTemplate, singleMatchProgram, encounterSequenceProgram } from "./core/flow/program-templates";
export type { ProgramTemplate } from "./core/flow/program-templates";
export { MatchInitSpecSchema } from "./core/flow/initialization";
export type { MatchInitSpec } from "./core/flow/initialization";
export { CharacterRuntimeSchema } from "./content/characters/runtime";
export type { CharacterRuntime } from "./content/characters/runtime";
export { EncounterProgramResourceSchema } from "./content/encounter-flows/catalog";
export type { EncounterProgramDeclaration } from "./content/encounter-flows/catalog";
export { CharacterPresentationSchema, PresentationReferenceSchema, CharacterSkinPreferencesSchema, resolvePresentation, createPresentationResolver } from "./content/packages/character-presentation";
export { SkinUnlockConditionSchema } from "./content/characters/skin-unlock";
export type { SkinUnlockCondition } from "./content/characters/skin-unlock";
export type { CharacterPresentation, PresentationContext, PresentationReference, CharacterSkinPreferences } from "./content/packages/character-presentation";
export { authoringPresentationAllows } from "./content/packages/authoring-schema";
export { PluginModuleResourceSchema, PluginSettingsDeclarationSchema, PluginCharacterExtensionDeclarationSchema, DialogueEventDeclarationSchema, PresentationDeclarationSchema, PluginCreditsDeclarationSchema } from "./content/packages/plugin-declarations";
export { assertAuthoringSchema, assertAuthoringValue, validateAuthoringValue } from "./content/packages/authoring-schema";
export { CharacterDataSchema, CharacterDialogueResourceSchema, validateDialogueResource, createDialogueDraft };
export { TablePortraitSchema } from "./content/characters/table-portrait";
export { TablePortraitResourceSchema, FactionResourceSchema, CharacterMatchResourceSchema } from "./content/packages/resources";
export { HocpkgResourceKeySchema } from "./content/packages/schema";
export type { FactionResource } from "./content/packages/resources";
export type { TablePortrait, TablePortraitImage } from "./content/characters/table-portrait";
export type { DialogueAuthoringIssue } from "./dialogue/authoring";
export const dialogueEventDeclarations = CORE_DIALOGUE_EVENTS;
export const dialoguePrimitiveDeclarations = CORE_DIALOGUE_PRIMITIVES.map(({ read: _read, ...declaration }) => declaration);
export type { CharacterDialogue, DialogueCondition, DialogueRule, DialogueEvent, DialogueEventDeclaration } from "./dialogue/types";
export type { AuthoringSchema, AuthoringContext, AuthoringIssue } from "./content/packages/authoring-schema";
export type { HocpkgManifest } from "./content/packages/schema";
export type { PluginCharacterExtensionDeclaration, PluginCreditsDeclaration } from "./content/packages/plugin-declarations";
export { AbilityDefinitionSchema, AbilityBindingSchema, AbilityRuleSchema, AbilityDisplaySchema, StatusDefinitionSchema, ScalarSchema, SkillCardFilterSchema, ValueExpressionSchema } from "./core/abilities/schema";
export type { AbilityDefinition, PlayerSkillAbilityDefinition, AiSkillAbilityDefinition, TalentAbilityDefinition, AbilityBinding, AbilityLevel, AbilityRule, AbilityTrigger, AbilityActivation, StatusDefinition, ActorSelector, Condition, Effect, ScalarValue, SkillCardFilter, ValueExpression, CardTransform, CardAcquisitionChoice, SkillDefinitionSelector } from "./core/abilities/types";
export type { AbilityDisplay, DisplayNode, DisplayValue } from "./core/abilities/display-types";
export interface AuthoringPackage { readonly manifest: unknown; readFile(path: string): Promise<Uint8Array> }
export interface LoadedCharacterContract { readonly type: string; readonly apiVersion: number; readonly title: string; readonly description: string; readonly schema: AuthoringSchema; readonly guide: string; readonly examples: readonly string[] }

export async function verifyAuthoringPackage(input: AuthoringPackage): Promise<HocpkgManifest> {
  const manifest = HocpkgManifestSchema.parse(input.manifest);
  for (const file of manifest.files) {
    const bytes = await input.readFile(file.path);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(v => v.toString(16).padStart(2, "0")).join("");
    if (bytes.length !== file.bytes || digest !== file.sha256) throw new Error(`文件完整性不符：${file.path}`);
  }
  return manifest;
}
export async function readPluginAuthoring(input: AuthoringPackage): Promise<{ packageId: string; title: string; modules: ReturnType<typeof PluginModuleResourceSchema.parse>[]; contracts: LoadedCharacterContract[]; primitives: DialoguePrimitiveDeclaration[]; events: import("./dialogue/types").DialogueEventDeclaration[] }> {
  const manifest = await verifyAuthoringPackage(input);
  const modules: ReturnType<typeof PluginModuleResourceSchema.parse>[] = [], contracts: LoadedCharacterContract[] = [];
  const file = async (path: string, mediaType: string) => {
    if (!manifest.files.some(f => f.path === path && f.mediaType === mediaType)) throw new Error(`创作文件未声明或 MIME 类型不符：${path}`);
    return input.readFile(path);
  };
  for (const descriptor of manifest.resources.filter(r => r.type === "plugin.module")) {
    if (!SUPPORTED_PLUGIN_MODULE_API_VERSIONS.some(version => version === descriptor.apiVersion)) throw new Error("不支持的插件模块 API");
    const module = PluginModuleResourceSchema.parse(JSON.parse(new TextDecoder().decode(await file(descriptor.entry, "application/json"))));
    assertPluginCreditsVersion(descriptor.apiVersion, module.credits);
    if (descriptor.apiVersion < 6 && module.settings?.fields.some(field => field.hidden)) throw new Error("隐藏设置必须使用 API 6");
    if (descriptor.apiVersion < 5 && (module.dialogueEvents || module.presentationState)) throw new Error("事件与表现声明必须使用 API 5");
    if (descriptor.apiVersion < 4 && module.dialoguePrimitives) throw new Error("对白原语声明必须使用 API 4");
    if (descriptor.apiVersion < 3 && (module.settings || module.characterExtensions)) throw new Error("新声明必须使用插件 API 3");
    modules.push(module);
    for (const extension of module.characterExtensions ?? []) {
      const schema = JSON.parse(new TextDecoder().decode(await file(extension.schema, "application/json")));
      assertAuthoringSchema(schema);
      const guide = new TextDecoder().decode(await file(extension.guide, "text/markdown"));
      if (!guide.trim()) throw new Error("角色创作指南不能为空");
      for (const example of extension.examples) await file(example, "application/zip");
      if (contracts.some(c => c.type === extension.type && c.apiVersion === extension.apiVersion)) throw new Error("角色契约重复");
      contracts.push({ ...extension, schema, guide });
    }
  }
  if (!modules.length) throw new Error("包不包含插件模块");
  const packageId = `${manifest.identity.authorId}/${manifest.identity.packageName}`;
  const primitives = modules.flatMap(module => (module.dialoguePrimitives ?? []).map(p => ({ ...p, id: `${packageId}#${p.id}` })));
  return { packageId, title: manifest.metadata.title, modules, contracts, primitives, events: modules.flatMap(m => (m.dialogueEvents ?? []).map(e => ({ ...e, id: `${packageId}#${e.id}` }))) };
}
export async function validateCharacterPackage(input: AuthoringPackage, contracts: readonly LoadedCharacterContract[] = [], primitives: readonly DialoguePrimitiveDeclaration[] = []): Promise<void> {
  const manifest = await verifyAuthoringPackage(input);
  const contractsByType = new Map<string, LoadedCharacterContract[]>();
  for (const contract of contracts) {
    if (!/^plugin\.[a-z][a-z0-9-]*$/.test(contract.type)) throw new Error("角色扩展不得覆盖核心资源类型");
    const list = contractsByType.get(contract.type) ?? [];
    if (list.some(c => c.apiVersion === contract.apiVersion)) throw new Error("角色扩展契约版本重复");
    list.push(contract); contractsByType.set(contract.type, list);
  }
  const handlers = [...createHocpkgResourceHandlers(), ...[...contractsByType].map(([type, versions]) => ({
    type, apiVersions: versions.map(contract => contract.apiVersion),
    presentationAllows: (path: readonly string[], apiVersion: number) => authoringPresentationAllows(versions.find(contract => contract.apiVersion === apiVersion)!.schema, path),
    parse(payload: unknown, context: { descriptor: { apiVersion: number; requires: readonly string[] } }) {
      const contract = versions.find(c => c.apiVersion === context.descriptor.apiVersion)!;
      assertAuthoringValue(contract.schema, payload, { files: manifest.files, resources: manifest.resources, requires: context.descriptor.requires });
      return payload;
    }
  }))];
  const presentationDescriptor = manifest.resources.find(resource => resource.type === "presentation.character");
  const skins = presentationDescriptor ? CharacterPresentationSchema.parse(JSON.parse(new TextDecoder().decode(await input.readFile(presentationDescriptor.entry)))).skins.map(skin => skin.id) : [undefined];
  for (const skinId of skins) {
  const results = await loadHocpkgResources(manifest, {
    presentation: { skinId },
    handlers, readJson: async path => JSON.parse(new TextDecoder().decode(await input.readFile(path))),
    resolvePath: path => { HocpkgPortablePathSchema.parse(path); if (!manifest.files.some(f => f.path === path && /^(image|audio)\//.test(f.mediaType))) throw new Error(`媒体未声明：${path}`); return path; }
  });
  for (const result of results) if (result.state !== "active") throw new Error(`${result.descriptor.id}: ${result.reason} ${result.error ?? ""}`);
  const registry = buildContentRegistry([{ manifest, resources: results, resolvePath: path => path }]);
  if (registry.characters.length !== 1) throw new Error("角色包必须包含一个 game.character-match");
  const abilityRegistry = createStandaloneAbilityRegistry([...registry.aiSkills, ...registry.playerSkills.map(s => s.definition), ...registry.talents], registry.statuses);
  const localBinding = (binding: import("./core/abilities/types").AbilityBinding, kind: "ai-skill" | "player-skill") => {
    const definition = abilityRegistry.definitionsById[binding.definitionId];
    if (!definition) return; // Cross-package dependencies are checked against the activated content snapshot.
    validateAbilityBinding(binding, abilityRegistry);
    if (!supportsAbilitySourceKind(definition, kind)) throw new Error(`流程能力类型不匹配：${binding.definitionId}`);
  };
  for (const entry of registry.encounterFlows) if (!entry.program) {
    for (const binding of entry.definition.nodes.flatMap(node => (node.abilities ?? []).flatMap(slot => [slot.binding, ...slot.overrides.map(override => override.binding)]))) localBinding(binding, "ai-skill");
  }
  const programs = [...registry.encounterFlows.flatMap(entry => entry.program ? [entry.program] : []),
    ...registry.characters.flatMap(character => character.metadata.runtime?.type === "template" ? [instantiateProgramTemplate(character.metadata.runtime.template)] : [])];
  for (const program of programs) {
    for (const node of program.nodes) {
      if (node.type === "match") for (const binding of (node.abilities ?? []).flatMap(slot => [slot.binding, ...slot.overrides.map(override => override.binding)])) localBinding(binding, "ai-skill");
      const effects = node.type === "effect" || node.type === "end" ? node.effects : node.type === "settlement" ? [...node.effects, ...node.rewards.flatMap(reward => reward.effects)] : [];
      for (const effect of effects) if (effect.type === "grant-skill") validateProgramSkillGrant(effect.binding, abilityRegistry, true);
    }
    for (const init of [program.defaults, ...program.nodes.flatMap(node => node.type === "match" ? [node.init] : [])]) {
      if (init) validateProgramInitialization(init, abilityRegistry, true);
    }
  }
  for (const character of registry.characters) {
    const dialogue = results.find(r => r.descriptor.id === character.dialogueResourceId)?.value as CharacterDialogue;
    for (const rule of dialogue.rules) if (rule.portrait && !manifest.files.some(file => file.path === rule.portrait!.image && file.mediaType.startsWith("image/"))) throw new Error(`规则立绘未声明或不是图片：${rule.id}`);
    const errors = validateDialogueResource(dialogue, primitives).filter(issue => issue.severity === "error");
    if (errors.length) throw new Error(errors.map(issue => `${issue.ruleId}: ${issue.message}`).join("\n"));
    CharacterDataSchema.parse({ ...character.definition, dialogue });
    for (const binding of character.aiSkills) {
      const result = results.find(r => r.descriptor.id === binding.resourceId)!;
      validateAbilityBinding({ definitionId: (result.value as { id: string }).id, level: binding.level, enabled: binding.enabled, parameters: binding.parameters }, abilityRegistry);
    }
  }
}
}
/** Neutral authoring preset; the author fills dialogue pools and supplies media before validation. */
export function createCharacterDraft(id: string, name: string) {
  const match = {
    dialogueResourceId: "dialogue",
    metadata: { id, name, subtitle: "角色简介", tier: "B", encounter: { requiresDefeat: false, rematchSkillChoices: false, invitationLabel: "邀请", playerGun: { capacity: 6, bullets: 0 } }, tags: [], previewImage: "relaxed.png", portraitScales: { selection: 1, table: 1 } },
    definition: {
      assets: { cover: "cover.png", relaxed: "relaxed.png", conflicted: "conflicted.png", mocking: "mocking.png", threatened: "threatened.png", unconscious: "unconscious.png" },
      profile: { description: "角色背景" }, matchSummary: { playerVictory: "玩家获胜", playerDefeat: "对手获胜", escaped: "离开牌桌" },
      revolverPlacement: { top: 47.5, left: 126.9 }, ai: { P: 0, A: 1, B: 1, C: 1 }
    }, aiSkills: [], rewardSkillResourceIds: []
  };
  const dialogue = createDialogueDraft();
  return { match, dialogue };
}

export interface CharacterPackageDraft {
  /** Incomplete until a packager replaces the empty file list with media and resource digests. */
  readonly manifest: Omit<HocpkgManifest, "files"> & { files: [] };
  readonly files: Readonly<Record<string, string>>;
}

/** Package layout for authoring tools. Fill dialogue pools and add media before building the file manifest. */
export function createCharacterPackageDraft(id: string, name: string): CharacterPackageDraft {
  const { match, dialogue } = createCharacterDraft(id, name);
  const manifest: CharacterPackageDraft["manifest"] = {
    format: "house-of-chances-hocpkg",
    formatVersion: 1,
    identity: { authorId: "creator", packageName: id, version: "1.0.0" },
    metadata: { title: name, description: "新建角色包", tags: [], creators: [{ displayName: "创作者", roles: ["design"] }] },
    resources: [
      { id: "character", type: "game.character-match", apiVersion: 12, entry: "resources/character.json", requires: ["dialogue"] },
      { id: "dialogue", type: "game.character-dialogue", apiVersion: 2, entry: "resources/dialogue.json", requires: [] }
    ],
    files: [],
    extensions: {}
  };
  return {
    manifest,
    files: {
      "resources/character.json": `${JSON.stringify(match, null, 2)}\n`,
      "resources/dialogue.json": `${JSON.stringify(dialogue, null, 2)}\n`
    }
  };
}

export { ChallengeDefinitionSchema, ChallengeVictoryRewardsSchema } from "./core/challenge/schema";
export type { ChallengeDefinition, ChallengeVictoryRewards } from "./core/challenge/schema";

export { EncounterFlowResourceSchema } from "./content/encounter-flows/catalog";
export type { EncounterFlowResource } from "./content/encounter-flows/catalog";
export { FlowDefinitionSchema } from "./core/flow/schema";
export type { FlowDefinition } from "./core/flow/schema";
export { CharacterEncounterPolicySchema } from "./content/characters/encounter-policy";
export type { CharacterEncounterPolicy } from "./content/characters/encounter-policy";

/** New skin-aware authoring preset. Runtime rules stay shared; media are supplied by the creator. */
export function createSkinCharacterPackageDraft(id: string, name: string): CharacterPackageDraft {
  const draft = createCharacterPackageDraft(id, name);
  const match = JSON.parse(draft.files["resources/character.json"]);
  const dialogue = JSON.parse(draft.files["resources/dialogue.json"]);
  const presentation: import("./content/packages/character-presentation").CharacterPresentation = { skins: [{ id: "default", name: "原装" }], resources: {} };
  const add = (key: string, type: "text" | "image" | "audio" | "portrait" | "data", value: unknown) => {
    presentation.resources[key] = { type, variants: [{ skinId: "default", value }] };
    return { presentationRef: key };
  };
  for (const key of ["name", "subtitle"]) match.metadata[key] = add(`text:${key}`, "text", match.metadata[key]);
  match.definition.profile.description = add("text:description", "text", match.definition.profile.description);
  for (const key of ["playerVictory", "playerDefeat", "escaped"]) match.definition.matchSummary[key] = add(`text:${key.toLowerCase()}`, "text", match.definition.matchSummary[key]);
  const imageSlots = new Map<string, string>();
  for (const [key, image] of Object.entries(match.definition.assets)) {
    if (key === "cover") match.definition.assets[key] = add("image:cover", "image", image);
    else {
      const slot = `portrait:${key.toLowerCase()}`;
      add(slot, "portrait", { image, scale: match.metadata.portraitScales.table, anchorY: 1, revolverPlacement: match.definition.revolverPlacement });
      imageSlots.set(image as string, slot);
      match.definition.assets[key] = { presentationRef: slot, path: "/image" };
    }
  }
  match.metadata.previewImage = { presentationRef: "image:cover" };
  match.definition.revolverPlacement = { presentationRef: "portrait:relaxed", path: "/revolverPlacement" };
  match.definition.tablePortrait = { anchorY: 1, images: [...imageSlots].map(([, key]) => ({ image: { presentationRef: key, path: "/image" }, anchorY: { presentationRef: key, path: "/anchorY" } })) };
  dialogue.poolPortraits = { [dialogue.fallbackPoolId]: { presentationRef: "portrait:relaxed" } };
  for (const rule of dialogue.rules) if (rule.portrait && imageSlots.has(rule.portrait.image)) rule.portrait = { presentationRef: imageSlots.get(rule.portrait.image) };
  for (const [poolId, pool] of Object.entries(dialogue.pools)) dialogue.pools[poolId] = add(`pool:${poolId.toLowerCase()}`, "data", pool);
  match.presentationResourceId = "appearance";
  const manifest = structuredClone(draft.manifest);
  manifest.resources = manifest.resources.map(resource => resource.type === "game.character-match" ? { ...resource, apiVersion: 13, requires: [...resource.requires, "appearance"] }
    : resource.type === "game.character-dialogue" ? { ...resource, apiVersion: 4, requires: [...resource.requires, "appearance"] } : resource);
  manifest.resources.push({ id: "appearance", type: "presentation.character", apiVersion: 1, entry: "resources/appearance.json", requires: [] });
  return { manifest, files: { ...draft.files, "resources/character.json": JSON.stringify(match, null, 2) + "\n", "resources/dialogue.json": JSON.stringify(dialogue, null, 2) + "\n", "resources/appearance.json": JSON.stringify(presentation, null, 2) + "\n" } };
}
