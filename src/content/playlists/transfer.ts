import { HocpkgManifestSchema } from "../packages/schema";
import { decodeText, encodeText, sha256 } from "../storage/encoding";
import { embedHocpkgInPng, extractHocpkgFromPng, unzipChecked, zipFiles } from "../transfer/hocpkg";
import type { Unzipped } from "fflate";
import { PlaylistDocumentSchema, type PlaylistDocument } from "./store";
import { migratePlaylistDocument } from "./migrations";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
export const MAX_PLAYLIST_FILE = 2 * 1024 * 1024;

export function playlistJson(document: PlaylistDocument): string {
  return `${JSON.stringify(PlaylistDocumentSchema.parse(document), null, 2)}\n`;
}

export async function encodePlaylistHocpkg(document: PlaylistDocument, id: string): Promise<Uint8Array> {
  const parsed = PlaylistDocumentSchema.parse(document);
  const body = encodeText(playlistJson(parsed));
  const manifest = HocpkgManifestSchema.parse({
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "playlist", packageName: `playlist-${id}`, version: "1.0.0" },
    metadata: { title: parsed.name, license: "", description: "播放集清单", tags: [], creators: [{ displayName: "本地播放集", roles: ["design"] }] },
    resources: [{ id: "playlist", type: "hoc.playlist", apiVersion: 1, entry: "playlist.json", requires: [] }],
    files: [{ path: "playlist.json", bytes: body.byteLength, sha256: await sha256(body), mediaType: "application/json" }],
    extensions: {}
  });
  return zipFiles({ "hocpkg-info.json": encodeText(JSON.stringify(manifest)), "playlist.json": body });
}

export async function encodePlaylistPng(document: PlaylistDocument, id: string, cover: Uint8Array): Promise<Uint8Array> {
  return embedHocpkgInPng(cover, await encodePlaylistHocpkg(document, id));
}

export async function decodePlaylistBytes(bytes: Uint8Array, fallbackOrder: readonly string[] = []): Promise<PlaylistDocument> {
  if (bytes.byteLength > MAX_PLAYLIST_FILE) throw new Error("播放集文件超过 2 MiB 限额。");
  const payload = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ? extractHocpkgFromPng(bytes) : bytes;
  if (payload[0] !== 0x50 || payload[1] !== 0x4b) {
    return PlaylistDocumentSchema.parse(migratePlaylistDocument(JSON.parse(decodeText(payload)), fallbackOrder));
  }
  const files = await unzipChecked(payload, { maxEntries: 2, maxEntryBytes: MAX_PLAYLIST_FILE, maxArchiveBytes: MAX_PLAYLIST_FILE });
  return decodePlaylistArchiveFiles(files, fallbackOrder);
}

export async function decodePlaylistArchiveFiles(files: Unzipped, fallbackOrder: readonly string[] = []): Promise<PlaylistDocument> {
  if (Object.keys(files).length !== 2 || !files["hocpkg-info.json"] || !files["playlist.json"]) {
    throw new Error("播放集 hocpkg 必须只包含 hocpkg-info.json 和 playlist.json。");
  }
  if (Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0) > MAX_PLAYLIST_FILE) {
    throw new Error("播放集解压后超过 2 MiB 限额。");
  }
  const manifest = HocpkgManifestSchema.parse(JSON.parse(decodeText(files["hocpkg-info.json"])));
  if (manifest.resources.length !== 1 || manifest.resources[0]?.type !== "hoc.playlist" || manifest.resources[0]?.entry !== "playlist.json"
    || manifest.files.length !== 1 || manifest.files[0]?.path !== "playlist.json") {
    throw new Error("hocpkg 不是播放集包。");
  }
  const body = files["playlist.json"];
  if (body.byteLength !== manifest.files[0].bytes || await sha256(body) !== manifest.files[0].sha256) {
    throw new Error("播放集正文大小或摘要不符。");
  }
  return PlaylistDocumentSchema.parse(migratePlaylistDocument(JSON.parse(decodeText(body)), fallbackOrder));
}

export async function decodePlaylistFile(file: File, fallbackOrder: readonly string[] = []): Promise<PlaylistDocument> {
  if (file.size > MAX_PLAYLIST_FILE) throw new Error("播放集文件超过 2 MiB 限额。");
  return decodePlaylistBytes(new Uint8Array(await file.arrayBuffer()), fallbackOrder);
}
