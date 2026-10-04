import { describe, expect, it } from "vitest";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { FileContentRepository } from "../storage/repository";
import type { ContentPackageSource } from "../storage/contracts";
import { encodeText, sha256 } from "../storage/encoding";
import type { HocpkgManifest } from "./schema";
import type { ContentPackageAccess, ContentSource } from "./content-source";
import { ContentPackageManager } from "./content-package-manager";
import { playlistDocument } from "../playlists/store";

async function fixture(packageName: string): Promise<{ source: ContentPackageSource; access: ContentPackageAccess }> {
  const path = "resources/content.json";
  const bytes = encodeText(`{"package":"${packageName}"}`);
  const manifest: HocpkgManifest = {
    format: "house-of-chances-hocpkg",
    formatVersion: 1,
    identity: { authorId: "test", packageName, version: "1.0.0" },
    metadata: { title: packageName, description: "test", tags: [], creators: [{ displayName: "test", roles: ["design"] }] },
    resources: [{ id: "content", type: "test.content", apiVersion: 1, entry: path, requires: [] }],
    files: [{ path, bytes: bytes.byteLength, sha256: await sha256(bytes), mediaType: "application/json" }],
    extensions: {}
  };
  const source = { manifest, async *files() { yield { path, bytes }; } } satisfies ContentPackageSource;
  return {
    source,
    access: {
      ...source,
      packageId: `test/${packageName}`,
      readJson: async () => ({ package: packageName }),
      resolveAsset: async () => ({ url: `memory://${packageName}/${path}` })
    }
  };
}

async function characterFixture(packageName: string): Promise<{ source: ContentPackageSource; access: ContentPackageAccess }> {
  const path = "resources/content.json";
  const coverPath = "cover.png";
  const payload = {
    metadata: {
      id: packageName,
      name: `角色 ${packageName}`,
      subtitle: "test",
      tier: "B",
      tags: [],
      previewImage: coverPath,
      portraitScales: { selection: 1, table: 1 }
    },
    definition: { assets: { cover: coverPath } },
    aiSkills: [],
    rewardSkillResourceIds: []
  };
  const bytes = encodeText(JSON.stringify(payload));
  const cover = new Uint8Array([137, 80, 78, 71]);
  const manifest: HocpkgManifest = {
    format: "house-of-chances-hocpkg",
    formatVersion: 1,
    identity: { authorId: "test", packageName, version: "1.0.0" },
    metadata: { title: packageName, description: "test", tags: [], creators: [{ displayName: "test", roles: ["design"] }] },
    resources: [{ id: "content", type: "game.character-match", apiVersion: 3, entry: path, requires: [] }],
    files: [
      { path, bytes: bytes.byteLength, sha256: await sha256(bytes), mediaType: "application/json" },
      { path: coverPath, bytes: cover.byteLength, sha256: await sha256(cover), mediaType: "image/png" }
    ],
    extensions: {}
  };
  const source = { manifest, async *files() { yield { path, bytes }; yield { path: coverPath, bytes: cover }; } } satisfies ContentPackageSource;
  return {
    source,
    access: {
      ...source,
      packageId: `test/${packageName}`,
      readJson: async () => payload,
      resolveAsset: async (assetPath) => ({ url: `memory://${packageName}/${assetPath}` })
    }
  };
}

describe("ContentPackageManager inventory", () => {
  it("loads available entries despite advisory version differences and missing packages", async () => {
    const character = await characterFixture("character");
    const plugin = await fixture("plugin");
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.installBatch([character.source, plugin.source]);
    const manager = new ContentPackageManager(repository, { packages: async () => [character.access, plugin.access] });
    expect(await manager.applyPlaylist(playlistDocument("empty", [{ packageId: "test/plugin", version: "2.0.0" }, { packageId: "lost/hero", version: "1.0.0" }]))).toEqual({
      missing: ["lost/hero"], versionMismatch: ["test/plugin"]
    });
    expect((await repository.listPackages()).map((entry) => [entry.packageId, entry.enabled])).toEqual([["test/character", false], ["test/plugin", true]]);
  });
  it("merges installed packages with embedded packages without installing missing entries", async () => {
    const one = await fixture("one");
    const two = await fixture("two");
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.install(one.source);
    const embedded: ContentSource = { packages: async () => [one.access, two.access] };

    await expect(new ContentPackageManager(repository, embedded).listPackages()).resolves.toEqual([
      expect.objectContaining({ packageId: "test/one", state: "enabled", source: "embedded", bytes: one.access.manifest.files[0]!.bytes }),
      expect.objectContaining({ packageId: "test/two", state: "not-installed", source: "embedded", bytes: two.access.manifest.files[0]!.bytes })
    ]);
  });

  it("disables ordinary packages but refuses to disable the final character package", async () => {
    const character = await characterFixture("character");
    const system = await fixture("system");
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.installBatch([character.source, system.source]);
    const manager = new ContentPackageManager(repository, { packages: async () => [character.access, system.access] });

    await manager.disablePackage("test/system");
    await expect(repository.listPackages()).resolves.toContainEqual(expect.objectContaining({ packageId: "test/system", enabled: false }));
    await expect(manager.disablePackage("test/character")).rejects.toThrow(/至少需要保留一个启用的角色包/);
  });

  it("re-enables a disabled package", async () => {
    const character = await characterFixture("character");
    const system = await fixture("system");
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.installBatch([character.source, system.source]);
    const manager = new ContentPackageManager(repository, { packages: async () => [character.access, system.access] });
    await manager.disablePackage("test/system");

    await manager.enablePackage("test/system");
    await expect(repository.listPackages()).resolves.toContainEqual(expect.objectContaining({ packageId: "test/system", enabled: true }));
  });

  it("keeps cover presentation available for disabled and not-installed embedded packages", async () => {
    const first = await characterFixture("first");
    const second = await characterFixture("second");
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.installBatch([first.source, second.source]);
    const manager = new ContentPackageManager(repository, { packages: async () => [first.access, second.access] });

    await manager.disablePackage("test/first");
    const disabled = (await manager.listPackages()).find((entry) => entry.packageId === "test/first");
    expect(disabled).toMatchObject({
      state: "disabled",
      presentation: { characterName: "角色 first", coverAsset: { url: expect.stringContaining("cover.png") } }
    });

    await manager.removePackage("test/first");
    const removed = (await manager.listPackages()).find((entry) => entry.packageId === "test/first");
    expect(removed).toMatchObject({
      state: "not-installed",
      presentation: { characterName: "角色 first", coverAsset: { url: "memory://first/cover.png" } }
    });
  });

  it("falls back without a cover when an installed manifest is broken", async () => {
    const first = await characterFixture("first");
    const second = await characterFixture("second");
    const provider = new MemoryContentHostProvider();
    const repository = new FileContentRepository(provider.host);
    await repository.installBatch([first.source, second.source]);
    const manifestPath = [...provider.fileSystem.entries.keys()].find((path) => path.includes("test/first/") && path.endsWith("hocpkg-info.json"));
    if (!manifestPath) throw new Error("missing installed manifest fixture");
    provider.fileSystem.entries.delete(manifestPath);

    const broken = (await new ContentPackageManager(repository, { packages: async () => [first.access, second.access] }).listPackages())
      .find((entry) => entry.packageId === "test/first");

    expect(broken).toMatchObject({ state: "broken", presentation: { resourceCounts: { characters: 1 } } });
    expect(broken?.presentation.coverAsset).toBeUndefined();
  });

  it("removes packages while protecting the final enabled character", async () => {
    const first = await characterFixture("first");
    const second = await characterFixture("second");
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.installBatch([first.source, second.source]);
    const manager = new ContentPackageManager(repository, { packages: async () => [first.access, second.access] });

    await manager.removePackage("test/first");
    await expect(manager.removePackage("test/second")).rejects.toThrow(/至少需要保留一个启用的角色包/);
    await expect(manager.listPackages()).resolves.toEqual([
      expect.objectContaining({ packageId: "test/first", state: "not-installed" }),
      expect.objectContaining({ packageId: "test/second", state: "enabled" })
    ]);
  });

  it("restores a removed embedded package as enabled content", async () => {
    const first = await characterFixture("first");
    const second = await characterFixture("second");
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.installBatch([first.source, second.source]);
    const manager = new ContentPackageManager(repository, { packages: async () => [first.access, second.access] });
    await manager.removePackage("test/first");
    const progress: string[] = [];

    await manager.restoreEmbeddedPackage("test/first", { onProgress: (entry) => progress.push(entry.path) });

    await expect(repository.listPackages()).resolves.toContainEqual(expect.objectContaining({ packageId: "test/first", enabled: true }));
    expect(progress).toEqual(["resources/content.json", "cover.png"]);
    await expect(manager.restoreEmbeddedPackage("test/first")).rejects.toThrow(/已经安装/);
    await expect(manager.restoreEmbeddedPackage("test/missing")).rejects.toThrow(/没有可恢复/);
  });
});
