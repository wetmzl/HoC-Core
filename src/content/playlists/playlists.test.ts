import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { decodeText, encodeText, sha256Json } from "../storage/encoding";
import { unzipChecked, zipFiles } from "../transfer/hocpkg";
import { PlaylistDocumentSchema, PlaylistStore, playlistDocument } from "./store";
import { decodePlaylistBytes, decodePlaylistFile, encodePlaylistHocpkg, encodePlaylistPng, MAX_PLAYLIST_FILE, PlaylistArchiveError, playlistJson } from "./transfer";
import type { ContentFileSystem, ContentImportFile } from "../storage/contracts";
import { releaseImportFile } from "../storage/import-file";

const sample = () => playlistDocument("夜场", [{ packageId: "author/hero", version: "1.1.0" }, { packageId: "author/plugin" }]);

describe("playlists", () => {
  it("migrates legacy builtin references in imported playlists without losing explicit canonical versions", async () => {
    const document = playlistDocument("旧内嵌包", [
      { packageId: "hoc-art/chatgpt", version: "1.0.0" },
      { packageId: "hoc-core/chatgpt", version: "1.0.4" },
      { packageId: "commuity/official-built-in-talents" },
      { packageId: "example/third-party" }
    ], ["hoc-art/chatgpt", "example/third-party"]);
    const migrated = await decodePlaylistBytes(encodeText(playlistJson(document)));
    expect(migrated.packages).toEqual([
      { packageId: "hoc-core/chatgpt", version: "1.0.4" },
      { packageId: "hoc-core/official-built-in-talents" },
      { packageId: "example/third-party" }
    ]);
    expect(migrated.pluginOrder).toEqual(["hoc-core/chatgpt", "example/third-party"]);
  });

  it("validates identity, version, and duplicate package entries", () => {
    expect(() => PlaylistDocumentSchema.parse({ ...sample(), packages: [{ packageId: "author/hero" }, { packageId: "author/hero" }] })).toThrow();
    expect(() => PlaylistDocumentSchema.parse({ ...sample(), packages: [{ packageId: "../hero" }] })).toThrow();
    expect(() => PlaylistDocumentSchema.parse({ ...sample(), packages: [{ packageId: "author/hero", version: "bad" }] })).toThrow();
  });

  it("saves by name, copies, renames, deletes, and restores from either slot", async () => {
    const host = new MemoryContentHostProvider();
    const store = new PlaylistStore(host.fileSystem);
    const unnamed = await store.save(playlistDocument("  ", sample().packages));
    expect(unnamed.document.name).toBe("未命名播放集（1）");
    const updated = await store.save(playlistDocument(" 未命名播放集（1） ", []));
    expect(updated.id).toBe(unnamed.id);
    expect(updated.document.packages).toEqual([]);
    const copy = await store.copy(unnamed.id);
    expect(copy.document.name).toBe("未命名播放集（1）（副本 1）");
    await expect(store.rename(copy.id, unnamed.document.name)).rejects.toThrow(/占用/);
    await store.rename(copy.id, "另一个");
    expect((await new PlaylistStore(host.fileSystem).list()).map((entry) => entry.document.name)).toEqual(["未命名播放集（1）", "另一个"]);
    host.fileSystem.entries.delete("content/v1/playlists-a.json");
    expect((await new PlaylistStore(host.fileSystem).list()).length).toBeGreaterThan(0);
    await store.remove(copy.id);
    expect((await store.list()).map((entry) => entry.id)).toEqual([unnamed.id]);
  });

  it("keeps the prior committed library after a failed slot switch", async () => {
    const host = new MemoryContentHostProvider();
    const store = new PlaylistStore(host.fileSystem);
    await store.save(sample());
    const before = await store.list();
    host.fileSystem.failNext("write", /playlists-[ab]\.json$/, 1);
    await expect(store.save(playlistDocument("second", []))).rejects.toThrow(/injected write failure/);
    expect(await new PlaylistStore(host.fileSystem).list()).toEqual(before);
  });

  it("recovers an empty library after interruption before the first commit", async () => {
    const host = new MemoryContentHostProvider();
    const store = new PlaylistStore(host.fileSystem);
    host.fileSystem.failNext("write", /playlists-b\.json$/);
    await expect(store.save(sample())).rejects.toThrow();
    expect(await new PlaylistStore(host.fileSystem).list()).toEqual([]);
    await expect(store.save(sample())).resolves.toMatchObject({ document: { name: "夜场" } });
  });

  it("imports a batch in one commit without replacing existing names", async () => {
    const host = new MemoryContentHostProvider();
    const store = new PlaylistStore(host.fileSystem);
    const existing = await store.save(sample());
    const imported = await store.importBatch([sample(), sample(), playlistDocument("另一个", [])]);
    expect(imported.map((entry) => entry.document.name)).toEqual(["夜场（副本 1）", "夜场（副本 2）", "另一个"]);
    expect((await store.list())[0]).toEqual(existing);
    const before = await store.list();
    host.fileSystem.failNext("write", /playlists-[ab]\.json$/, 1);
    await expect(store.importBatch([sample(), sample()])).rejects.toThrow(/injected write failure/);
    expect(await new PlaylistStore(host.fileSystem).list()).toEqual(before);
  });

  it("round trips JSON, hocpkg, and PNG with an advisory package version", async () => {
    const document = sample();
    expect(await decodePlaylistBytes(encodeText(playlistJson(document)))).toEqual(document);
    const hocpkg = await encodePlaylistHocpkg(document, crypto.randomUUID());
    const files = await unzipChecked(hocpkg);
    expect(Object.keys(files).sort()).toEqual(["hocpkg-info.json", "playlist.json"]);
    expect(await decodePlaylistBytes(hocpkg)).toEqual(document);
    const cover = new Uint8Array(readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url)));
    const png = await encodePlaylistPng(document, crypto.randomUUID(), cover);
    expect(png.subarray(0, 8)).toEqual(cover.subarray(0, 8));
    expect(await decodePlaylistBytes(png)).toEqual(document);
  });

  it("rejects corrupt and non-playlist archives without changing the document", async () => {
    const bytes = await encodePlaylistHocpkg(sample(), crypto.randomUUID());
    const files = await unzipChecked(bytes);
    const changed = { ...files, "playlist.json": encodeText(JSON.stringify(playlistDocument("tampered", []))) };
    await expect(decodePlaylistBytes(await zipFiles(changed))).rejects.toThrow(/摘要|大小/);
    await expect(decodePlaylistBytes(await zipFiles({ ...files, "extra.txt": encodeText("x") }))).rejects.toThrow();
    await expect(decodePlaylistBytes(encodeText("not json"))).rejects.toThrow();
    expect(JSON.parse(decodeText(files["playlist.json"]!))).toEqual(sample());
  });

  it("offers archive fallback only for failed ZIP or PNG decoding, including files above the playlist limit", async () => {
    const archive = await zipFiles({ "content.hocpkg": encodeText("content") });
    const oversized = new File([new Uint8Array(archive), new Uint8Array(MAX_PLAYLIST_FILE)], "bundle.zip");
    const read = vi.spyOn(oversized, "arrayBuffer");
    await expect(decodePlaylistFile(oversized)).rejects.toThrow(PlaylistArchiveError);
    expect(read).not.toHaveBeenCalled();
    await expect(decodePlaylistFile(new File([new Uint8Array(archive)], "bundle.zip"))).rejects.toThrow(PlaylistArchiveError);
    const cover = readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url));
    await expect(decodePlaylistFile(new File([cover], "cover.png"))).rejects.toThrow(PlaylistArchiveError);
    await expect(decodePlaylistFile(new File(["not json"], "invalid.zip"))).rejects.not.toBeInstanceOf(PlaylistArchiveError);
    const valid = await encodePlaylistHocpkg(sample(), crypto.randomUUID());
    await expect(decodePlaylistFile(new File([new Uint8Array(valid)], "playlist.hocpkg"))).resolves.toEqual(sample());
  });
  it("reads native picker sources for JSON, hocpkg and PNG without browser File objects", async () => {
    const cover = readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url));
    for (const body of [encodeText(playlistJson(sample())), await encodePlaylistHocpkg(sample(), crypto.randomUUID()), await encodePlaylistPng(sample(), crypto.randomUUID(), cover)]) {
      const host = new MemoryContentHostProvider();
      const file: ContentImportFile = { name: "selected.input", size: body.length, source: { kind: "stored", path: "content/v1/import-inputs/selected.input" } };
      await host.fileSystem.write(file.source.kind === "stored" ? file.source.path : "", body);
      const readRange = vi.fn(async (_source, offset: number, length: number) => body.slice(offset, offset + length));
      const fs: ContentFileSystem = { ...host.fileSystem, read: host.fileSystem.read.bind(host.fileSystem), write: host.fileSystem.write.bind(host.fileSystem), list: host.fileSystem.list.bind(host.fileSystem), remove: host.fileSystem.remove.bind(host.fileSystem), readRange };
      await expect(decodePlaylistFile(file, [], fs)).resolves.toEqual(sample());
      expect(readRange.mock.calls.map(call => call.slice(1, 3))).toEqual([[0, 8], [0, body.length]]);
      expect(await host.fileSystem.read("content/v1/import-inputs/selected.input")).not.toBeNull();
      await releaseImportFile(fs, file);
      expect(await host.fileSystem.read("content/v1/import-inputs/selected.input")).toBeNull();
    }
  });
  it("hands large managed archives to the bundle flow after only a signature read", async () => {
    const host = new MemoryContentHostProvider();
    const read = vi.spyOn(host.fileSystem, "read");
    const readRange = vi.fn(async () => Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0, 0, 0));
    Object.assign(host.fileSystem, { readRange });
    const file: ContentImportFile = { name: "bundle.zip", size: 175323611, source: { kind: "stored", path: "content/v1/import-inputs/bundle.input" } };
    await expect(decodePlaylistFile(file, [], host.fileSystem)).rejects.toBeInstanceOf(PlaylistArchiveError);
    expect(readRange).toHaveBeenCalledExactlyOnceWith(file.source, 0, 8, undefined);
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps read failures, truncated input and cancellation out of the archive fallback", async () => {
    const host = new MemoryContentHostProvider();
    const file: ContentImportFile = { name: "playlist.zip", size: 8, source: { kind: "stored", path: "content/v1/import-inputs/broken.input" } };
    const readRange = vi.fn().mockResolvedValueOnce(Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0, 0, 0)).mockRejectedValueOnce(new Error("ENOSPC"));
    Object.assign(host.fileSystem, { readRange });
    await expect(decodePlaylistFile(file, [], host.fileSystem)).rejects.toThrow("ENOSPC");
    readRange.mockResolvedValue(new Uint8Array(0));
    await expect(decodePlaylistFile(file, [], host.fileSystem)).rejects.toThrow("读取不完整");
    const abort = new AbortController();
    abort.abort();
    readRange.mockClear();
    await expect(decodePlaylistFile(file, [], host.fileSystem, { signal: abort.signal })).rejects.not.toBeInstanceOf(PlaylistArchiveError);
    expect(readRange).not.toHaveBeenCalled();
    await host.fileSystem.write("original.zip", Uint8Array.of(1));
    await releaseImportFile(host.fileSystem, { ...file, source: { kind: "stored", path: "original.zip" } });
    expect(await host.fileSystem.read("original.zip")).toEqual(Uint8Array.of(1));
  });
  it("migrates a v1 library without losing saved names and creates a current default", async () => {
    const host = new MemoryContentHostProvider();
    const old = { format: "house-of-chances-playlist-library", formatVersion: 1, generation: 3, state: "committed",
      playlists: [{ id: crypto.randomUUID(), document: { format: "house-of-chances-playlist", formatVersion: 1,
        name: "旧收藏", packages: [{ packageId: "old/hero", version: "1.0.0" }] } }] };
    await host.fileSystem.write("content/v1/playlists-a.json", encodeText(JSON.stringify({ ...old, checksum: await sha256Json(old) })));
    const store = new PlaylistStore(host.fileSystem, ["old/plugin"]);
    const current = await store.initialize([{ packageId: "new/hero", version: "2.0.0" }], ["new/plugin"]);
    expect(current.document).toMatchObject({ formatVersion: 2, name: "默认播放集", pluginOrder: ["new/plugin"] });
    expect((await store.list()).find((item) => item.document.name === "旧收藏")?.document.pluginOrder).toEqual(["old/plugin"]);
    expect(await new PlaylistStore(host.fileSystem).currentId()).toBe(current.id);
  });

  it("auto-saves the active playlist, keeps missing entries, and blocks deletion until switching", async () => {
    const host = new MemoryContentHostProvider();
    const store = new PlaylistStore(host.fileSystem);
    const current = await store.initialize([{ packageId: "old/hero" }], ["old/plugin"]);
    const updated = await store.updateCurrent(playlistDocument("ignored", [{ packageId: "old/hero" }, { packageId: "new/hero" }], ["new/plugin", "old/plugin"]));
    expect(updated.id).toBe(current.id);
    expect((await new PlaylistStore(host.fileSystem).list())[0]?.document).toMatchObject({
      name: "默认播放集", pluginOrder: ["new/plugin", "old/plugin"], packages: [{ packageId: "old/hero" }, { packageId: "new/hero" }]
    });
    await expect(store.remove(current.id)).rejects.toThrow(/当前播放集不能删除/);
    const copy = await store.copy(current.id);
    await store.select(copy.id);
    await store.remove(current.id);
    expect(await store.currentId()).toBe(copy.id);
  });

  it("accepts a v1 JSON document and exports it as v2", async () => {
    const old = { format: "house-of-chances-playlist", formatVersion: 1, name: "旧清单", packages: [{ packageId: "a/hero" }] };
    const migrated = await decodePlaylistBytes(encodeText(JSON.stringify(old)));
    expect(migrated).toEqual(playlistDocument("旧清单", [{ packageId: "a/hero" }]));
    expect(await decodePlaylistBytes(encodeText(JSON.stringify(old)), ["local/plugin"])).toEqual(playlistDocument("旧清单", [{ packageId: "a/hero" }], ["local/plugin"]));
    expect(JSON.parse(playlistJson(migrated)).formatVersion).toBe(2);
  });

});
