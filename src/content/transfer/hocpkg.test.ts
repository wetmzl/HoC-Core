import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { unzipSync, zipSync } from "fflate";
import type { HocpkgManifest } from "../packages";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { openBrowserArchive } from "../storage/browser-io";
import type { ContentArchive, ContentFileSource, ContentOperationOptions } from "../storage/contracts";
import { FileContentRepository } from "../storage/repository";
import { encodeText, sha256 } from "../storage/encoding";
import { embedHocpkgInPng, extractHocpkgFromPng, HocpkgTransfer } from "./hocpkg";
import { playlistDocument } from "../playlists/store";
import { encodePlaylistHocpkg } from "../playlists/transfer";

async function makePackage(authorId: string, version: string, body = version, license?: string) {
  const payload = encodeText(JSON.stringify({ body }));
  const path = "resources/content.json";
  const manifest: HocpkgManifest = {
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId, packageName: "hero", version },
    metadata: { title: "Hero", ...(license === undefined ? {} : { license }), description: "test", tags: [], creators: [{ displayName: authorId, roles: ["design"] }] },
    resources: [{ id: "content", type: "test.content", apiVersion: 1, entry: path, requires: [] }],
    files: [{ path, bytes: payload.length, sha256: await sha256(payload), mediaType: "application/json" }], extensions: {}
  };
  return { manifest, bytes: zipSync({ "hocpkg-info.json": encodeText(JSON.stringify(manifest)), [path]: payload }) };
}

function setup() {
  const host = new MemoryContentHostProvider();
  const repository = new FileContentRepository(host.host);
  return { host, repository, transfer: new HocpkgTransfer(host.fileSystem, repository) };
}

function file(bytes: Uint8Array, name: string): File { return new File([Uint8Array.from(bytes)], name); }

function clearZipUtf8Flags(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  let end = copy.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("ZIP 缺少中央目录。");
  let cursor = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏。");
    const local = view.getUint32(cursor + 42, true);
    view.setUint16(cursor + 8, view.getUint16(cursor + 8, true) & ~0x800, true);
    view.setUint16(local + 6, view.getUint16(local + 6, true) & ~0x800, true);
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return copy;
}

describe("hocpkg transfer", () => {
  it("checks digests from batch archive extraction and keeps damaged candidates isolated", async () => {
    const { host, transfer } = setup();
    const pkg = await makePackage("batch", "1.0.0");
    let batches = 0, corrupt = true;
    const fs = host.fileSystem as typeof host.fileSystem & { openArchive(source: ContentFileSource, options?: ContentOperationOptions): Promise<ContentArchive> };
    fs.openArchive = async (source, options) => {
      const archive = await openBrowserArchive(fs, source, options);
      return { ...archive, async extractMany(files, options) {
        batches++;
        const result = [];
        for (const file of files) result.push(await archive.extract(file.path, file.destination, options));
        return result.map(digest => ({ ...digest, sha256: corrupt ? "0".repeat(64) : digest.sha256 }));
      } };
    };
    const damaged = await transfer.stage(file(pkg.bytes, "batch.hocpkg"));
    expect(damaged.candidates[0]?.error).toMatch(/摘要不符/);
    expect(await fs.list(`content/v1/imports/${damaged.id}/candidates`)).toEqual([]);
    corrupt = false;
    const valid = await transfer.stage(file(pkg.bytes, "batch.hocpkg"));
    expect(valid.candidates[0]?.packageId).toBe("batch/hero");
    expect(batches).toBe(2);
  });
  it("removes a cancelled staging session and permits the next import", async () => {
    const { host, transfer } = setup();
    const content = await makePackage("cancel", "1.0.0");
    const abort = new AbortController();
    const write = host.fileSystem.write.bind(host.fileSystem);
    const spy = vi.spyOn(host.fileSystem, "write").mockImplementation(async (path, bytes) => {
      await write(path, bytes);
      if (path.endsWith("/resources/content.json")) abort.abort();
    });
    await expect(transfer.stage(file(content.bytes, "cancel.hocpkg"), { signal: abort.signal })).rejects.toThrow();
    expect(await transfer.listSessions()).toEqual([]);
    expect(await host.fileSystem.list("content/v1/imports")).toEqual([]);
    spy.mockRestore();
    expect((await transfer.stage(file(content.bytes, "retry.hocpkg"))).candidates[0]?.error).toBeUndefined();
  });

  it("resolves preview media through the host without reading cover bytes", async () => {
    const { host, transfer } = setup();
    const content = await makePackage("preview", "1.0.0");
    const cover = readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url));
    const manifest = { ...content.manifest, metadata: { ...content.manifest.metadata, coverImage: "cover.png" }, files: [...content.manifest.files, { path: "cover.png", bytes: cover.length, sha256: await sha256(cover), mediaType: "image/png" }] };
    const session = await transfer.stage(file(zipSync({ ...unzipSync(content.bytes), "hocpkg-info.json": encodeText(JSON.stringify(manifest)), "cover.png": cover }), "preview.hocpkg"));
    const read = vi.spyOn(host.fileSystem, "read");
    const release = vi.fn();
    const resolve = vi.fn(async () => ({ url: "host-media://cover", release }));
    const preview = await transfer.preview(session.id, "0000", { resolve });
    expect(preview.asset?.url).toBe("host-media://cover");
    expect(preview.cover).toBeUndefined();
    expect(read.mock.calls.some(([path]) => path.endsWith("cover.png"))).toBe(false);
    expect(resolve).toHaveBeenCalledWith(expect.stringContaining("/cover.png"), "image/png");
    preview.asset?.release?.();
    expect(release).toHaveBeenCalledOnce();
  });
  it("reads only preview metadata without reading unrelated payloads", async () => {
    const { host, transfer } = setup();
    const content = await makePackage("preview", "1.0.0");
    const session = await transfer.stage(file(content.bytes, "preview.hocpkg"));
    const read = vi.spyOn(host.fileSystem, "read");
    await transfer.preview(session.id, "0000");
    expect(read.mock.calls.some(([path]) => path.endsWith("resources/content.json"))).toBe(false);
  });

  it.each([undefined, "", "   ", "CC0", "CC-BY-NC-SA 4.0"])("preserves license %j through install and export, including legacy packages", async (license) => {
    const { transfer } = setup();
    const content = await makePackage("a", "1.0.0", "test", license);
    const session = await transfer.stage(file(content.bytes, "license.hocpkg"));
    expect(session.candidates[0]?.error).toBeUndefined();
    await transfer.installSelected(session.id, ["0000"]);
    const exported = unzipSync(await transfer.exportPackage("a/hero"));
    expect(JSON.parse(new TextDecoder().decode(exported["hocpkg-info.json"])).metadata).toEqual(content.manifest.metadata);
  });

  it("stages nested playlists beside packages and restores them after restart", async () => {
    const { host, repository, transfer } = setup();
    const content = await makePackage("a", "1.0.0");
    const document = playlistDocument("作者推荐", [{ packageId: "a/hero", version: "1.0.0" }]);
    const playlist = await encodePlaylistHocpkg(document, crypto.randomUUID());
    const cover = new Uint8Array(readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url)));
    const bundle = zipSync({ "resource.hocpkg": content.bytes, "nested/playlists.zip": zipSync({ "recommend.png": embedHocpkgInPng(cover, playlist) }) });
    const session = await transfer.stage(file(bundle, "bundle.zip"));
    expect(session.candidates.map((candidate) => candidate.kind)).toEqual(["package", "playlist"]);
    const restored = new HocpkgTransfer(host.fileSystem, repository);
    expect((await restored.listSessions())[0]?.candidates).toEqual(session.candidates);
    expect(await restored.readPlaylist(session.id, "0001")).toEqual(document);
    await restored.installSelected(session.id, ["0000"]);
    expect((await restored.listSessions())[0]?.candidates.map((candidate) => candidate.kind)).toEqual(["playlist"]);
    await restored.consumeCandidates(session.id, ["0001"]);
    expect(await restored.listSessions()).toEqual([]);
  });

  it("isolates invalid playlists and rechecks staged bytes", async () => {
    const { host, repository, transfer } = setup();
    const content = await makePackage("a", "1.0.0");
    const playlist = await encodePlaylistHocpkg(playlistDocument("有效", []), crypto.randomUUID());
    const invalid = unzipSync(playlist);
    invalid["playlist.json"] = Uint8Array.from(encodeText('{"name":"tampered"}'));
    const session = await transfer.stage(file(zipSync({ "good.hocpkg": content.bytes, "valid.hocpkg": playlist, "invalid.hocpkg": zipSync(invalid) }), "mixed.zip"));
    expect(session.candidates.map((candidate) => [candidate.kind, Boolean(candidate.error)])).toEqual([["package", false], ["playlist", false], ["playlist", true]]);
    await host.fileSystem.write(`content/v1/imports/${session.id}/candidates/0001/files/playlist.json`, encodeText("{}"));
    await expect(transfer.readPlaylist(session.id, "0001")).rejects.toThrow(/摘要|大小/);
    expect(await repository.listPackages()).toEqual([]);
  });

  it("discards damaged candidates without removing valid staged packages or playlists", async () => {
    const { repository, transfer } = setup();
    const content = await makePackage("a", "1.0.0");
    const playlist = await encodePlaylistHocpkg(playlistDocument("推荐", []), crypto.randomUUID());
    const session = await transfer.stage(file(zipSync({
      "good.hocpkg": content.bytes, "broken.hocpkg": encodeText("damaged"), "playlist.hocpkg": playlist
    }), "bundle.zip"));
    expect(session.candidates.map((candidate) => Boolean(candidate.error))).toEqual([false, true, false]);
    await expect(transfer.consumeCandidates(session.id, ["0000"], "invalid")).rejects.toThrow(/候选无效/);
    await transfer.installSelected(session.id, ["0000"]);
    await transfer.consumeCandidates(session.id, ["0001"], "invalid");
    expect((await transfer.listSessions())[0]?.candidates.map((candidate) => candidate.id)).toEqual(["0002"]);
    expect(await transfer.readPlaylist(session.id, "0002")).toMatchObject({ name: "推荐" });
    expect((await repository.listPackages()).map((entry) => entry.packageId)).toEqual(["a/hero"]);
  });

  it("retains a playlist when the resource batch cannot be installed", async () => {
    const { host, repository, transfer } = setup();
    const content = await makePackage("a", "1.0.0");
    const playlist = await encodePlaylistHocpkg(playlistDocument("推荐", [{ packageId: "a/hero" }]), crypto.randomUUID());
    const session = await transfer.stage(file(zipSync({ "resource.hocpkg": content.bytes, "playlist.hocpkg": playlist }), "bundle.zip"));
    await host.fileSystem.remove(`content/v1/imports/${session.id}/candidates/0000/files/resources/content.json`);
    await expect(transfer.installSelected(session.id, ["0000"])).rejects.toThrow(/内容来源不可读取/);
    expect((await transfer.listSessions())[0]?.candidates.map((candidate) => candidate.kind)).toEqual(["package", "playlist"]);
    expect(await transfer.readPlaylist(session.id, "0001")).toMatchObject({ name: "推荐" });
    expect(await repository.listPackages()).toEqual([]);
  });
  it("stages ZIP, PNG, and a nested bundle, and restores candidates after restart", async () => {
    const { host, repository, transfer } = setup();
    const a = await makePackage("a", "1.0.0");
    const b = await makePackage("b", "1.1.0");
    const cover = new Uint8Array(readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url)));
    const png = embedHocpkgInPng(cover, a.bytes);
    expect(extractHocpkgFromPng(png)).toEqual(a.bytes);
    const single = await transfer.stage(file(a.bytes, "a.hocpkg"));
    const image = await transfer.stage(file(png, "a.png"));
    const bundle = await transfer.stage(file(zipSync({ "folder/a.hocpkg": a.bytes, "folder/b.zip": b.bytes }), "bundle.zip"));
    expect(single.candidates.map((entry) => entry.packageId)).toEqual(["a/hero"]);
    expect(image.candidates.map((entry) => entry.packageId)).toEqual(["a/hero"]);
    expect(bundle.candidates.map((entry) => entry.packageId)).toEqual(["a/hero", "b/hero"]);
    expect((await new HocpkgTransfer(host.fileSystem, repository).listSessions()).length).toBe(3);
  });

  it("finds carriers under Unicode folders while ignoring macOS metadata and unrelated files", async () => {
    const { transfer } = setup();
    const content = await makePackage("a", "1.0.0");
    const playlist = await encodePlaylistHocpkg(playlistDocument("推荐", []), crypto.randomUUID());
    const cover = new Uint8Array(readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url)));
    const bundle = clearZipUtf8Flags(zipSync({
      "__MACOSX/中文目录/._hero.hocpkg": encodeText("AppleDouble metadata"),
      "中文目录/.DS_Store": encodeText("metadata"),
      "中文目录/hero.hocpkg": content.bytes,
      "中文目录/notes.txt": encodeText("unrelated"),
      "中文目录/cover.png": cover,
      "中文目录/nested.zip": zipSync({ "more/playlist.hocpkg": playlist, "../ignored.txt": encodeText("unrelated") }),
      "中文目录/broken.hocpkg": encodeText("damaged"),
      "中文目录/old.hocpkg": zipSync({ "character-card.json": encodeText("{}") })
    }));
    const session = await transfer.stage(file(bundle, "bundle.zip"));
    expect(session.candidates.map((candidate) => [candidate.kind, Boolean(candidate.error)])).toEqual([
      ["package", false], ["playlist", false], [undefined, true], [undefined, true]
    ]);
    expect(session.candidates.map((candidate) => candidate.source)).toEqual([
      "bundle.zip/中文目录/hero.hocpkg", "bundle.zip/中文目录/nested.zip/more/playlist.hocpkg",
      "bundle.zip/中文目录/broken.hocpkg", "bundle.zip/中文目录/old.hocpkg"
    ]);
    expect(session.candidates[3]?.error).toMatch(/缺少根目录 hocpkg-info.json/);
  });

  it("reports no carriers and rejects unsafe or over-limit carrier entries", async () => {
    const { transfer } = setup();
    const cover = new Uint8Array(readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url)));
    const empty = await transfer.stage(file(zipSync({ "__MACOSX/._noise.hocpkg": encodeText("x"), "images/cover.png": cover }), "empty.zip"));
    expect(empty.candidates.map((candidate) => candidate.error)).toEqual(["压缩包中没有可导入的 hocpkg。"]);
    const unsafe = await transfer.stage(file(zipSync({ "../escape.hocpkg": encodeText("x"), "bomb.hocpkg": new Uint8Array(1024 * 1024) }), "unsafe.zip"));
    expect(unsafe.candidates.map((candidate) => candidate.error)).toEqual([
      expect.stringMatching(/不安全/), expect.stringMatching(/超过限额/)
    ]);
  });

  it("keeps authors separate, replaces versions, allows selected downgrade, and preserves enable state", async () => {
    const { host, repository, transfer } = setup();
    const first = await transfer.stage(file((await makePackage("a", "1.0.0")).bytes, "first.hocpkg"));
    await transfer.installSelected(first.id, ["0000"]);
    expect((await repository.listPackages())[0]?.enabled).toBe(false);
    await repository.enablePackage("a/hero");
    const bundle = await transfer.stage(file(zipSync({
      "a-old.hocpkg": (await makePackage("a", "1.0.0")).bytes,
      "a-new.hocpkg": (await makePackage("a", "1.1.0")).bytes,
      "b-new.hocpkg": (await makePackage("b", "1.1.0")).bytes
    }), "bundle.zip"));
    const chosen = bundle.candidates.filter((entry) => entry.version === "1.1.0").map((entry) => entry.id);
    expect((await transfer.installSelected(bundle.id, chosen)).map((entry) => entry.kind)).toEqual(["replaced", "installed"]);
    expect((await repository.listPackages()).map((entry) => [entry.packageId, entry.enabled])).toEqual([["a/hero", true], ["b/hero", false]]);
    const old = bundle.candidates.find((entry) => entry.version === "1.0.0")!;
    expect((await transfer.installSelected(bundle.id, [old.id]))[0]?.kind).toBe("replaced");
    expect((await repository.readManifest("a/hero")).identity.version).toBe("1.0.0");
    expect((await host.fileSystem.list("content/v1/revisions/a/hero")).every((path) => !path.includes(".pending"))).toBe(true);
  });

  it("reports real bytes and retries a failed selected install without duplicating it", async () => {
    const { host, repository, transfer } = setup();
    const payload = await makePackage("a", "1.0.0");
    const session = await transfer.stage(file(payload.bytes, "a.hocpkg"));
    host.fileSystem.failNext("write", /revisions\/a\/hero/, 1);
    await expect(transfer.installSelected(session.id, ["0000"])).rejects.toThrow();
    expect((await transfer.listSessions()).some((item) => item.id === session.id)).toBe(true);
    const progress: { completedBytes: number; totalBytes: number }[] = [];
    expect((await transfer.installSelected(session.id, ["0000"], (item) => progress.push(item)))[0]?.kind).toBe("installed");
    expect(progress.at(-1)).toMatchObject({ completedBytes: payload.manifest.files[0]!.bytes, totalBytes: payload.manifest.files[0]!.bytes });
    expect((await repository.listPackages()).map((item) => item.packageId)).toEqual(["a/hero"]);
  });

  it("rejects selecting two versions of one package in a single batch", async () => {
    const { transfer } = setup();
    const session = await transfer.stage(file(zipSync({
      "first.hocpkg": (await makePackage("a", "1.0.0")).bytes,
      "second.hocpkg": (await makePackage("a", "2.0.0")).bytes
    }), "bundle.zip"));
    await expect(transfer.installSelected(session.id, session.candidates.map((item) => item.id))).rejects.toThrow(/一次只能选择/);
  });

  it("round trips an installed hocpkg and isolates a corrupt candidate", async () => {
    const { repository, transfer } = setup();
    const good = await makePackage("a", "1.0.0");
    const session = await transfer.stage(file(zipSync({ "good.hocpkg": good.bytes, "bad.hocpkg": encodeText("not zip") }), "mixed.zip"));
    expect(session.candidates).toHaveLength(2);
    expect(session.candidates.find((entry) => entry.error)?.source).toContain("bad.hocpkg");
    await transfer.installSelected(session.id, [session.candidates.find((entry) => !entry.error)!.id]);
    const exported = await transfer.exportPackage("a/hero");
    const imported = await transfer.stage(file(exported, "export.hocpkg"));
    expect(imported.candidates[0]?.packageId).toBe("a/hero");
    expect((await transfer.installSelected(imported.id, ["0000"]))[0]?.kind).toBe("same");
    expect((await repository.listPackages())).toHaveLength(1);
  });

  it("prefers newly selected same-version content and keeps the installed revision when a batch fails", async () => {
    const { host, repository, transfer } = setup();
    const first = await transfer.stage(file((await makePackage("a", "1.0.0", "old")).bytes, "old.hocpkg"));
    await transfer.installSelected(first.id, ["0000"]);
    const original = (await repository.listPackages())[0]!.currentRevision;
    const replacement = await transfer.stage(file((await makePackage("a", "1.0.0", "new")).bytes, "new.hocpkg"));
    expect((await transfer.installSelected(replacement.id, ["0000"]))[0]?.kind).toBe("replaced");
    expect((await repository.listPackages())[0]!.currentRevision).not.toBe(original);
    const beforeFailure = (await repository.listPackages())[0]!.currentRevision;
    const mixed = await transfer.stage(file(zipSync({
      "a.hocpkg": (await makePackage("a", "1.1.0")).bytes,
      "b.hocpkg": (await makePackage("b", "1.1.0")).bytes
    }), "mixed.zip"));
    const secondRoot = `content/v1/imports/${mixed.id}/candidates/0001/files`;
    await host.fileSystem.remove(`${secondRoot}/resources/content.json`);
    await expect(transfer.installSelected(mixed.id, ["0000", "0001"])).rejects.toThrow(/内容来源不可读取/);
    expect((await repository.listPackages())[0]!.currentRevision).toBe(beforeFailure);
    expect((await transfer.listSessions()).some((session) => session.id === mixed.id)).toBe(true);
  });

  it("rejects undeclared files and unsafe paths before any catalog mutation", async () => {
    const { repository, transfer } = setup();
    const good = await makePackage("a", "1.0.0");
    const extra = zipSync({ "hocpkg-info.json": encodeText(JSON.stringify(good.manifest)), "resources/content.json": encodeText('{"body":"1.0.0"}'), "unexpected.txt": encodeText("bad") });
    const session = await transfer.stage(file(extra, "bad.hocpkg"));
    expect(session.candidates[0]?.error).toMatch(/未声明文件/);
    const unsafe = await transfer.stage(file(zipSync({ "../escape.hocpkg": good.bytes }), "unsafe.zip"));
    expect(unsafe.candidates[0]?.error).toMatch(/不安全/);
    expect(await repository.listPackages()).toEqual([]);
  });

  it("exports an installed character as a viewable PNG that can be staged again", async () => {
    const { repository, transfer } = setup();
    const cover = new Uint8Array(readFileSync(new URL("../../../public/assets/package-cover-fallback.png", import.meta.url)));
    const body = encodeText(JSON.stringify({ definition: { assets: { cover: "cover.png" } } }));
    const manifest: HocpkgManifest = {
      format: "house-of-chances-hocpkg", formatVersion: 1,
      identity: { authorId: "a", packageName: "character", version: "1.0.0" },
      metadata: { title: "Character", description: "test", tags: [], creators: [{ displayName: "A", roles: ["design"] }] },
      resources: [{ id: "match", type: "game.character-match", apiVersion: 3, entry: "resources/match.json", requires: [] }],
      files: [
        { path: "resources/match.json", bytes: body.length, sha256: await sha256(body), mediaType: "application/json" },
        { path: "cover.png", bytes: cover.length, sha256: await sha256(cover), mediaType: "image/png" }
      ], extensions: {}
    };
    await repository.install({ manifest, async *files() { yield { path: "resources/match.json", bytes: body }; yield { path: "cover.png", bytes: cover }; } });
    const png = await transfer.exportPackagePng("a/character");
    expect(png.subarray(0, 8)).toEqual(cover.subarray(0, 8));
    expect((await transfer.stage(file(png, "character.png"))).candidates[0]?.packageId).toBe("a/character");
  });
});
