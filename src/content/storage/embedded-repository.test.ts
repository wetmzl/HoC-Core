import { describe, expect, it, vi } from "vitest";
import type { ContentPackageAccess } from "../packages/content-source";
import type { HocpkgManifest } from "../packages/schema";
import { MemoryContentHostProvider } from "./memory-host";
import { FileContentRepository } from "./repository";
import { encodeText, sha256 } from "./encoding";

async function source(name = "sample", body = '{"value":1}'): Promise<ContentPackageAccess> {
  const bytes = encodeText(body), path = "content.json";
  const manifest: HocpkgManifest = { format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: name, version: "1.0.0" },
    metadata: { title: "同名内容", description: "neutral fixture", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: "data", type: "example.data", apiVersion: 1, entry: path, requires: [] }],
    files: [{ path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: "application/json" }], extensions: {} };
  return { manifest, packageId: `example/${name}`, readFile: vi.fn(async () => bytes), readJson: async () => JSON.parse(body),
    resolveAsset: vi.fn(async () => ({ url: `/embedded/example/${path}` })), async *files() { yield { path, bytes }; } };
}

describe("direct embedded repository", () => {
  it("registers without reading bodies, prevents deletion at the repository boundary, and persists enable state", async () => {
    const provider = new MemoryContentHostProvider(), embedded = await source(), repo = new FileContentRepository(provider.host);
    await repo.configureEmbedded([embedded]);
    expect(await repo.isEmpty()).toBe(false);
    expect(embedded.readFile).not.toHaveBeenCalled();
    expect(await provider.fileSystem.list("content/v1/revisions")).toEqual([]);
    expect(await repo.listPackages()).toEqual([expect.objectContaining({ packageId: embedded.packageId, embedded: true, enabled: true })]);
    await expect(repo.removePackage(embedded.packageId)).rejects.toThrow("不能删除");
    await repo.disablePackage(embedded.packageId);
    const reopened = new FileContentRepository(provider.host); await reopened.configureEmbedded([embedded], new Set([embedded.packageId]));
    expect((await reopened.listPackages())[0]?.enabled).toBe(false);
    await reopened.enablePackage(embedded.packageId);
    expect((await reopened.listPackages())[0]?.enabled).toBe(true);
  });

  it("uses a distributor's default enabled selection only for a genuinely new library", async () => {
    const provider = new MemoryContentHostProvider(), one = await source(), two = await source("two"), repo = new FileContentRepository(provider.host);
    await repo.configureEmbedded([one, two], undefined, new Set([two.packageId]));
    expect((await repo.listPackages()).filter(entry => entry.enabled).map(entry => entry.packageId)).toEqual([two.packageId]);
    const reopened = new FileContentRepository(provider.host); await reopened.configureEmbedded([one, two], undefined, new Set([one.packageId]));
    expect((await reopened.listPackages()).filter(entry => entry.enabled).map(entry => entry.packageId)).toEqual([two.packageId]);
  });

  for (const clean of [false, true]) it(`resolves only full-ID collisions, preserves order/disable state and ${clean ? "cleans" : "archives"} the old body`, async () => {
    const provider = new MemoryContentHostProvider(), embedded = await source(), other = await source("custom"), repo = new FileContentRepository(provider.host);
    await repo.installBatch([embedded, other]); await repo.disablePackage(embedded.packageId);
    await repo.setPluginOrder([other.packageId, embedded.packageId]);
    await repo.configureEmbedded([embedded]);
    expect(await repo.listStoredConflicts()).toHaveLength(1);
    await repo.resolveEmbeddedConflicts(clean);
    expect(await repo.listStoredConflicts()).toEqual([]);
    expect(await repo.listPluginOrder()).toEqual([other.packageId, embedded.packageId]);
    expect((await repo.listPackages()).find(p => p.packageId === embedded.packageId)?.enabled).toBe(false);
    expect((await repo.listPackages()).find(p => p.packageId === other.packageId)?.enabled).toBe(true);
    const archives = await repo.listArchives(); expect(archives).toHaveLength(clean ? 0 : 1);
    const reopened = new FileContentRepository(provider.host); await reopened.configureEmbedded([embedded]);
    expect(await reopened.listStoredConflicts()).toEqual([]); expect(await reopened.listArchives()).toHaveLength(clean ? 0 : 1);
    if (!clean) {
      const archived = await reopened.archiveSource(archives[0]!.id);
      expect(await archived.readJson("content.json")).toEqual({ value: 1 });
      await reopened.removeArchive(archives[0]!.id);
      expect(await reopened.listArchives()).toEqual([]);
      expect((await reopened.listPackages()).some(p => p.packageId === other.packageId)).toBe(true);
    }
  });

  it("leaves a failed migration recoverable and does not collect its old files", async () => {
    const provider = new MemoryContentHostProvider(), embedded = await source(), repo = new FileContentRepository(provider.host);
    await repo.install(embedded); await repo.configureEmbedded([embedded]);
    provider.fileSystem.failNext("write", /catalog-[ab]\.json$/, 1);
    await expect(repo.resolveEmbeddedConflicts(true)).rejects.toThrow();
    const reopened = new FileContentRepository(provider.host); await reopened.configureEmbedded([embedded]);
    expect(await reopened.listStoredConflicts()).toHaveLength(1);
    expect((await provider.fileSystem.list("content/v1/revisions")).length).toBeGreaterThan(0);
    await reopened.resolveEmbeddedConflicts(false); expect(await reopened.listArchives()).toHaveLength(1);
  });

  it("keeps newly added embedded entries disabled in an existing library and applies playlists to both sources", async () => {
    const provider = new MemoryContentHostProvider(), first = await source(), added = await source("added"), custom = await source("custom"), repo = new FileContentRepository(provider.host);
    await repo.configureEmbedded([first]); await repo.install(custom);
    await repo.configureEmbedded([first, added]);
    expect((await repo.listPackages()).find(p => p.packageId === added.packageId)?.enabled).toBe(false);
    await repo.setEnabledPackages([added.packageId, custom.packageId]);
    expect((await repo.listPackages()).filter(p => p.enabled).map(p => p.packageId).sort()).toEqual([added.packageId, custom.packageId].sort());
  });

  it("preserves an archived revision when reimporting it is followed by a failed batch", async () => {
    const provider = new MemoryContentHostProvider(), embedded = await source(), repo = new FileContentRepository(provider.host);
    await repo.install(embedded); await repo.configureEmbedded([embedded]); await repo.resolveEmbeddedConflicts(false);
    const id = (await repo.listArchives())[0]!.id;
    const broken = { ...await source("broken"), async *files() {} };
    await expect(repo.installBatch([embedded, broken])).rejects.toThrow("缺少文件");
    expect(await (await repo.archiveSource(id)).readJson("content.json")).toEqual({ value: 1 });
  });

  it("does not revive deleted content in an existing empty user catalog", async () => {
    const provider = new MemoryContentHostProvider(), embedded = await source(), repo = new FileContentRepository(provider.host);
    await repo.install(embedded); await repo.removePackage(embedded.packageId);
    const reopened = new FileContentRepository(provider.host); await reopened.configureEmbedded([embedded], new Set([embedded.packageId]));
    expect((await reopened.listPackages())[0]?.enabled).toBe(false);
  });

  it("handles historical aliases and canonical copies together without copying or activating old definitions", async () => {
    const provider = new MemoryContentHostProvider(), base = await source("chatgpt");
    const embedded = { ...base, packageId: "hoc-core/chatgpt", manifest: { ...base.manifest, identity: { ...base.manifest.identity, authorId: "hoc-core" } } };
    const old = { ...embedded, manifest: { ...embedded.manifest, identity: { ...embedded.manifest.identity, authorId: "hoc-art" } } };
    const repo = new FileContentRepository(provider.host); await repo.installBatch([embedded, old]);
    await repo.disablePackage(embedded.packageId); await repo.setPluginOrder(["hoc-art/chatgpt"]);
    const writes = vi.spyOn(provider.fileSystem, "write");
    await repo.configureEmbedded([embedded]); expect(await repo.listStoredConflicts()).toHaveLength(2);
    await repo.resolveEmbeddedConflicts(false);
    expect(await repo.listArchives()).toHaveLength(2);
    expect(await repo.listPluginOrder()).toEqual([embedded.packageId]);
    expect(await repo.listPackages()).toEqual([expect.objectContaining({ packageId: embedded.packageId, embedded: true, enabled: false })]);
    expect(writes.mock.calls.every(([path]) => !path.includes('/revisions/'))).toBe(true);
  });

  it("can reuse matching archived bytes without activating old definitions or trusting damaged bytes", async () => {
    const provider = new MemoryContentHostProvider(), embedded = await source(), repo = new FileContentRepository(provider.host);
    await repo.install(embedded); await repo.configureEmbedded([embedded]); await repo.resolveEmbeddedConflicts(false);
    const expected = embedded.manifest.files[0]!;
    expect(await repo.resolveArchivedAsset(embedded.packageId, expected)).toMatchObject({ url: expect.stringContaining('memory-content://') });
    expect(await repo.resolveArchivedAsset(embedded.packageId, { ...expected, sha256: '0'.repeat(64) })).toBeUndefined();
    const path = [...provider.fileSystem.entries.keys()].find(path => path.endsWith('/content.json'))!;
    await provider.fileSystem.write(path, encodeText('damaged'));
    expect(await repo.resolveArchivedAsset(embedded.packageId, expected)).toBeUndefined();
    expect(await repo.listPackages()).toEqual([expect.objectContaining({ embedded: true })]);
  });
});
