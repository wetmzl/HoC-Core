import { describe, expect, it, vi } from "vitest";
import type { ContentPackageAccess } from "../packages/content-source";
import type { HocpkgManifest } from "../packages/schema";
import type { ContentInstallProgress, ContentOperationOptions } from "./contracts";
import { decodeText, encodeText, sha256 } from "./encoding";
import { MemoryContentHostProvider } from "./memory-host";
import { ContentPackageIntegrityError, FileContentRepository } from "./repository";

async function source(name: string, version = "1.0.0"): Promise<ContentPackageAccess> {
  const packageId = `example/${name}`;
  const entries = new Map([
    ["resources/content.json", encodeText(JSON.stringify({ name, version }))],
    ["assets/sample.bin", encodeText(`neutral asset for ${name} ${version}`)]
  ]);
  const manifest: HocpkgManifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: name, version },
    metadata: { title: name, description: "neutral startup fixture", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: "content", type: "example.content", apiVersion: 1, entry: "resources/content.json", requires: [] }],
    files: await Promise.all([...entries].map(async ([path, bytes]) => ({
      path, bytes: bytes.length, sha256: await sha256(bytes),
      mediaType: path.endsWith(".json") ? "application/json" : "application/octet-stream"
    }))),
    extensions: {}
  };
  const readFile = vi.fn(async (path: string) => {
    const bytes = entries.get(path);
    if (!bytes) throw new Error("Undeclared fixture file");
    return Uint8Array.from(bytes);
  });
  return {
    packageId, manifest, readFile,
    readJson: async path => JSON.parse(decodeText(await readFile(path))),
    resolveAsset: vi.fn(async path => ({ url: `/embedded/${name}/${path}` })),
    async *files() { for (const [path, bytes] of entries) yield { path, bytes }; }
  };
}

function setup() {
  const provider = new MemoryContentHostProvider();
  const digest = async (paths: readonly string[]) => Promise.all(paths.map(async path => {
    const bytes = await provider.fileSystem.read(path);
    if (!bytes) throw new Error(`Missing content file: ${path}`);
    return { bytes: bytes.length, sha256: await sha256(bytes) };
  }));
  const inspect = vi.fn(async (paths: readonly string[], options?: ContentOperationOptions) => {
    const digests = await digest(paths);
    for (const [index, path] of paths.entries()) {
      const bytes = digests[index]!.bytes;
      options?.onProgress?.({ phase: "verifying", path, completedBytes: bytes, totalBytes: bytes });
    }
    return digests;
  });
  const fs = provider.fileSystem;
  const repository = new FileContentRepository({ ...provider.host, fileSystem: {
    read: fs.read.bind(fs), write: fs.write.bind(fs), list: fs.list.bind(fs), remove: fs.remove.bind(fs), inspect
  } });
  return { provider, repository, inspect, digest };
}

describe("verified startup package snapshot", () => {
  it("inspects all enabled stored files in one batch and reuses their manifests for later content access", async () => {
    const { provider, repository, inspect } = setup();
    await repository.installBatch([await source("one"), await source("two")]);
    inspect.mockClear();
    // The host binds read at construction; observe the same reads through its backing entries.
    const entryRead = vi.spyOn(provider.fileSystem.entries, "get");
    const packages = await repository.verifyEnabledPackages();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect.mock.calls[0]![0]).toHaveLength(4);
    expect(packages.map(entry => entry.packageId)).toEqual(["example/one", "example/two"]);
    expect(entryRead.mock.calls.filter(([path]) => path.endsWith("/hocpkg-info.json"))).toHaveLength(2);

    entryRead.mockClear();
    for (const entry of packages) {
      expect(await entry.readJson("resources/content.json")).toMatchObject({ version: "1.0.0" });
      expect(await entry.resolveAsset("assets/sample.bin")).toMatchObject({ url: expect.stringContaining(`/revisions/${entry.packageId}/`) });
      const files = [];
      for await (const file of entry.files()) files.push(file.path);
      expect(files.sort()).toEqual(["assets/sample.bin", "resources/content.json"]);
      await expect(entry.readJson("../outside.json")).rejects.toThrow();
      await expect(entry.resolveAsset("assets/undeclared.bin")).rejects.toThrow();
    }
    expect(entryRead.mock.calls.filter(([path]) => path.endsWith("/hocpkg-info.json"))).toEqual([]);
  });

  it("rechecks file bytes on every invocation even when the revision has not changed", async () => {
    const { provider, repository, inspect } = setup();
    await repository.install(await source("one"));
    await repository.verifyEnabledPackages();
    inspect.mockClear();
    const path = [...provider.fileSystem.entries.keys()].find(path => path.endsWith("/assets/sample.bin"))!;
    const damaged = Uint8Array.from(provider.fileSystem.entries.get(path)!);
    damaged[0] = damaged[0]! ^ 0xff;
    provider.fileSystem.entries.set(path, damaged);
    await expect(repository.verifyEnabledPackages()).rejects.toBeInstanceOf(ContentPackageIntegrityError);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it.each(["identity", "revision"] as const)("rejects a changed manifest %s before inspecting or exposing package sources", async change => {
    const { provider, repository, inspect } = setup();
    await repository.install(await source("one"));
    const path = [...provider.fileSystem.entries.keys()].find(path => path.endsWith("/hocpkg-info.json"))!;
    const manifest = JSON.parse(decodeText(provider.fileSystem.entries.get(path)!)) as HocpkgManifest;
    if (change === "identity") manifest.identity.packageName = "other";
    else manifest.metadata.title = "Changed metadata";
    provider.fileSystem.entries.set(path, encodeText(JSON.stringify(manifest)));
    inspect.mockClear();
    await expect(repository.verifyEnabledPackages()).rejects.toBeInstanceOf(ContentPackageIntegrityError);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects an incomplete host digest response", async () => {
    const { repository, inspect } = setup();
    await repository.install(await source("one"));
    inspect.mockImplementationOnce(async () => []);
    await expect(repository.verifyEnabledPackages()).rejects.toThrow("文件数量不符");
  });

  it("keeps progress package-local and monotonic when host notifications arrive out of order", async () => {
    const { repository, inspect, digest } = setup();
    await repository.installBatch([await source("one"), await source("longer-name")]);
    inspect.mockImplementationOnce(async (paths, options) => {
      const digests = await digest(paths);
      for (let index = paths.length - 1; index >= 0; index--) {
        const bytes = digests[index]!.bytes;
        options?.onProgress?.({ phase: "verifying", path: paths[index]!, completedBytes: bytes, totalBytes: bytes });
        options?.onProgress?.({ phase: "verifying", path: paths[index]!, completedBytes: 0, totalBytes: bytes });
      }
      return digests;
    });
    const progress: ContentInstallProgress[] = [];
    const packages = await repository.verifyEnabledPackages(entry => progress.push(entry));
    for (const entry of packages) {
      const total = entry.manifest.files.reduce((sum, file) => sum + file.bytes, 0);
      const reports = progress.filter(report => report.packageId === entry.packageId);
      expect(reports.length).toBeGreaterThan(0);
      expect(reports.at(-1)?.completedBytes).toBe(total);
      expect(reports.every(report => report.totalBytes === total && report.completedBytes <= total)).toBe(true);
      expect(reports.every(report => entry.manifest.files.some(file => file.path === report.path))).toBe(true);
      expect(reports.map(report => report.completedBytes)).toEqual(reports.map(report => report.completedBytes).sort((a, b) => a - b));
    }
  });

  it("keeps disabled and archived definitions out while preserving direct embedded access", async () => {
    const { repository, inspect } = setup();
    const embedded = await source("builtin", "2.0.0");
    await repository.installBatch([await source("stored"), await source("disabled"), await source("builtin")]);
    await repository.configureEmbedded([embedded]);
    await repository.resolveEmbeddedConflicts(false);
    await repository.setEnabledPackages(["example/stored", "example/builtin"]);
    inspect.mockClear();
    const packages = await repository.verifyEnabledPackages();
    expect(packages.map(entry => entry.packageId).sort()).toEqual(["example/builtin", "example/stored"]);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect.mock.calls[0]![0].every(path => path.includes("/example/stored/"))).toBe(true);
    expect(embedded.readFile).not.toHaveBeenCalled();
    const direct = packages.find(entry => entry.packageId === embedded.packageId)!;
    expect(direct.manifest.identity.version).toBe("2.0.0");
    expect(await direct.resolveAsset("assets/sample.bin")).toEqual({ url: "/embedded/builtin/assets/sample.bin" });
    expect(await direct.readJson("resources/content.json")).toMatchObject({ version: "2.0.0" });
  });

  it("finishes verification before a queued replacement and pins access to the verified revision", async () => {
    const { provider, repository, inspect, digest } = setup();
    await repository.install(await source("one"));
    const previous = (await repository.listPackages())[0]!;
    const replacement = await source("one", "2.0.0");
    let unblock!: () => void, signalStarted!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    inspect.mockImplementationOnce(async paths => {
      signalStarted();
      await blocked;
      return digest(paths);
    });
    const verifying = repository.verifyEnabledPackages();
    await started;
    // Keep the old revision available after replacement so the captured source can still read it.
    provider.fileSystem.failNext("remove", new RegExp(previous.currentRevision));
    const writes = vi.spyOn(provider.fileSystem.entries, "set");
    const replacing = repository.install(replacement);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).not.toHaveBeenCalled();
    unblock();
    const [snapshot] = await verifying;
    await expect(replacing).resolves.toMatchObject({ changed: true, cleanup: "deferred" });
    expect(snapshot!.manifest.identity.version).toBe("1.0.0");
    expect(await snapshot!.readJson("resources/content.json")).toMatchObject({ version: "1.0.0" });
    expect(await snapshot!.resolveAsset("assets/sample.bin")).toMatchObject({ url: expect.stringContaining(previous.currentRevision) });
    const [current] = await repository.verifyEnabledPackages();
    expect(await current!.readJson("resources/content.json")).toMatchObject({ version: "2.0.0" });
  });
});
