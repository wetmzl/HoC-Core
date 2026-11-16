import { describe, expect, it, vi } from "vitest";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { FileContentRepository } from "../storage/repository";
import type { ContentPackageSource } from "../storage/contracts";
import { encodeText, sha256 } from "../storage/encoding";
import type { HocpkgManifest } from "./schema";
import type { ContentPackageAccess } from "./content-source";
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
      readFile: async () => bytes,
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
    dialogueResourceId: "dialogue",
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
    resources: [{ id: "content", type: "game.character-match", apiVersion: 4, entry: path, requires: [] }],
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
      readFile: async assetPath => assetPath === coverPath ? cover : bytes,
      resolveAsset: async (assetPath) => ({ url: `memory://${packageName}/${assetPath}` })
    }
  };
}

describe("ContentPackageManager inventory", () => {
  it("uses operation-local metadata for inventory and playlist ordering without caching later reads", async () => {
    const provider = new MemoryContentHostProvider(), repository = new FileContentRepository(provider.host);
    const pkg = await characterFixture("character");
    await repository.install(pkg.source);
    const manager = new ContentPackageManager(repository, { packages: async () => [] });
    const read = vi.spyOn(provider.fileSystem, "read");
    await manager.listPackages();
    expect(read.mock.calls.filter(([path]) => path.endsWith("hocpkg-info.json"))).toHaveLength(1);
    read.mockClear();
    const resolve = vi.spyOn(provider.host.assetResolver, "resolve");
    await manager.applyPlaylist(playlistDocument("selected", [{ packageId: "test/character", version: "1.0.0" }]));
    expect(read.mock.calls.filter(([path]) => path.endsWith("hocpkg-info.json"))).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
    const manifestPath = [...provider.fileSystem.entries.keys()].find(path => path.endsWith("hocpkg-info.json"))!;
    await provider.fileSystem.write(manifestPath, encodeText("corrupt"));
    expect((await manager.listPackages())[0]?.state).toBe("broken");
  });

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
  for (const embedded of [false, true]) it(`applies incremental sets without changing unrelated packages or plugin slots (embedded=${embedded})`, async () => {
    const provider = new MemoryContentHostProvider(), repository = new FileContentRepository(provider.host);
    const packages = await Promise.all(["one", "two", "three", "disabled"].map(async name => {
      const pkg = await fixture(name);
      const manifest = { ...pkg.access.manifest, resources: [{ ...pkg.access.manifest.resources[0]!, type: "plugin.module" }] };
      return { source: { ...pkg.source, manifest }, access: { ...pkg.access, manifest } };
    }));
    if (embedded) await repository.configureEmbedded(packages.map(pkg => pkg.access));
    else await repository.installBatch(packages.map(pkg => pkg.source));
    await repository.disablePackage("test/three");
    await repository.disablePackage("test/disabled");
    await repository.setPluginOrder(["test/one", "test/two", "test/three", "test/disabled"]);
    const manager = new ContentPackageManager(repository, { packages: async () => embedded ? packages.map(pkg => pkg.access) : [] });
    const document = playlistDocument("增量", [{ packageId: "test/one" }, { packageId: "test/three", version: "2.0.0" }, { packageId: "missing/plugin" }], ["test/three", "test/disabled", "test/one"], "incremental");
    expect(await manager.applyPlaylist(document)).toEqual({ missing: ["missing/plugin"], versionMismatch: ["test/three"] });
    const state = await repository.listPackages();
    expect(state.filter(entry => entry.enabled).map(entry => entry.packageId).sort()).toEqual(["test/one", "test/three", "test/two"]);
    expect(state.find(entry => entry.packageId === "test/disabled")?.enabled).toBe(false);
    expect(await repository.listPluginOrder()).toEqual(["test/three", "test/two", "test/one", "test/disabled"]);
    await manager.applyPlaylist(document);
    await manager.applyPlaylist(playlistDocument("空增量", [], [], "incremental"));
    expect(await repository.listPackages()).toEqual(state);
    expect(await repository.listPluginOrder()).toEqual(["test/three", "test/two", "test/one", "test/disabled"]);
    await manager.applyPlaylist(playlistDocument("普通播放集", [{ packageId: "test/one" }]));
    expect((await repository.listPackages()).filter(entry => entry.enabled).map(entry => entry.packageId)).toEqual(["test/one"]);
  });

  it("lists embedded entries without installing any resource bodies", async () => {
    const one = await fixture("one"), two = await fixture("two");
    const provider = new MemoryContentHostProvider(), repository = new FileContentRepository(provider.host);
    await repository.configureEmbedded([one.access, two.access]);
    expect(await new ContentPackageManager(repository, { packages: async () => [one.access, two.access] }).listPackages()).toEqual([
      expect.objectContaining({ packageId: "test/one", state: "enabled", embedded: true }),
      expect.objectContaining({ packageId: "test/two", state: "enabled", embedded: true })
    ]);
    expect(await provider.fileSystem.list("content/v1/revisions")).toEqual([]);
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

  it("keeps disabled embedded previews manageable while rejecting deletion", async () => {
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

    await expect(manager.removePackage("test/first")).rejects.toThrow("不能删除");
    expect((await manager.listPackages()).find(entry => entry.packageId === "test/first")?.state).toBe("disabled");

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
    const manager = new ContentPackageManager(repository, { packages: async () => [] });

    await manager.removePackage("test/first");
    await expect(manager.removePackage("test/second")).rejects.toThrow(/至少需要保留一个启用的角色包/);
    await expect(manager.listPackages()).resolves.toEqual([
      expect.objectContaining({ packageId: "test/second", state: "enabled" })
    ]);
  });

  it("re-enables embedded content without installing or restoring its files", async () => {
    const first = await characterFixture("first"), second = await characterFixture("second");
    const provider = new MemoryContentHostProvider(), repository = new FileContentRepository(provider.host);
    await repository.configureEmbedded([first.access, second.access]);
    const manager = new ContentPackageManager(repository, { packages: async () => [first.access, second.access] });
    await manager.disablePackage("test/first"); await manager.enablePackage("test/first");
    await expect(manager.removePackage("test/first")).rejects.toThrow("不能删除");
    expect(await provider.fileSystem.list("content/v1/revisions")).toEqual([]);
  });
});
