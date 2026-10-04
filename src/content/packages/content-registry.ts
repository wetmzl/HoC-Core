import type { AbilityDefinition, AiSkillAbilityDefinition, StatusDefinition, TalentAbilityDefinition } from "../../core/abilities/types";
import type { HocpkgResourceResult } from "./loader";
import type { CharacterMatchResource, ContentDiagnostic, ExtensionResource, PlayerSkillResource } from "./resources";
import type { HocpkgManifest } from "./schema";

export interface LoadedHocpkgPackage {
  readonly manifest: HocpkgManifest;
  resolvePath(path: string): string;
  readonly resources: readonly HocpkgResourceResult[];
  release?(): void;
}

export interface ContentRegistry {
  readonly characters: readonly CharacterMatchResource[];
  readonly playerSkills: readonly PlayerSkillResource[];
  readonly aiSkills: readonly AiSkillAbilityDefinition[];
  readonly talents: readonly TalentAbilityDefinition[];
  readonly statuses: readonly StatusDefinition[];
  readonly abilityDefinitionsById: Readonly<Record<string, AbilityDefinition>>;
  readonly statusDefinitionsById: Readonly<Record<string, StatusDefinition>>;
  readonly resourceKeysByDefinitionId: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, readonly ExtensionResource[]>>;
  readonly diagnostics: readonly ContentDiagnostic[];
}

function definitionId(type: string, value: unknown): string | undefined {
  if (type === "game.player-skill") return (value as PlayerSkillResource).definition.id;
  if (type === "game.ai-skill" || type === "game.talent" || type === "game.status") return (value as { id?: string }).id;
  return undefined;
}

export function buildContentRegistry(packages: readonly LoadedHocpkgPackage[]): ContentRegistry {
  const characters: CharacterMatchResource[] = [];
  const playerSkills: PlayerSkillResource[] = [];
  const aiSkills: AiSkillAbilityDefinition[] = [];
  const talents: TalentAbilityDefinition[] = [];
  const statuses: StatusDefinition[] = [];
  const abilityDefinitionsById: Record<string, AbilityDefinition> = {};
  const statusDefinitionsById: Record<string, StatusDefinition> = {};
  const resourceKeysByDefinitionId: Record<string, string> = {};
  const extensionsByType: Record<string, ExtensionResource[]> = {};
  const diagnostics: ContentDiagnostic[] = [];
  const packageIds = new Set<string>();

  for (const loaded of packages) {
    const packageId = `${loaded.manifest.identity.authorId}/${loaded.manifest.identity.packageName}`;
    if (packageIds.has(packageId)) throw new Error(`内容包身份重复：${packageId}`);
    packageIds.add(packageId);

    for (const result of loaded.resources) {
      const isCore = result.descriptor.type.startsWith("game.");
      if (isCore) {
        if (result.state !== "active") {
          throw new Error(`内容资源未激活：${packageId}#${result.descriptor.id} (${result.reason ?? result.state})`);
        }
        const value = result.value;
        switch (result.descriptor.type) {
          case "game.character-match": characters.push(value as CharacterMatchResource); break;
          case "game.player-skill": playerSkills.push(value as PlayerSkillResource); break;
          case "game.ai-skill": aiSkills.push(value as AiSkillAbilityDefinition); break;
          case "game.talent": talents.push(value as TalentAbilityDefinition); break;
          case "game.status": statuses.push(value as StatusDefinition); break;
          default: throw new Error(`内容包包含不受支持的核心资源类型：${result.descriptor.type}`);
        }
        const id = definitionId(result.descriptor.type, value);
        if (id) {
          if (resourceKeysByDefinitionId[id]) throw new Error(`内容定义 ID 重复：${id}`);
          resourceKeysByDefinitionId[id] = `${packageId}#${result.descriptor.id}`;
        }
      } else {
        if (result.state !== "active") {
          diagnostics.push(Object.freeze({
            packageId,
            resourceId: result.descriptor.id,
            type: result.descriptor.type,
            state: result.state,
            reason: result.reason,
            error: result.error
          }));
        } else {
          const list = extensionsByType[result.descriptor.type] ?? [];
          extensionsByType[result.descriptor.type] = list;
          list.push(Object.freeze({
            packageId,
            descriptor: result.descriptor,
            value: result.value,
            packageManifest: loaded.manifest,
            resolvePath: (path: string) => loaded.resolvePath(path)
          }));
        }
      }
    }
  }

  for (const skill of playerSkills) abilityDefinitionsById[skill.definition.id] = skill.definition;
  for (const skill of aiSkills) abilityDefinitionsById[skill.id] = skill;
  for (const talent of talents) abilityDefinitionsById[talent.id] = talent;
  for (const status of statuses) statusDefinitionsById[status.id] = status;
  if (new Set(characters.map((character) => character.metadata.id)).size !== characters.length) throw new Error("内容角色 ID 重复");

  const frozenExtensions = Object.freeze(
    Object.fromEntries(Object.entries(extensionsByType).map(([k, v]) => [k, Object.freeze([...v])]))
  );

  return Object.freeze({
    characters: Object.freeze(characters),
    playerSkills: Object.freeze(playerSkills),
    aiSkills: Object.freeze(aiSkills),
    talents: Object.freeze(talents),
    statuses: Object.freeze(statuses),
    abilityDefinitionsById: Object.freeze(abilityDefinitionsById),
    statusDefinitionsById: Object.freeze(statusDefinitionsById),
    resourceKeysByDefinitionId: Object.freeze(resourceKeysByDefinitionId),
    extensions: frozenExtensions,
    diagnostics: Object.freeze(diagnostics)
  });
}
