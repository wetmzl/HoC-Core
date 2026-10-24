import { registerCharacterImage, clearCharacterImages } from "../../presentation/character-interaction";
import { ABILITY_CATALOG_VERSION, createStandaloneAbilityRegistry, installAbilityRegistry, supportsAbilitySourceKind, validateAbilityBinding, type AbilityRegistry } from "../../core/abilities/registry";
import type { AbilityDefinition, PlayerSkillAbilityDefinition, StatusDefinition } from "../../core/abilities/types";
import { clearCharacterCatalog, installCharacterCatalog } from "../characters/catalog";
import { clearCharacterDefinitions, installCharacterDefinitions } from "../characters/loader";
import type { DialoguePrimitiveRegistry } from "../../dialogue/registry";
import type { CharacterDialogue } from "../../dialogue/types";
import { CharacterDataSchema } from "../characters/schema";
import type { CharacterData, CharacterDefinition, CharacterMetadata } from "../characters/types";
import { buildContentRegistry, type ContentRegistry, type LoadedHocpkgPackage } from "./content-registry";
import { EmbeddedContentSource, type ContentSource } from "./content-source";
import { loadHocpkgResources } from "./loader";
import { createHocpkgResourceHandlers, mergeResourceHandlers, type HocpkgResourceHandler, type CharacterMatchResource, type ContentDiagnostic, type ExtensionResource, type PlayerSkillResource, type FactionResource } from "./resources";
import type { BuiltinPackageIndex } from "./schema";

export interface LoadedContent {
  readonly index: BuiltinPackageIndex;
  readonly packages: readonly LoadedHocpkgPackage[];
  readonly registry: ContentRegistry;
  release(): void;
}

export interface LoadContentOptions {
  readonly dialogueRegistry?: DialoguePrimitiveRegistry;
  readonly handlers?: readonly HocpkgResourceHandler[];
}

export interface PreparedContentRuntime {
  readonly abilityRegistry: AbilityRegistry;
  readonly definitions: readonly AbilityDefinition[];
  readonly statuses: readonly StatusDefinition[];
  readonly characters: readonly CharacterDefinition[];
  readonly catalog: readonly CharacterMetadata[];
  readonly defaultCharacterId: string;
  readonly extensions: Readonly<Record<string, readonly ExtensionResource[]>>;
  readonly diagnostics: readonly ContentDiagnostic[];
}

export async function loadContent(
  source: ContentSource,
  index: BuiltinPackageIndex,
  options: LoadContentOptions = {}
): Promise<LoadedContent> {
  const activeHandlers = mergeResourceHandlers(createHocpkgResourceHandlers(options.dialogueRegistry), options.handlers ?? []);
  const indexOrder = new Map(index.packages.map((entry, position) => [entry.packageId, position]));
  const accesses = [...await source.packages()].sort((left, right) => {
    const leftOrder = indexOrder.get(left.packageId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = indexOrder.get(right.packageId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.packageId.localeCompare(right.packageId);
  });
  const packages = await Promise.all(accesses.map(async (access) => {
    const resolved = new Map<string, { readonly url: string; release?(): void }>();
    const inFlightResolutions = new Map<string, Promise<{ readonly url: string; release?(): void }>>();
    const manifestFilesByPath = new Set(access.manifest.files.map((file) => file.path));

    const resolvePath = async (path: string): Promise<string> => {
      if (!manifestFilesByPath.has(path)) {
        throw new Error(`媒体文件未在 Manifest 中声明：${access.packageId}#${path}`);
      }
      const existing = resolved.get(path);
      if (existing) return existing.url;
      let inFlight = inFlightResolutions.get(path);
      if (!inFlight) {
        inFlight = access.resolveAsset(path).then((asset) => {
          resolved.set(path, asset);
          inFlightResolutions.delete(path);
          return asset;
        });
        inFlightResolutions.set(path, inFlight);
      }
      const asset = await inFlight;
      return asset.url;
    };

    const syncResolvePath = (path: string): string => {
      const asset = resolved.get(path);
      if (!asset) {
        throw new Error(`媒体文件未解析或未在 Manifest 中声明：${access.packageId}#${path}`);
      }
      return asset.url;
    };

    try {
      const resources = await loadHocpkgResources(access.manifest, {
        handlers: activeHandlers,
        readJson: (entry) => access.readJson(entry),
        resolvePath
      });
      return {
        manifest: access.manifest,
        resources,
        resolvePath: syncResolvePath,
        release: () => { for (const asset of resolved.values()) asset.release?.(); }
      } satisfies LoadedHocpkgPackage;
    } catch (error) {
      for (const asset of resolved.values()) asset.release?.();
      throw error;
    }
  }));
  try {
    const registry = buildContentRegistry(packages);
    return Object.freeze({
      index,
      packages: Object.freeze(packages),
      registry,
      release: () => { for (const loaded of packages) loaded.release?.(); }
    });
  } catch (error) {
    for (const loaded of packages) loaded.release?.();
    throw error;
  }
}

export async function loadEmbeddedContent(
  options: ConstructorParameters<typeof EmbeddedContentSource>[0] = {},
  loadOptions: LoadContentOptions = {}
): Promise<LoadedContent> {
  const source = new EmbeddedContentSource(options);
  return loadContent(source, await source.loadIndex(), loadOptions);
}

function resolveMedia(value: unknown, loaded: LoadedHocpkgPackage): unknown {
  if (typeof value === "string" && /\.(?:png|webp|jpe?g)$/i.test(value)) return loaded.resolvePath(value);
  if (Array.isArray(value)) return value.map((entry) => resolveMedia(entry, loaded));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveMedia(entry, loaded)]));
}

function installedPlayerSkill(resource: PlayerSkillResource, match: CharacterMatchResource | undefined): PlayerSkillAbilityDefinition {
  if (resource.acquisition.type !== "defeat-character") return resource.definition as PlayerSkillAbilityDefinition;
  if (!match) throw new Error(`击败奖励缺少角色资源：${resource.definition.id}`);
  return {
    ...resource.definition,
    unlock: { opponentId: match.metadata.id, label: resource.acquisition.label ?? `首次击败${match.metadata.name}` }
  } as PlayerSkillAbilityDefinition;
}

export function prepareContentRuntime(content: LoadedContent): PreparedContentRuntime {
  const diagnostics = [...content.registry.diagnostics];
  const factions = new Map((content.registry.extensions["presentation.faction"] ?? []).map(resource => [
    `${resource.packageId}#${resource.descriptor.id}`, resource
  ]));
  const playerSkillsById = new Map<string, PlayerSkillAbilityDefinition>();
  for (const loaded of content.packages) {
    const match = loaded.resources.find((result) => result.descriptor.type === "game.character-match")?.value as CharacterMatchResource | undefined;
    for (const result of loaded.resources) {
      if (result.descriptor.type === "game.player-skill") {
        const skill = installedPlayerSkill(result.value as PlayerSkillResource, match);
        playerSkillsById.set(skill.id, skill);
      }
    }
  }
  const orderedIds = content.index.playerSkillOrder.filter((id) => playerSkillsById.has(id));
  const orderedIdSet = new Set(orderedIds);
  const playerSkills = [
    ...orderedIds.map((id) => playerSkillsById.get(id)!),
    ...[...playerSkillsById.values()].filter((skill) => !orderedIdSet.has(skill.id))
  ];
  const definitions: AbilityDefinition[] = [...playerSkills, ...content.registry.aiSkills, ...content.registry.talents];
  const abilityRegistry = createStandaloneAbilityRegistry(definitions, content.registry.statuses, content.index.abilityCatalogVersion);

  const characters: CharacterDefinition[] = [];
  const catalog: CharacterMetadata[] = [];
  for (const loaded of content.packages) {
    const matchResult = loaded.resources.find((result) => result.descriptor.type === "game.character-match");
    if (!matchResult) continue;
    const match = matchResult.value as CharacterMatchResource;
    const aiSkills = match.aiSkills.map((binding) => {
      const definition = loaded.resources.find((result) => result.descriptor.id === binding.resourceId)?.value as AbilityDefinition | undefined;
      if (!definition || !supportsAbilitySourceKind(definition, "ai-skill")) throw new Error(`角色 AI Skill 无效：${match.metadata.id}#${binding.resourceId}`);
      return validateAbilityBinding({ definitionId: definition.id, enabled: binding.enabled, parameters: binding.parameters }, abilityRegistry);
    });
    const packageId = `${loaded.manifest.identity.authorId}/${loaded.manifest.identity.packageName}`;
    for (const file of loaded.manifest.files) if (file.mediaType.startsWith("image/")) {
      try { registerCharacterImage(loaded.resolvePath(file.path), { packageId, path: file.path }); } catch { /* unavailable optional image */ }
    }
    const rawData = resolveMedia(match.definition, loaded) as Record<string, unknown>;
    const rawDialogue = loaded.resources.find(r => r.descriptor.id === match.dialogueResourceId)?.value as CharacterDialogue;
    const dialogue = { ...rawDialogue, rules: rawDialogue.rules.map(rule => {
      if (!rule.portrait) return rule;
      try { return { ...rule, portrait: { ...rule.portrait, image: loaded.resolvePath(rule.portrait.image) } }; }
      catch { return { ...rule, portrait: { ...rule.portrait, image: "about:invalid#dialogue-portrait" } }; }
    }) };
    // Unresolved rule art is recognized by the selector; only its rule falls through.
    const data = CharacterDataSchema.parse({ ...rawData, aiSkills, dialogue }) as CharacterData;
    const faction = match.metadata.faction ? factions.get(match.metadata.faction) : undefined;
    if (match.metadata.faction && !faction) diagnostics.push(Object.freeze({
      packageId, resourceId: matchResult.descriptor.id, type: "presentation.faction",
      state: "dormant", reason: "reference-unavailable", error: `阵营资源不可用：${match.metadata.faction}`
    }));
    const factionValue = faction?.value as FactionResource | undefined;
    const legacyBadge = match.metadata.badge ? { ...match.metadata.badge, image: loaded.resolvePath(match.metadata.badge.image) } : undefined;
    const badge = factionValue?.badge && faction
      ? { label: factionValue.name, image: faction.resolvePath(factionValue.badge) }
      : legacyBadge;
    const matchMusicSources: string[] = [];
    const appendMusic = (path: string | undefined, owner: Pick<LoadedHocpkgPackage, "resolvePath">, ownerId: string, descriptor = matchResult.descriptor) => {
      if (!path) return;
      try { matchMusicSources.push(owner.resolvePath(path)); }
      catch { diagnostics.push(Object.freeze({
        packageId: ownerId, resourceId: descriptor.id, type: descriptor.type,
        state: "dormant", reason: "media-unavailable", error: `牌局音乐不可用：${path}`
      })); }
    };
    appendMusic(match.metadata.matchMusic, loaded, packageId);
    if (faction) appendMusic(factionValue?.matchMusic, faction, faction.packageId, faction.descriptor);
    const { matchMusic: _matchMusic, ...characterMetadata } = match.metadata;
    const metadata: CharacterMetadata = {
      ...characterMetadata,
      previewImage: loaded.resolvePath(match.metadata.previewImage),
      badge
    };
    catalog.push(metadata);
    characters.push(Object.freeze({ ...metadata, ...data,
      ...(matchMusicSources.length ? { matchMusicSources: Object.freeze([...new Set(matchMusicSources)]) } : {})
    }));
  }
  const defaultCharacterId = catalog.find((character) => character.id === content.index.defaultCharacterId)?.id
    ?? catalog.find((character) => !character.unlock)?.id
    ?? catalog[0]?.id;
  if (!defaultCharacterId) throw new Error("启用的内容包中没有可作为默认对手的角色。");
  const effectiveCatalog = catalog.map((character) => character.id === defaultCharacterId ? { ...character, unlock: undefined } : character);
  const effectiveCharacters = characters.map((character) => character.id === defaultCharacterId ? { ...character, unlock: undefined } : character);
  return Object.freeze({
    abilityRegistry,
    definitions: Object.freeze(definitions),
    statuses: Object.freeze([...content.registry.statuses]),
    characters: Object.freeze(effectiveCharacters),
    catalog: Object.freeze(effectiveCatalog),
    defaultCharacterId,
    extensions: content.registry.extensions,
    diagnostics: Object.freeze(diagnostics)
  });
}

export function activateContentRuntime(prepared: PreparedContentRuntime): void {
  installAbilityRegistry(prepared.definitions, prepared.statuses, prepared.abilityRegistry.catalogVersion);
  installCharacterCatalog(prepared.catalog, prepared.defaultCharacterId);
  installCharacterDefinitions(prepared.characters);
}

export function deactivateContentRuntime(): void {
  clearCharacterImages();
  installAbilityRegistry([], [], ABILITY_CATALOG_VERSION);
  clearCharacterCatalog();
  clearCharacterDefinitions();
}

export function installContent(content: LoadedContent): void {
  activateContentRuntime(prepareContentRuntime(content));
}

export async function bootstrapContent(
  options: ConstructorParameters<typeof EmbeddedContentSource>[0] = {},
  loadOptions: LoadContentOptions = {}
): Promise<LoadedContent> {
  const content = await loadEmbeddedContent(options, loadOptions);
  installContent(content);
  return content;
}
