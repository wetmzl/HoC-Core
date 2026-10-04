import { describe, expect, it, vi } from "vitest";
import type { HocpkgManifest } from "./schema";
import { HocpkgManifestSchema } from "./schema";
import { loadPackagePresentation, packagePresentationFallback, releasePackagePresentation } from "./package-presentation";

function manifest(resources: HocpkgManifest["resources"]): HocpkgManifest {
  return {
    format: "house-of-chances-hocpkg",
    formatVersion: 1,
    identity: { authorId: "test", packageName: "preview", version: "1.0.0" },
    metadata: { title: "Preview", description: "test", tags: [], creators: [{ displayName: "test", roles: ["design"] }] },
    resources,
    files: [
      { path: "resources/match.json", bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" },
      { path: "cover.png", bytes: 1, sha256: "1".repeat(64), mediaType: "image/png" }
    ],
    extensions: {}
  };
}

const characterBody = {
  metadata: {
    id: "preview",
    name: "预览角色",
    subtitle: "test",
    tier: "B",
    tags: [],
    previewImage: "cover.png",
    portraitScales: { selection: 1, table: 1 }
  },
  definition: { assets: { cover: "cover.png" } },
  aiSkills: [],
  rewardSkillResourceIds: []
};

describe("package presentation", () => {
  it("shows a declared cover for a non-character package without reading resource data", async () => {
    const base = manifest([{ id: "skill", type: "game.player-skill", apiVersion: 2, entry: "resources/match.json", requires: [] }]);
    const skillOnly = { ...base, metadata: { ...base.metadata, coverImage: "cover.png" } };
    expect(HocpkgManifestSchema.safeParse(skillOnly).success).toBe(true);
    const readJson = vi.fn();
    const resolveAsset = vi.fn(async () => ({ url: "blob:skill-cover" }));

    await expect(loadPackagePresentation({ manifest: skillOnly, readJson, resolveAsset })).resolves.toMatchObject({
      coverAsset: { url: "blob:skill-cover" },
      resourceCounts: { characters: 0, playerSkills: 1 }
    });
    expect(readJson).not.toHaveBeenCalled();
    expect(resolveAsset).toHaveBeenCalledWith("cover.png");

    expect(HocpkgManifestSchema.safeParse({ ...skillOnly, metadata: { ...skillOnly.metadata, coverImage: "missing.png" } }).success).toBe(false);
  });

  it("reads a character name and releasable cover without activating runtime content", async () => {
    const release = vi.fn();
    const value = await loadPackagePresentation({
      manifest: manifest([
        { id: "match", type: "game.character-match", apiVersion: 3, entry: "resources/match.json", requires: [] },
        { id: "reward", type: "game.player-skill", apiVersion: 2, entry: "resources/match.json", requires: [] },
        { id: "talent", type: "game.talent", apiVersion: 2, entry: "resources/match.json", requires: [] },
        { id: "ai", type: "game.ai-skill", apiVersion: 2, entry: "resources/match.json", requires: [] },
        { id: "status", type: "game.status", apiVersion: 1, entry: "resources/match.json", requires: [] }
      ]),
      readJson: async () => characterBody,
      resolveAsset: async () => ({ url: "blob:cover", release })
    });

    expect(value).toMatchObject({
      characterName: "预览角色",
      coverAsset: { url: "blob:cover" },
      resourceCounts: { characters: 1, playerSkills: 1, talents: 1, aiSkills: 1, statuses: 1, other: 0 }
    });
    releasePackagePresentation(value);
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps skill-only and malformed character packages on the fallback path", async () => {
    const skillOnly = manifest([{ id: "skill", type: "game.player-skill", apiVersion: 2, entry: "resources/match.json", requires: [] }]);
    const readJson = vi.fn(async () => characterBody);
    const resolveAsset = vi.fn(async () => ({ url: "blob:unused" }));

    await expect(loadPackagePresentation({ manifest: skillOnly, readJson, resolveAsset })).resolves.toEqual({
      resourceCounts: { characters: 0, playerSkills: 1, talents: 0, aiSkills: 0, statuses: 0, other: 0 }
    });
    expect(readJson).not.toHaveBeenCalled();
    expect(resolveAsset).not.toHaveBeenCalled();

    const character = manifest([{ id: "match", type: "game.character-match", apiVersion: 3, entry: "resources/match.json", requires: [] }]);
    await expect(loadPackagePresentation({ manifest: character, readJson: async () => ({ broken: true }), resolveAsset })).resolves.toEqual({
      resourceCounts: { characters: 1, playerSkills: 0, talents: 0, aiSkills: 0, statuses: 0, other: 0 }
    });
    expect(resolveAsset).not.toHaveBeenCalled();
  });

  it("builds a zero-cost fallback summary for a broken package", () => {
    expect(packagePresentationFallback(undefined)).toEqual({
      resourceCounts: { characters: 0, playerSkills: 0, talents: 0, aiSkills: 0, statuses: 0, other: 0 }
    });
  });
});
