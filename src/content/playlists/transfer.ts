import { HocpkgManifestSchema } from "../packages/schema";
import { decodeText, encodeText, sha256 } from "../storage/encoding";
import { embedHocpkgInPng, extractHocpkgFromPng, unzipChecked, zipFiles } from "../transfer/hocpkg";
import type { Unzipped } from "fflate";
import { PlaylistDocumentSchema, type PlaylistDocument } from "./store";
import { migratePlaylistDocument } from "./migrations";
import type { ContentFileSystem, ContentOperationOptions } from "../storage/contracts";
import { readImportRange, type ImportFile } from "../storage/import-file";
import { checkCancelled } from "../storage/file-operations";
import { playlistCoverBytes, playlistCoverDataUrl } from "./cover";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
export const MAX_PLAYLIST_FILE = 2 * 1024 * 1024;

export class PlaylistArchiveError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PlaylistArchiveError";
  }
}

export function playlistJson(document: PlaylistDocument): string {
  return `${JSON.stringify(PlaylistDocumentSchema.parse(document), null, 2)}\n`;
}

export async function encodePlaylistHocpkg(document: PlaylistDocument, id: string): Promise<Uint8Array> {
  const parsed = PlaylistDocumentSchema.parse(document);
  const { coverImage, ...documentBody } = parsed;
  const body = encodeText(playlistJson(documentBody));
  const cover = coverImage ? playlistCoverBytes(coverImage) : undefined;
  const manifest = HocpkgManifestSchema.parse({
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "playlist", packageName: `playlist-${id}`, version: "1.0.0" },
    metadata: { title: parsed.name, license: "", description: "播放集清单", tags: [], creators: [{ displayName: "本地播放集", roles: ["design"] }], ...(cover ? { coverImage: "cover.png" } : {}) },
    resources: [{ id: "playlist", type: "hoc.playlist", apiVersion: 1, entry: "playlist.json", requires: [] }],
    files: [{ path: "playlist.json", bytes: body.byteLength, sha256: await sha256(body), mediaType: "application/json" },
      ...(cover ? [{ path: "cover.png", bytes: cover.byteLength, sha256: await sha256(cover), mediaType: "image/png" }] : [])],
    extensions: {}
  });
  const files = { "hocpkg-info.json": encodeText(JSON.stringify(manifest)), "playlist.json": body, ...(cover ? { "cover.png": cover } : {}) };
  if (Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0) > MAX_PLAYLIST_FILE) throw new Error("播放集解压后超过 2 MiB 限额。");
  return zipFiles(files);
}

export async function encodePlaylistPng(document: PlaylistDocument, id: string, cover: Uint8Array): Promise<Uint8Array> {
  const result = embedHocpkgInPng(document.coverImage ? playlistCoverBytes(document.coverImage) : cover, await encodePlaylistHocpkg(document, id));
  if (result.byteLength > MAX_PLAYLIST_FILE) throw new Error("播放集文件超过 2 MiB 限额。");
  return result;
}

export async function decodePlaylistBytes(bytes: Uint8Array, fallbackOrder: readonly string[] = []): Promise<PlaylistDocument> {
  if (bytes.byteLength > MAX_PLAYLIST_FILE) throw new Error("播放集文件超过 2 MiB 限额。");
  const payload = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ? extractHocpkgFromPng(bytes) : bytes;
  if (payload[0] !== 0x50 || payload[1] !== 0x4b) {
    return PlaylistDocumentSchema.parse(migratePlaylistDocument(JSON.parse(decodeText(payload)), fallbackOrder));
  }
  const files = await unzipChecked(payload, { maxEntries: 3, maxEntryBytes: MAX_PLAYLIST_FILE, maxArchiveBytes: MAX_PLAYLIST_FILE });
  return decodePlaylistArchiveFiles(files, fallbackOrder);
}

export async function decodePlaylistArchiveFiles(files: Unzipped, fallbackOrder: readonly string[] = []): Promise<PlaylistDocument> {
  if (!files["hocpkg-info.json"] || !files["playlist.json"]) {
    throw new Error("播放集 hocpkg 缺少清单或正文。");
  }
  if (Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0) > MAX_PLAYLIST_FILE) {
    throw new Error("播放集解压后超过 2 MiB 限额。");
  }
  const manifest = HocpkgManifestSchema.parse(JSON.parse(decodeText(files["hocpkg-info.json"])));
  const coverPath = manifest.metadata.coverImage;
  if (manifest.resources.length !== 1 || manifest.resources[0]?.type !== "hoc.playlist" || manifest.resources[0]?.entry !== "playlist.json"
    || manifest.files.length !== (coverPath ? 2 : 1)
    || !manifest.files.some(file => file.path === "playlist.json" && file.mediaType === "application/json")
    || (coverPath && (coverPath === "playlist.json" || !manifest.files.some(file => file.path === coverPath && file.mediaType === "image/png")))) {
    throw new Error("hocpkg 不是播放集包。");
  }
  if (Object.keys(files).length !== manifest.files.length + 1) throw new Error("播放集包含未声明文件。");
  for (const file of manifest.files) {
    const bytes = files[file.path];
    if (!bytes || bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error("播放集文件大小或摘要不符。");
  }
  const document = PlaylistDocumentSchema.parse(migratePlaylistDocument(JSON.parse(decodeText(files["playlist.json"])), fallbackOrder));
  return coverPath ? PlaylistDocumentSchema.parse({ ...document, coverImage: playlistCoverDataUrl(files[coverPath]!) }) : document;
}

export async function decodePlaylistFile(file: ImportFile, fallbackOrder: readonly string[] = [], fs?: ContentFileSystem, options?: ContentOperationOptions): Promise<PlaylistDocument> {
  const header = await readImportRange(fs, file, 0, PNG_SIGNATURE.length, options);
  const archive = (header[0] === 0x50 && header[1] === 0x4b) || PNG_SIGNATURE.every((byte, index) => header[index] === byte);
  if (file.size > MAX_PLAYLIST_FILE) {
    const error = new Error("播放集文件超过 2 MiB 限额。");
    throw archive ? new PlaylistArchiveError(error) : error;
  }
  // I/O failures and cancellation are not evidence that this is a content bundle.
  const body = await readImportRange(fs, file, 0, file.size, options);
  try {
    const document = await decodePlaylistBytes(body, fallbackOrder);
    checkCancelled(options);
    return document;
  } catch (error) {
    checkCancelled(options);
    if (archive) throw new PlaylistArchiveError(error);
    throw error;
  }
}
