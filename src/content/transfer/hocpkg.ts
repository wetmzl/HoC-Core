import { unzip, zip, type Unzipped, type Zippable } from "fflate";
import { HocpkgManifestSchema, getHocpkgPackageId, type HocpkgManifest } from "../packages";
import type { ContentFileSystem, ContentRepository } from "../storage/contracts";
import { decodeText, encodeText, sha256 } from "../storage/encoding";
import { getContentRevision } from "../storage/repository";
import { decodePlaylistArchiveFiles, MAX_PLAYLIST_FILE } from "../playlists/transfer";
import type { PlaylistDocument } from "../playlists/store";

export const IMPORT_ROOT = "content/v1/imports";
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const PACKAGE_CHUNK = "hcPK";
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_DEPTH = 3;

export interface StagedCandidate {
  readonly id: string;
  readonly source: string;
  readonly kind?: "package" | "playlist";
  readonly packageId?: string;
  readonly version?: string;
  readonly digest?: string;
  readonly title?: string;
  readonly error?: string;
}

export interface ImportSession {
  readonly id: string;
  readonly createdAt: string;
  readonly filename: string;
  readonly candidates: readonly StagedCandidate[];
}

export interface ImportOutcome {
  readonly candidateId: string;
  readonly packageId: string;
  readonly kind: "installed" | "replaced" | "same" | "skipped";
  readonly message: string;
}

function safeZipPath(path: string): boolean {
  return path.length <= 240 && !path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
}

function safeBundlePath(path: string): boolean {
  return path.length <= 240 && !path.startsWith("/") && !/[\\:\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function ignoredBundlePath(path: string): boolean {
  return path.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));
}

function nestedCarrier(path: string): boolean { return /\.(?:hocpkg|zip|png)$/i.test(path); }

function displayBundlePath(path: string): string {
  // Some macOS ZIP writers store UTF-8 names without setting the ZIP UTF-8 flag.
  // fflate then reads each byte as Latin-1; recover the name for candidate labels.
  if (![...path].every((character) => character.charCodeAt(0) <= 255)) return path;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(path, (character) => character.charCodeAt(0))); }
  catch { return path; }
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngParts(bytes: Uint8Array): readonly { readonly start: number; readonly end: number; readonly type: string }[] {
  if (!isPng(bytes)) throw new Error("不是 PNG 图片。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: { start: number; end: number; type: string }[] = [];
  let start = 8;
  while (start + 12 <= bytes.length) {
    const length = view.getUint32(start);
    const end = start + 12 + length;
    if (end > bytes.length) throw new Error("PNG 数据不完整。");
    const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
    if (crc32(bytes.subarray(start + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error("PNG 校验失败。");
    parts.push({ start, end, type });
    if (type === "IEND") return parts;
    start = end;
  }
  throw new Error("PNG 缺少 IEND。");
}

export function embedHocpkgInPng(png: Uint8Array, hocpkg: Uint8Array): Uint8Array {
  const parts = pngParts(png).filter((part) => part.type !== PACKAGE_CHUNK);
  const chunk = new Uint8Array(hocpkg.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, hocpkg.length);
  chunk.set(encodeText(PACKAGE_CHUNK), 4);
  chunk.set(hocpkg, 8);
  view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  const output = new Uint8Array(8 + chunk.length + parts.reduce((n, part) => n + part.end - part.start, 0));
  output.set(PNG_SIGNATURE);
  let offset = 8;
  for (const part of parts) {
    if (part.type === "IEND") { output.set(chunk, offset); offset += chunk.length; }
    output.set(png.subarray(part.start, part.end), offset);
    offset += part.end - part.start;
  }
  return output;
}

export function extractHocpkgFromPng(png: Uint8Array): Uint8Array {
  const part = pngParts(png).find((entry) => entry.type === PACKAGE_CHUNK);
  if (!part) throw new Error("PNG 中没有 hocpkg 内容包。");
  return png.slice(part.start + 8, part.end - 4);
}

export function unzipChecked(bytes: Uint8Array, limits: { maxEntries?: number; maxEntryBytes?: number; maxArchiveBytes?: number } = {}): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    let count = 0;
    let total = 0;
    const names = new Set<string>();
    let validationError: Error | undefined;
    unzip(bytes, { filter: (entry) => {
      if (entry.name.endsWith("/")) return false;
      count += 1;
      total += entry.originalSize;
      if (!safeZipPath(entry.name) || names.has(entry.name) || count > (limits.maxEntries ?? MAX_ENTRIES)
        || entry.originalSize > (limits.maxEntryBytes ?? MAX_ENTRY_BYTES) || total > (limits.maxArchiveBytes ?? MAX_ARCHIVE_BYTES)
        || (entry.size > 0 && entry.originalSize / entry.size > 200)) {
        validationError = new Error(`ZIP 条目不安全或超过限额：${entry.name}`);
        return false;
      }
      names.add(entry.name);
      return true;
    } }, (error, files) => {
      if (validationError) reject(validationError);
      else if (error) reject(error);
      else resolve(files);
    });
  });
}

function hasRootManifest(bytes: Uint8Array): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let found = false;
    let count = 0;
    unzip(bytes, { filter: (entry) => {
      if (++count > MAX_ENTRIES) return false;
      if (entry.name === "hocpkg-info.json") found = true;
      return false;
    } }, (error) => error ? reject(error) : count > MAX_ENTRIES
      ? reject(new Error("ZIP 条目数量超过限制。")) : resolve(found));
  });
}

interface BundleScan {
  readonly files: Unzipped;
  readonly invalid: readonly { path: string; error: Error }[];
}

async function scanBundle(bytes: Uint8Array): Promise<BundleScan> {
  const { paths, invalid } = await new Promise<{ paths: string[]; invalid: { path: string; error: Error }[] }>((resolve, reject) => {
    let count = 0;
    let expanded = 0;
    let limitError: Error | undefined;
    const names = new Set<string>();
    const duplicates = new Set<string>();
    const paths: string[] = [];
    const invalid: { path: string; error: Error }[] = [];
    unzip(bytes, { filter: (entry) => {
      if (entry.name.endsWith("/")) return false;
      if (++count > MAX_ENTRIES) { limitError = new Error("ZIP 条目数量超过限制。"); return false; }
      if (ignoredBundlePath(entry.name) || !nestedCarrier(entry.name)) return false;
      if (!safeBundlePath(entry.name) || names.has(entry.name)) {
        invalid.push({ path: entry.name, error: new Error(`ZIP 条目不安全或重复：${entry.name}`) });
        duplicates.add(entry.name);
        return false;
      }
      names.add(entry.name);
      if (entry.originalSize > MAX_ENTRY_BYTES || expanded + entry.originalSize > MAX_ARCHIVE_BYTES
        || (entry.size > 0 && entry.originalSize / entry.size > 200)) {
        invalid.push({ path: entry.name, error: new Error(`ZIP 条目超过限额：${entry.name}`) });
        return false;
      }
      expanded += entry.originalSize;
      paths.push(entry.name);
      return false;
    } }, (error) => {
      if (limitError) { reject(limitError); return; }
      if (error) { reject(error); return; }
      resolve({ paths: paths.filter((path) => !duplicates.has(path)), invalid });
    });
  });
  const files: Unzipped = {};
  for (const path of paths) {
    try {
      const extracted = await new Promise<Unzipped>((resolve, reject) => {
        unzip(bytes, { filter: (entry) => entry.name === path }, (error, result) => error ? reject(error) : resolve(result));
      });
      if (!extracted[path]) throw new Error("ZIP 条目未能解压。");
      files[path] = extracted[path];
    } catch (caught) {
      invalid.push({ path, error: caught instanceof Error ? caught : new Error(String(caught)) });
    }
  }
  return { files, invalid };
}

export function zipFiles(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, { level: 6 }, (error, bytes) => error ? reject(error) : resolve(bytes)));
}

export class HocpkgTransfer {
  constructor(private readonly fs: ContentFileSystem, private readonly repository: ContentRepository) {}

  private sessionPath(id: string): string { return `${IMPORT_ROOT}/${id}/session.json`; }
  private filesRoot(sessionId: string, candidateId: string): string { return `${IMPORT_ROOT}/${sessionId}/candidates/${candidateId}/files`; }

  async listSessions(): Promise<readonly ImportSession[]> {
    const paths = (await this.fs.list(IMPORT_ROOT)).filter((path) => path.endsWith("/session.json"));
    const sessions: ImportSession[] = [];
    for (const path of paths) {
      try {
        const bytes = await this.fs.read(path);
        if (bytes) sessions.push(JSON.parse(decodeText(bytes)) as ImportSession);
      } catch { /* An interrupted session can be cleared on a later import. */ }
    }
    return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async removeSession(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("非法导入会话 ID。");
    await this.fs.remove(`${IMPORT_ROOT}/${id}`);
  }

  async stage(file: File): Promise<ImportSession> {
    if (file.size > MAX_INPUT_BYTES) throw new Error("导入文件超过 256 MiB 限额。");
    const id = crypto.randomUUID();
    const candidates: StagedCandidate[] = [];
    const session = (): ImportSession => ({ id, createdAt, filename: file.name, candidates: [...candidates] });
    const createdAt = new Date().toISOString();
    let expandedBytes = 0;
    let expandedEntries = 0;
    const persist = () => this.fs.write(this.sessionPath(id), encodeText(JSON.stringify(session())));
    await persist();
    const addCandidate = async (source: string, files?: Unzipped, error?: unknown, inputBytes?: number) => {
      const candidateId = String(candidates.length).padStart(4, "0");
      let candidate: StagedCandidate = { id: candidateId, source };
      try {
        if (error) throw error;
        if (!files) throw new Error("压缩包没有文件。");
        const manifestBytes = files["hocpkg-info.json"];
        if (!manifestBytes) throw new Error("缺少根目录 hocpkg-info.json。");
        const manifest = HocpkgManifestSchema.parse(JSON.parse(decodeText(manifestBytes)));
        if (manifest.resources.some((resource) => resource.type === "hoc.playlist")) {
          candidate = { ...candidate, kind: "playlist" };
          if (inputBytes !== undefined && inputBytes > MAX_PLAYLIST_FILE) throw new Error("播放集文件超过 2 MiB 限额。");
          const document = await decodePlaylistArchiveFiles(files, await this.repository.listPluginOrder());
          const root = this.filesRoot(id, candidateId);
          await this.fs.write(`${root}/hocpkg-info.json`, manifestBytes);
          await this.fs.write(`${root}/playlist.json`, files["playlist.json"]!);
          candidate = { ...candidate, title: document.name };
          candidates.push(candidate);
          await persist();
          return;
        }
        const declared = new Set(manifest.files.map((entry) => entry.path));
        for (const path of Object.keys(files)) if (path !== "hocpkg-info.json" && !declared.has(path)) throw new Error(`未声明文件：${path}`);
        for (const entry of manifest.files) {
          const bytes = files[entry.path];
          if (!bytes || bytes.byteLength !== entry.bytes || await sha256(bytes) !== entry.sha256) throw new Error(`文件缺失或摘要不符：${entry.path}`);
        }
        const root = this.filesRoot(id, candidateId);
        await this.fs.write(`${root}/hocpkg-info.json`, manifestBytes);
        for (const entry of manifest.files) await this.fs.write(`${root}/${entry.path}`, files[entry.path]!);
        candidate = { ...candidate, kind: "package", packageId: getHocpkgPackageId(manifest.identity), version: manifest.identity.version,
          digest: await getContentRevision(manifest), title: manifest.metadata.title };
      } catch (caught) {
        await this.fs.remove(`${IMPORT_ROOT}/${id}/candidates/${candidateId}`).catch(() => undefined);
        candidate = { ...candidate, error: caught instanceof Error ? caught.message : String(caught) };
      }
      candidates.push(candidate);
      await persist();
    };
    const visit = async (bytes: Uint8Array, source: string, depth: number, carrier: "root" | "hocpkg" | "zip" | "png" = "root"): Promise<void> => {
      if (depth > MAX_DEPTH) { await addCandidate(source, undefined, new Error("压缩包嵌套层数超过限制。")); return; }
      try {
        let payload = bytes;
        if (isPng(bytes)) {
          try { payload = extractHocpkgFromPng(bytes); }
          catch (error) {
            if (carrier === "png" && error instanceof Error && error.message === "PNG 中没有 hocpkg 内容包。") return;
            throw error;
          }
        }
        if (!isZip(payload)) throw new Error("文件不是 hocpkg、ZIP 或内嵌 hocpkg 的 PNG。");
        if (await hasRootManifest(payload)) {
          const files = await unzipChecked(payload);
          expandedEntries += Object.keys(files).length;
          expandedBytes += Object.values(files).reduce((total, entry) => total + entry.byteLength, 0);
          if (expandedEntries > MAX_ENTRIES || expandedBytes > MAX_ARCHIVE_BYTES) throw new Error("本次导入的解压总量超过限制。");
          await addCandidate(source, files, undefined, bytes.byteLength);
          return;
        }
        if (carrier === "hocpkg") throw new Error("缺少根目录 hocpkg-info.json。");
        const bundle = await scanBundle(payload);
        expandedEntries += Object.keys(bundle.files).length;
        expandedBytes += Object.values(bundle.files).reduce((total, entry) => total + entry.byteLength, 0);
        if (expandedEntries > MAX_ENTRIES || expandedBytes > MAX_ARCHIVE_BYTES) throw new Error("本次导入的解压总量超过限制。");
        for (const entry of bundle.invalid) await addCandidate(`${source}/${displayBundlePath(entry.path)}`, undefined, entry.error);
        for (const [path, nested] of Object.entries(bundle.files)) {
          const kind = path.toLowerCase().endsWith(".hocpkg") ? "hocpkg" : path.toLowerCase().endsWith(".png") ? "png" : "zip";
          await visit(nested, `${source}/${displayBundlePath(path)}`, depth + 1, kind);
        }
        if (carrier === "root" && candidates.length === 0) throw new Error("压缩包中没有可导入的 hocpkg。");
      } catch (error) { await addCandidate(source, undefined, error); }
    };
    await visit(new Uint8Array(await file.arrayBuffer()), file.name, 0);
    return session();
  }

  async source(sessionId: string, candidateId: string): Promise<{ manifest: HocpkgManifest; files(): AsyncIterable<{ path: string; bytes: Uint8Array }> }> {
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);
    const candidate = session?.candidates.find((entry) => entry.id === candidateId && !entry.error);
    if (!candidate) throw new Error("暂存候选不存在。");
    const root = this.filesRoot(sessionId, candidateId);
    const manifestBytes = await this.fs.read(`${root}/hocpkg-info.json`);
    if (!manifestBytes) throw new Error("暂存 Manifest 已丢失。");
    const manifest = HocpkgManifestSchema.parse(JSON.parse(decodeText(manifestBytes)));
    const fs = this.fs;
    return { manifest, async *files() {
      for (const entry of manifest.files) {
        const bytes = await fs.read(`${root}/${entry.path}`);
        if (!bytes) throw new Error(`暂存文件已丢失：${entry.path}`);
        yield { path: entry.path, bytes };
      }
    } };
  }

  async readPlaylist(sessionId: string, candidateId: string): Promise<PlaylistDocument> {
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);
    const candidate = session?.candidates.find((entry) => entry.id === candidateId && entry.kind === "playlist" && !entry.error);
    if (!candidate) throw new Error("播放集暂存候选不存在。");
    const root = this.filesRoot(sessionId, candidateId);
    const paths = await this.fs.list(root);
    if (paths.length !== 2 || !paths.includes(`${root}/hocpkg-info.json`) || !paths.includes(`${root}/playlist.json`)) {
      throw new Error("播放集暂存文件不完整。");
    }
    const manifest = await this.fs.read(`${root}/hocpkg-info.json`);
    const body = await this.fs.read(`${root}/playlist.json`);
    if (!manifest || !body) throw new Error("播放集暂存文件已丢失。");
    return decodePlaylistArchiveFiles({ "hocpkg-info.json": Uint8Array.from(manifest), "playlist.json": Uint8Array.from(body) }, await this.repository.listPluginOrder());
  }

  async consumeCandidates(sessionId: string, candidateIds: readonly string[], type: "playlist" | "invalid" = "playlist"): Promise<void> {
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);
    if (!session) throw new Error("导入会话不存在。");
    if (new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => !session.candidates.some((entry) => entry.id === id && (type === "invalid" ? Boolean(entry.error) : entry.kind === "playlist" && !entry.error)))) {
      throw new Error("待清理的暂存候选无效。");
    }
    const retained = session.candidates.filter((entry) => !candidateIds.includes(entry.id));
    if (retained.length) await this.fs.write(this.sessionPath(sessionId), encodeText(JSON.stringify({ ...session, candidates: retained })));
    else await this.removeSession(sessionId);
    for (const id of candidateIds) await this.fs.remove(`${IMPORT_ROOT}/${sessionId}/candidates/${id}`).catch(() => undefined);
  }

  async exportPackage(packageId: string): Promise<Uint8Array> {
    await this.repository.verifyPackage(packageId);
    const manifest = await this.repository.readManifest(packageId);
    const files: Zippable = { "hocpkg-info.json": encodeText(JSON.stringify(manifest)) };
    for (const entry of manifest.files) files[entry.path] = await this.repository.readFile(packageId, entry.path);
    return zipFiles(files);
  }

  async exportPackagePng(packageId: string): Promise<Uint8Array> {
    const manifest = await this.repository.readManifest(packageId);
    const descriptor = manifest.resources.find((entry) => entry.type === "game.character-match");
    if (!descriptor) throw new Error("这个内容包没有角色封面。");
    const body = JSON.parse(decodeText(await this.repository.readFile(packageId, descriptor.entry))) as { definition?: { assets?: { cover?: string } } };
    const coverPath = body.definition?.assets?.cover;
    if (!coverPath || !manifest.files.some((entry) => entry.path === coverPath && entry.mediaType === "image/png")) throw new Error("角色包没有 PNG 封面。");
    const cover = await this.repository.readFile(packageId, coverPath);
    return embedHocpkgInPng(cover, await this.exportPackage(packageId));
  }


  async preview(sessionId: string, candidateId: string): Promise<{ manifest: HocpkgManifest; cover?: Uint8Array; mediaType?: string }> {
    const source = await this.source(sessionId, candidateId);
    const files = new Map<string, Uint8Array>();
    for await (const file of source.files()) files.set(file.path, file.bytes);
    let coverPath = source.manifest.metadata.coverImage;
    if (!coverPath) {
      const descriptor = source.manifest.resources.find((entry) => entry.type === "game.character-match");
      if (descriptor) {
        try { coverPath = (JSON.parse(decodeText(files.get(descriptor.entry)!)) as { definition?: { assets?: { cover?: string } } }).definition?.assets?.cover; } catch { /* Optional preview. */ }
      }
    }
    const file = source.manifest.files.find((entry) => entry.path === coverPath && entry.mediaType.startsWith("image/"));
    return { manifest: source.manifest, cover: file ? files.get(file.path) : undefined, mediaType: file?.mediaType };
  }

  async installSelected(sessionId: string, candidateIds: readonly string[], onProgress?: (progress: import("../storage/contracts").ContentInstallProgress) => void): Promise<readonly ImportOutcome[]> {
    if (candidateIds.length === 0 || new Set(candidateIds).size !== candidateIds.length) throw new Error("请选择有效且不重复的候选包。");
    const session = (await this.listSessions()).find((entry) => entry.id === sessionId);
    if (!session) throw new Error("导入会话不存在。");
    const installed = new Map((await this.repository.listPackages()).map((entry) => [entry.packageId, entry]));
    const seen = new Set<string>();
    const sources: Awaited<ReturnType<HocpkgTransfer["source"]>>[] = [];
    const outcomes: ImportOutcome[] = [];
    for (const id of candidateIds) {
      const candidate = session.candidates.find((entry) => entry.id === id && entry.packageId && !entry.error);
      if (!candidate?.packageId) throw new Error(`暂存候选无效：${id}`);
      if (seen.has(candidate.packageId)) throw new Error(`一次只能选择同一内容包的一个版本：${candidate.packageId}`);
      seen.add(candidate.packageId);
      const source = await this.source(sessionId, id);
      const previous = installed.get(candidate.packageId);
      if (previous) {
        const current = await this.repository.readManifest(candidate.packageId);
        if (previous.currentRevision === await getContentRevision(source.manifest)) {
          outcomes.push({ candidateId: id, packageId: candidate.packageId, kind: "same", message: `${candidate.packageId}：内容相同，未重复安装。` });
          continue;
        }
        outcomes.push({ candidateId: id, packageId: candidate.packageId, kind: "replaced", message: `${candidate.packageId}：v${source.manifest.identity.version} 已替换 v${current.identity.version}。` });
      } else {
        outcomes.push({ candidateId: id, packageId: candidate.packageId, kind: "installed", message: `${candidate.packageId}：v${source.manifest.identity.version} 已入库，暂未启用。` });
      }
      sources.push(source);
    }
    if (sources.length) await this.repository.installBatch(sources, { allowDowngrade: true, allowSameVersionReplacement: true, newPackagesEnabled: false, onProgress });
    const retained = session.candidates.filter((candidate) => !candidateIds.includes(candidate.id));
    for (const id of candidateIds) await this.fs.remove(`${IMPORT_ROOT}/${sessionId}/candidates/${id}`).catch(() => undefined);
    if (retained.length) await this.fs.write(this.sessionPath(sessionId), encodeText(JSON.stringify({ ...session, candidates: retained })));
    else await this.removeSession(sessionId);
    return outcomes;
  }
}
