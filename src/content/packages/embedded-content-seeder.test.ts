import { describe, expect, it, vi } from "vitest";
import { encodeText, sha256 } from "../storage/encoding";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { FileContentRepository } from "../storage/repository";
import type { ContentPackageAccess, ContentSource } from "./content-source";
import { EmbeddedContentSeeder } from "./embedded-content-seeder";
import type { HocpkgManifest } from "./schema";

async function source(packageName: string, body = `{"package":"${packageName}"}`): Promise<ContentPackageAccess> {
  const bytes = encodeText(body);
  const path = "resources/content.json";
  const manifest: HocpkgManifest = {
    format: "house-of-chances-hocpkg",
    formatVersion: 1,
    identity: { authorId: "test", packageName, version: "1.0.0" },
    metadata: { title: packageName, description: "test", tags: [], creators: [{ displayName: "test", roles: ["design"] }] },
    resources: [{ id: "content", type: "test.content", apiVersion: 1, entry: path, requires: [] }],
    files: [{ path, bytes: bytes.byteLength, sha256: await sha256(bytes), mediaType: "application/json" }],
    extensions: {}
  };
  return {
    packageId: `test/${packageName}`,
    manifest,
    async *files() { yield { path, bytes }; },
    async readJson() { return JSON.parse(body) as unknown; },
    async resolveAsset(assetPath) { return { url: `test://${assetPath}` }; }
  };
}

function setup() {
  const provider = new MemoryContentHostProvider();
  return { provider, repository: new FileContentRepository(provider.host) };
}

describe("EmbeddedContentSeeder", () => {
  it("seeds an empty repository with one generic atomic batch and byte progress", async () => {
    const { repository } = setup();
    const packages = [await source("one"), await source("two")];
    const contentSource: ContentSource = { packages: vi.fn(async () => packages) };
    const progress = vi.fn();
    await expect(new EmbeddedContentSeeder(repository, contentSource).seed({ onProgress: progress })).resolves.toEqual({ seeded: true, packageCount: 2 });
    expect(await repository.listPackages()).toHaveLength(2);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completedBytes: expect.any(Number), totalBytes: expect.any(Number) }));
    expect(progress.mock.lastCall?.[0].completedBytes).toBe(progress.mock.lastCall?.[0].totalBytes);
  });

  it("does not inspect or write the embedded source when the repository is non-empty", async () => {
    const { repository } = setup();
    await repository.install(await source("existing"));
    const packages = vi.fn<ContentSource["packages"]>();
    const before = await repository.listPackages();
    await expect(new EmbeddedContentSeeder(repository, { packages }).seed()).resolves.toEqual({ seeded: false, packageCount: 0 });
    expect(packages).not.toHaveBeenCalled();
    expect(await repository.listPackages()).toEqual(before);
  });

  it("keeps the catalog logically empty when any package fails", async () => {
    const { repository } = setup();
    const valid = await source("valid");
    const invalid = { ...await source("invalid"), async *files() {} };
    await expect(new EmbeddedContentSeeder(repository, { packages: async () => [valid, invalid] }).seed()).rejects.toThrow("缺少文件");
    expect(await repository.isEmpty()).toBe(true);
  });
});
