import { describe, expect, it } from "vitest";
import type { HocpkgManifest } from "../packages";
import { CONTENT_CATALOG_PATHS, ContentCatalogCorruptionError, readCatalogSlots } from "./catalog";
import type { ContentPackageSource } from "./contracts";
import { encodeText, sha256, sha256Json, stableJson } from "./encoding";
import { MemoryContentHostProvider } from "./memory-host";
import { ContentPackageConflictError, ContentPackageIntegrityError, FileContentRepository } from "./repository";

async function packageSource(
  packageName: string,
  version = "1.0.0",
  body = `{"package":"${packageName}","version":"${version}"}`,
  authorId = "test"
): Promise<ContentPackageSource> {
  const bytes = encodeText(body);
  const path = "resources/content.json";
  const manifest: HocpkgManifest = {
    format: "house-of-chances-hocpkg",
    formatVersion: 1,
    identity: { authorId, packageName, version },
    metadata: { title: packageName, description: "test", tags: [], creators: [{ displayName: "test", roles: ["design"] }] },
    resources: [{ id: "content", type: "test.content", apiVersion: 1, entry: path, requires: [] }],
    files: [{ path, bytes: bytes.byteLength, sha256: await sha256(bytes), mediaType: "application/json" }],
    extensions: {}
  };
  return {
    manifest,
    receipt: { source: "test" },
    async *files() { yield { path, bytes }; }
  };
}

function setup() {
  const provider = new MemoryContentHostProvider();
  const repository = new FileContentRepository(provider.host, () => "2026-09-17T00:00:00.000Z");
  return { provider, repository };
}

describe("ContentRepository", () => {
  it("copies source handles in a batch, verifies written files and preserves the catalog on cancellation or bad digests", async () => {
    const { provider, repository } = setup();
    await repository.install(await packageSource("existing"));
    const packageBytes = encodeText("referenced resource");
    await provider.fileSystem.write("input/payload", packageBytes);
    const source = await packageSource("referenced", "1.0.0", "referenced resource");
    const references: ContentPackageSource = { manifest: source.manifest, async *files() { yield { path: "resources/content.json", source: { kind: "stored", path: "input/payload" } }; } };
    const host = provider.host;
    let batches = 0, inspections = 0, invalidDigest = true;
    const abort = new AbortController();
    let cancelDuringCopy = false;
    const optimized = {
      ...host,
      fileSystem: {
        read: host.fileSystem.read.bind(host.fileSystem), write: host.fileSystem.write.bind(host.fileSystem),
        list: host.fileSystem.list.bind(host.fileSystem), remove: host.fileSystem.remove.bind(host.fileSystem),
        async copyMany(files: readonly { source: { kind: string; path?: string }; destination: string }[]) {
          batches++;
          for (const file of files) await host.fileSystem.write(file.destination, (await host.fileSystem.read(file.source.path!))!);
          if (cancelDuringCopy) abort.abort();
          return files.map(() => ({ bytes: packageBytes.length, sha256: invalidDigest ? "0".repeat(64) : (source.manifest as HocpkgManifest).files[0]!.sha256 }));
        },
        async inspect(paths: readonly string[]) {
          inspections++;
          return Promise.all(paths.map(async path => { const bytes = (await host.fileSystem.read(path))!; return { bytes: bytes.length, sha256: await sha256(bytes) }; }));
        }
      }
    };
    const fast = new FileContentRepository(optimized);
    await expect(fast.install(references)).rejects.toThrow(/摘要不符/);
    expect(await fast.listPackages()).toHaveLength(1);
    invalidDigest = false; cancelDuringCopy = true;
    await expect(fast.install(references, { signal: abort.signal })).rejects.toThrow();
    expect(await new FileContentRepository(host).listPackages()).toHaveLength(1);
    expect(await host.fileSystem.list("content/v1/revisions/test/referenced")).toEqual([]);
    cancelDuringCopy = false;
    await fast.install(references);
    expect(batches).toBe(3);
    expect(inspections).toBe(1);
    await fast.verifyPackage("test/referenced");
    expect(inspections).toBe(2);
  });
  it("moves package identity atomically and keeps the old package after a failed commit", async () => {
    const { provider, repository } = setup();
    await repository.install(await packageSource("one"));
    await repository.disablePackage("test/one");
    await repository.setPluginOrder(["test/one"]);
    const old = await repository.readManifest("test/one");
    const renamed = { ...old, identity: { ...old.identity, authorId: "new-author" } };
    provider.fileSystem.failNext("write", /catalog-[ab]\.json$/, 1);
    await expect(repository.reidentifyPackage("test/one", renamed)).rejects.toThrow(/injected write failure/);
    const reopened = new FileContentRepository(provider.host);
    expect((await reopened.listPackages()).map((entry) => entry.packageId)).toEqual(["test/one"]);
    await reopened.verifyPackage("test/one");
    await reopened.reidentifyPackage("test/one", renamed);
    expect((await reopened.listPackages()).map(({ packageId, enabled }) => ({ packageId, enabled }))).toEqual([{ packageId: "new-author/one", enabled: false }]);
    expect(await reopened.listPluginOrder()).toEqual(["new-author/one"]);
    await reopened.verifyPackage("new-author/one");
  });

  it("refuses to overwrite a colliding destination or change resources during identity migration", async () => {
    const { repository } = setup();
    await repository.installBatch([await packageSource("one"), await packageSource("one", "2.0.0", "newer", "new-author")]);
    const old = await repository.readManifest("test/one");
    await expect(repository.reidentifyPackage("test/one", { ...old, identity: { ...old.identity, authorId: "new-author" } })).rejects.toThrow(/同时存在/);
    await expect(repository.reidentifyPackage("test/one", { ...old, identity: { ...old.identity, authorId: "other" }, resources: [{ ...old.resources[0]!, id: "changed" }] })).rejects.toThrow(/不能改变资源/);
    expect(await repository.listPackages()).toHaveLength(2);
  });

  it("switches an installed enabled set atomically, including an empty set", async () => {
    const { provider, repository } = setup();
    await repository.installBatch([await packageSource("one"), await packageSource("two")]);
    const revisions = (await repository.listPackages()).map((entry) => entry.currentRevision);
    await repository.setEnabledPackages(["test/two"]);
    expect((await repository.listPackages()).map((entry) => entry.enabled)).toEqual([false, true]);
    await expect(repository.setEnabledPackages(["test/one", "test/missing"])).rejects.toThrow(/尚未安装/);
    expect((await repository.listPackages()).map((entry) => entry.enabled)).toEqual([false, true]);
    provider.fileSystem.failNext("write", /catalog-[ab]\.json$/, 1);
    await expect(repository.setEnabledPackages(["test/one"])).rejects.toThrow(/injected write failure/);
    expect((await new FileContentRepository(provider.host).listPackages()).map((entry) => entry.enabled)).toEqual([false, true]);
    await repository.setEnabledPackages([]);
    expect((await repository.listPackages()).map((entry) => entry.enabled)).toEqual([false, false]);
    expect((await repository.listPackages()).map((entry) => entry.currentRevision)).toEqual(revisions);
  });
  it("persists plugin priority through disable and restart and removes deleted ids", async () => {
    const { provider, repository } = setup();
    await repository.installBatch([await packageSource("one"), await packageSource("two")]);
    await repository.setPluginOrder(["test/two", "test/one"]);
    await repository.disablePackage("test/two");
    const reopened = new FileContentRepository(provider.host);
    expect(await reopened.listPluginOrder()).toEqual(["test/two", "test/one"]);
    await reopened.removePackage("test/two");
    expect(await reopened.listPluginOrder()).toEqual(["test/one"]);
  });

  it("installs an arbitrary batch with one neutral package-to-revision catalog", async () => {
    const { repository } = setup();
    expect(await repository.isEmpty()).toBe(true);
    const result = await repository.installBatch([await packageSource("one"), await packageSource("two")]);
    expect(result.changed).toBe(true);
    expect(result.cleanup).toBe("complete");
    expect(await repository.listPackages()).toEqual([
      { packageId: "test/one", currentRevision: expect.stringMatching(/^[a-f0-9]{64}$/), enabled: true },
      { packageId: "test/two", currentRevision: expect.stringMatching(/^[a-f0-9]{64}$/), enabled: true }
    ]);
    await expect(repository.readManifest("test/one")).resolves.toMatchObject({ identity: { packageName: "one" } });
    await expect(repository.readFile("test/two", "resources/content.json")).resolves.toEqual(encodeText('{"package":"two","version":"1.0.0"}'));
    await expect(repository.resolveAsset("test/one", "resources/content.json")).resolves.toEqual({
      url: expect.stringContaining("memory-content://content/v1/revisions/test/one/")
    });
  });

  it("keeps independent package revisions and treats the same content as a no-op", async () => {
    const { repository } = setup();
    const one = await packageSource("one");
    await repository.installBatch([one, await packageSource("two")]);
    const before = await repository.listPackages();
    expect((await repository.install(one)).changed).toBe(false);
    await repository.install(await packageSource("one", "1.1.0"));
    const after = await repository.listPackages();
    expect(after.find((entry) => entry.packageId === "test/one")?.currentRevision).not.toBe(before.find((entry) => entry.packageId === "test/one")?.currentRevision);
    expect(after.find((entry) => entry.packageId === "test/two")).toEqual(before.find((entry) => entry.packageId === "test/two"));
  });

  it("disables a package atomically without deleting its current revision", async () => {
    const { provider, repository } = setup();
    await repository.install(await packageSource("one"));
    const before = (await repository.listPackages())[0]!;
    await expect(repository.disablePackage("test/one")).resolves.toMatchObject({ changed: true, cleanup: "complete" });
    await expect(repository.disablePackage("test/one")).resolves.toMatchObject({ changed: false });
    await expect(repository.listPackages()).resolves.toEqual([{ ...before, enabled: false }]);
    expect([...provider.fileSystem.entries.keys()].some((path) => path.includes(before.currentRevision))).toBe(true);
  });

  it("re-enables a disabled package without changing its revision", async () => {
    const { repository } = setup();
    await repository.install(await packageSource("one"));
    await repository.disablePackage("test/one");
    const revision = (await repository.listPackages())[0]!.currentRevision;

    await expect(repository.enablePackage("test/one")).resolves.toMatchObject({ changed: true, cleanup: "complete" });
    await expect(repository.enablePackage("test/one")).resolves.toMatchObject({ changed: false });
    await expect(repository.listPackages()).resolves.toEqual([{ packageId: "test/one", currentRevision: revision, enabled: true }]);
  });

  it("removes a package from the catalog before reclaiming its revision", async () => {
    const { provider, repository } = setup();
    await repository.installBatch([await packageSource("one"), await packageSource("two")]);
    const revision = (await repository.listPackages()).find((entry) => entry.packageId === "test/one")!.currentRevision;

    await expect(repository.removePackage("test/one")).resolves.toMatchObject({ changed: true, cleanup: "complete" });
    await expect(repository.removePackage("test/one")).resolves.toMatchObject({ changed: false });
    expect((await repository.listPackages()).map((entry) => entry.packageId)).toEqual(["test/two"]);
    expect([...provider.fileSystem.entries.keys()].some((path) => path.includes(revision))).toBe(false);
  });

  it("keeps a committed removal and defers revision cleanup after a file-system failure", async () => {
    const { provider, repository } = setup();
    await repository.install(await packageSource("one"));
    provider.fileSystem.failNext("remove", /revisions\/test\/one\//);

    await expect(repository.removePackage("test/one")).resolves.toMatchObject({ changed: true, cleanup: "deferred" });
    await expect(repository.listPackages()).resolves.toEqual([]);
    const reopened = new FileContentRepository(provider.host);
    await expect(reopened.listPackages()).resolves.toEqual([]);
    expect([...provider.fileSystem.entries.keys()].some((path) => path.includes("revisions/test/one"))).toBe(false);
  });

  it("applies ordinary downgrade and same-version replacement policy", async () => {
    const { repository } = setup();
    await repository.install(await packageSource("one", "2.0.0"));
    await expect(repository.install(await packageSource("one", "1.0.0"))).rejects.toBeInstanceOf(ContentPackageConflictError);
    await expect(repository.install(await packageSource("one", "2.0.0", "changed"))).rejects.toBeInstanceOf(ContentPackageConflictError);
    await expect(repository.install(await packageSource("one", "1.0.0"), { allowDowngrade: true })).resolves.toMatchObject({ changed: true });
  });

  it("rejects undeclared, duplicate, missing, and corrupt files without committing", async () => {
    const cases: ContentPackageSource[] = [];
    const base = await packageSource("broken");
    cases.push({ ...base, async *files() { yield { path: "other.json", bytes: encodeText("x") }; } });
    cases.push({ ...base, async *files() { const entry = { path: "resources/content.json", bytes: encodeText('{"package":"broken","version":"1.0.0"}') }; yield entry; yield entry; } });
    cases.push({ ...base, async *files() {} });
    cases.push({ ...base, async *files() { yield { path: "resources/content.json", bytes: encodeText("bad") }; } });
    for (const source of cases) {
      const { repository } = setup();
      await expect(repository.install(source)).rejects.toBeInstanceOf(ContentPackageIntegrityError);
      expect(await repository.isEmpty()).toBe(true);
    }
  });

  it("re-verifies every installed file before runtime activation", async () => {
    const { provider, repository } = setup();
    await repository.install(await packageSource("one"));
    const progress: string[] = [];
    await repository.verifyPackage("test/one", (entry) => progress.push(entry.path));
    expect(progress).toEqual(["resources/content.json"]);

    const file = [...provider.fileSystem.entries.keys()].find((path) => path.endsWith("resources/content.json"))!;
    const corrupted = Uint8Array.from(provider.fileSystem.entries.get(file)!);
    corrupted[0] = corrupted[0]! ^ 0xff;
    provider.fileSystem.entries.set(file, corrupted);
    await expect(repository.verifyPackage("test/one")).rejects.toThrow(/文件摘要不符/);
  });

  it("keeps the old catalog when the committed switch cannot be written", async () => {
    const { provider, repository } = setup();
    await repository.install(await packageSource("one", "1.0.0"));
    const before = await repository.listPackages();
    provider.fileSystem.failNext("write", /catalog-a\.json$/);
    await expect(repository.install(await packageSource("one", "2.0.0"))).rejects.toThrow(/injected write failure/);
    const reopened = new FileContentRepository(provider.host);
    expect(await reopened.listPackages()).toEqual(before);
  });

  it("commits the new catalog but defers cleanup when mirror write fails", async () => {
    const { provider, repository } = setup();
    await repository.install(await packageSource("one", "1.0.0"));
    const previous = (await repository.listPackages())[0]!.currentRevision;
    provider.fileSystem.failNext("write", /catalog-b\.json$/, 1);
    const result = await repository.install(await packageSource("one", "2.0.0"));
    expect(result.cleanup).toBe("deferred");
    expect((await repository.listPackages())[0]!.currentRevision).not.toBe(previous);
    expect([...provider.fileSystem.entries.keys()].some((path) => path.includes(previous))).toBe(true);
  });

  it("falls back from a corrupt newest slot and rejects two corrupt occupied slots", async () => {
    const first = setup();
    await first.repository.install(await packageSource("one"));
    first.provider.fileSystem.entries.set(CONTENT_CATALOG_PATHS[0], encodeText("broken"));
    await expect(new FileContentRepository(first.provider.host).listPackages()).resolves.toHaveLength(1);

    first.provider.fileSystem.entries.set(CONTENT_CATALOG_PATHS[1], encodeText("also-broken"));
    await expect(new FileContentRepository(first.provider.host).open()).rejects.toBeInstanceOf(ContentCatalogCorruptionError);
  });

  it("migrates both v1 catalog slots in place and keeps every package enabled", async () => {
    const { provider } = setup();
    const revision = "a".repeat(64);
    const writeLegacy = async (path: typeof CONTENT_CATALOG_PATHS[number], generation: number) => {
      const body = {
        storageVersion: 1 as const,
        generation,
        writtenAt: "2026-09-16T00:00:00.000Z",
        state: "committed" as const,
        catalog: { packages: { "test/legacy": revision } }
      };
      provider.fileSystem.entries.set(path, encodeText(stableJson({ ...body, checksum: await sha256Json(body) })));
    };
    await writeLegacy(CONTENT_CATALOG_PATHS[0], 1);
    await writeLegacy(CONTENT_CATALOG_PATHS[1], 2);

    const reopened = new FileContentRepository(provider.host, () => "2026-09-17T00:00:00.000Z");
    await expect(reopened.listPackages()).resolves.toEqual([{ packageId: "test/legacy", currentRevision: revision, enabled: true }]);
    const slots = await readCatalogSlots(provider.fileSystem);
    expect(slots.committed).toHaveLength(2);
    expect(slots.committed.every((slot) => !slot.requiresMigration)).toBe(true);
  });

  it("migrates v2 catalog slots with disabled packages and an empty plugin order", async () => {
    const { provider } = setup();
    const body = {
      storageVersion: 2 as const,
      generation: 1,
      writtenAt: "2026-09-16T00:00:00.000Z",
      state: "committed" as const,
      catalog: { packages: { "test/old": { currentRevision: "b".repeat(64), enabled: false } } }
    };
    provider.fileSystem.entries.set(CONTENT_CATALOG_PATHS[0], encodeText(stableJson({ ...body, checksum: await sha256Json(body) })));
    const reopened = new FileContentRepository(provider.host);
    expect(await reopened.listPluginOrder()).toEqual([]);
    expect(await reopened.listPackages()).toEqual([{ packageId: "test/old", currentRevision: "b".repeat(64), enabled: false }]);
    expect((await readCatalogSlots(provider.fileSystem)).committed.every((slot) => !slot.requiresMigration)).toBe(true);
  });

  it("removes interrupted unreferenced revisions on the next open", async () => {
    const { provider } = setup();
    provider.fileSystem.entries.set("content/v1/revisions/test/orphan/a/.pending", encodeText("pending"));
    provider.fileSystem.entries.set("content/v1/revisions/test/orphan/a/file.json", encodeText("data"));
    const reopened = new FileContentRepository(provider.host);
    await reopened.open();
    expect([...provider.fileSystem.entries.keys()].some((path) => path.includes("orphan"))).toBe(false);
  });
});
