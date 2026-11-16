import { z } from "zod";

export const MAX_PLAYLIST_COVER_BYTES = 1024 * 1024;
const prefix = "data:image/png;base64,";
const signature = [137, 80, 78, 71, 13, 10, 26, 10];

function validateCover(value: string): string {
  if (value.length > prefix.length + 4 * Math.ceil(MAX_PLAYLIST_COVER_BYTES / 3)
    || !value.startsWith(prefix)) throw new Error("播放集封面必须是 1 MiB 以内的 PNG 图片。");
  const encoded = value.slice(prefix.length);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("播放集封面编码无效。");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const size = encoded.length / 4 * 3 - padding;
  const header = atob(encoded.slice(0, 12));
  if (size > MAX_PLAYLIST_COVER_BYTES || !signature.every((byte, index) => header.charCodeAt(index) === byte)) {
    throw new Error("播放集封面必须是 1 MiB 以内的 PNG 图片。");
  }
  return encoded;
}

export function playlistCoverBytes(value: string): Uint8Array {
  const binary = atob(validateCover(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function playlistCoverDataUrl(bytes: Uint8Array): string {
  if (bytes.length > MAX_PLAYLIST_COVER_BYTES || !signature.every((byte, index) => bytes[index] === byte)) {
    throw new Error("播放集封面必须是 1 MiB 以内的 PNG 图片。");
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return prefix + btoa(binary);
}

export const PlaylistCoverSchema = z.string().superRefine((value, context) => {
  try { validateCover(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "播放集封面无效。" }); }
});
