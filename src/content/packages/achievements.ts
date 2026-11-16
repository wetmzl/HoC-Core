import { ACHIEVEMENT_API_VERSION, AchievementCatalogSchema, AchievementKeySchema, type AchievementCatalog, type AchievementDefinitionEntry } from "../../core/achievements";
import { HocpkgPortablePathSchema } from "./schema";
import type { ExtensionResource, HocpkgResourceHandler } from "./resources";

export interface InstalledAchievementDefinition extends AchievementDefinitionEntry {
  readonly packageId: string;
  readonly catalogKey: string;
  readonly packageTitle: string;
  readonly packageVersion: string;
  readonly coverUrl?: string;
  readonly iconUrl?: string;
}

export function createAchievementCatalogResourceHandler(): HocpkgResourceHandler<AchievementCatalog> {
  return {
    type: "achievement.catalog",
    apiVersions: [ACHIEVEMENT_API_VERSION],
    async parse(payload, context) {
      const catalog = AchievementCatalogSchema.parse(payload);
      const catalogKey = `${context.manifest.identity.authorId}/${context.manifest.identity.packageName}#${context.descriptor.id}`;
      for (const achievement of catalog.achievements) {
        AchievementKeySchema.parse(`${catalogKey}/${achievement.id}`);
        for (const media of [{ path: achievement.cover, label: "封面" }, { path: achievement.icon, label: "图标" }]) {
          if (!media.path) continue;
          const path = HocpkgPortablePathSchema.parse(media.path);
          if (!context.manifest.files.some(file => file.path === path && file.mediaType.startsWith("image/"))) {
            throw new Error(`成就${media.label}必须引用同包已声明的图片：${path}`);
          }
          await context.resolvePath(path);
        }
      }
      return catalog;
    }
  };
}

function freezeValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

/** An immutable content snapshot; durable progress belongs to the achievement consumer. */
export function prepareAchievementCatalogs(resources: readonly ExtensionResource[]): readonly InstalledAchievementDefinition[] {
  return Object.freeze(resources.filter(resource => resource.descriptor.type === "achievement.catalog").flatMap(resource => {
    const catalog = resource.value as AchievementCatalog;
    const catalogKey = `${resource.packageId}#${resource.descriptor.id}`;
    return catalog.achievements.map(achievement => Object.freeze({
      key: AchievementKeySchema.parse(`${catalogKey}/${achievement.id}`),
      definition: freezeValue(structuredClone(achievement)),
      packageId: resource.packageId,
      catalogKey,
      packageTitle: resource.packageManifest.metadata.title,
      packageVersion: resource.packageManifest.identity.version,
      ...(achievement.cover ? { coverUrl: resource.resolvePath(achievement.cover) } : {}),
      ...(achievement.icon ? { iconUrl: resource.resolvePath(achievement.icon) } : {})
    }));
  }));
}
