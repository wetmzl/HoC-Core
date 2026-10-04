import { z } from "zod";
import type { ResolvedContentAsset } from "../storage/contracts";
import type { ContentPackageAccess } from "./content-source";
import { CharacterMatchResourceSchema } from "./resources";
import { HocpkgPortablePathSchema, type HocpkgManifest } from "./schema";

export interface ManagedContentResourceCounts {
  readonly characters: number;
  readonly playerSkills: number;
  readonly talents: number;
  readonly aiSkills: number;
  readonly statuses: number;
  readonly other: number;
}

export interface ManagedContentPackagePresentation {
  readonly characterName?: string;
  readonly coverAsset?: ResolvedContentAsset;
  readonly resourceCounts: ManagedContentResourceCounts;
}

export interface PackagePresentationAccess {
  readonly manifest: HocpkgManifest;
  readJson(path: string): Promise<unknown>;
  resolveAsset(path: string): Promise<ResolvedContentAsset>;
}

const characterCoverSchema = z.object({
  assets: z.object({ cover: HocpkgPortablePathSchema }).passthrough()
}).passthrough();

export function countPackageResources(manifest: HocpkgManifest): ManagedContentResourceCounts {
  const counts = { characters: 0, playerSkills: 0, talents: 0, aiSkills: 0, statuses: 0, other: 0 };
  for (const resource of manifest.resources) {
    if (resource.type === "game.character-match") counts.characters += 1;
    else if (resource.type === "game.player-skill") counts.playerSkills += 1;
    else if (resource.type === "game.talent") counts.talents += 1;
    else if (resource.type === "game.ai-skill") counts.aiSkills += 1;
    else if (resource.type === "game.status") counts.statuses += 1;
    else counts.other += 1;
  }
  return Object.freeze(counts);
}

export function packagePresentationFallback(manifest: HocpkgManifest | undefined): ManagedContentPackagePresentation {
  return Object.freeze({
    resourceCounts: manifest
      ? countPackageResources(manifest)
      : Object.freeze({ characters: 0, playerSkills: 0, talents: 0, aiSkills: 0, statuses: 0, other: 0 })
  });
}

/** Optional launcher preview data. Failure here must not change package validity or runtime activation. */
export async function loadPackagePresentation(access: PackagePresentationAccess | ContentPackageAccess): Promise<ManagedContentPackagePresentation> {
  const resourceCounts = countPackageResources(access.manifest);
  const packageCover = access.manifest.metadata.coverImage;
  if (packageCover) {
    try {
      const file = access.manifest.files.find((entry) => entry.path === packageCover && entry.mediaType.startsWith("image/"));
      if (file) return Object.freeze({ coverAsset: await access.resolveAsset(file.path), resourceCounts });
    } catch {
      // A missing optional preview must not block the package manager.
    }
  }
  const characterDescriptor = access.manifest.resources.find((resource) => resource.type === "game.character-match");
  if (!characterDescriptor) return Object.freeze({ resourceCounts });

  try {
    const character = CharacterMatchResourceSchema.parse(await access.readJson(characterDescriptor.entry));
    const definition = characterCoverSchema.parse(character.definition);
    const coverFile = access.manifest.files.find((file) => file.path === definition.assets.cover && file.mediaType.startsWith("image/"));
    if (!coverFile) return Object.freeze({ characterName: character.metadata.name, resourceCounts });
    const coverAsset = await access.resolveAsset(coverFile.path);
    return Object.freeze({ characterName: character.metadata.name, coverAsset, resourceCounts });
  } catch {
    return Object.freeze({ resourceCounts });
  }
}

export function releasePackagePresentation(presentation: ManagedContentPackagePresentation | undefined): void {
  presentation?.coverAsset?.release?.();
}
