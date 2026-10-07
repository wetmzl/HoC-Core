import { Inflate } from "fflate";
import type { ContentArchiveEntry } from "./contracts";

interface ZipEntry extends ContentArchiveEntry { readonly offset: number; readonly method: number; readonly crc: number; }
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value;
});
function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return crc;
}
export function crc32(bytes: Uint8Array): number { return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }

async function slice(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// Read only the ZIP central directory, then inflate one requested entry. ZIP64 is
// outside the 256 MiB input contract. Payloads never accumulate in a bundle map.
export async function zipIndex(blob: Blob): Promise<readonly ZipEntry[]> {
  const tail = await slice(blob, Math.max(0, blob.size - 65557), blob.size);
  const view = new DataView(tail.buffer);
  let end = tail.length - 22;
  while (end >= 0 && (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== tail.length)) end--;
  if (end < 0) throw new Error("ZIP 缺少中央目录。");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true)
    || count > 1000 || start + size > blob.size || size > 4 * 1024 * 1024) throw new Error("ZIP 中央目录不安全或超过限额。");
  const bytes = await slice(blob, start, start + size);
  const directory = new DataView(bytes.buffer);
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || directory.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏。");
    const flags = directory.getUint16(cursor + 8, true);
    const method = directory.getUint16(cursor + 10, true);
    const nameLength = directory.getUint16(cursor + 28, true);
    const next = cursor + 46 + nameLength + directory.getUint16(cursor + 30, true) + directory.getUint16(cursor + 32, true);
    if (next > bytes.length) throw new Error("ZIP 中央目录损坏。");
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    // Match fflate's legacy Latin-1 decoding; bundle labels recover UTF-8 separately.
    const path = flags & 0x800 ? new TextDecoder().decode(name) : Array.from(name, n => String.fromCharCode(n)).join("");
    if (!path.endsWith("/")) {
      if ((flags & 1) || (method !== 0 && method !== 8)) throw new Error("不支持加密或此压缩方式的 ZIP。");
      entries.push({ path, bytes: directory.getUint32(cursor + 24, true), compressedBytes: directory.getUint32(cursor + 20, true),
        offset: directory.getUint32(cursor + 42, true), method, crc: directory.getUint32(cursor + 16, true) });
    }
    cursor = next;
  }
  return entries;
}

export async function extractZipEntry(blob: Blob, entry: ZipEntry, check: () => void = () => undefined): Promise<Uint8Array> {
  if (entry.bytes > 256 * 1024 * 1024 || (entry.compressedBytes > 0 && entry.bytes / entry.compressedBytes > 200)) throw new Error("ZIP 条目超过限额。");
  const header = await slice(blob, entry.offset, entry.offset + 30);
  const view = new DataView(header.buffer);
  if (header.length !== 30 || view.getUint32(0, true) !== 0x04034b50) throw new Error("ZIP 本地条目损坏。");
  const start = entry.offset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  if (start + entry.compressedBytes > blob.size) throw new Error("ZIP 条目不完整。");
  check();
  let bytes: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedBytes !== entry.bytes) throw new Error("ZIP 条目大小不符。");
    bytes = await slice(blob, start, start + entry.compressedBytes);
  } else {
    bytes = new Uint8Array(entry.bytes);
    let written = 0;
    const inflater = new Inflate(chunk => {
      if (written + chunk.length > entry.bytes) throw new Error("ZIP 条目大小不符。");
      bytes.set(chunk, written); written += chunk.length;
    });
    // Bound each inflater allocation even when a corrupt entry lies about its
    // uncompressed size, and yield between chunks so cancellation can settle.
    for (let offset = 0; offset < entry.compressedBytes; offset += 16 * 1024) {
      check();
      const end = Math.min(offset + 16 * 1024, entry.compressedBytes);
      inflater.push(await slice(blob, start + offset, start + end), end === entry.compressedBytes);
    }
    if (written !== entry.bytes) throw new Error("ZIP 条目大小不符。");
  }
  check();
  if (crc32(bytes) !== entry.crc) throw new Error("ZIP 条目校验失败。");
  return bytes;
}

export async function archiveBlob(blob: Blob): Promise<Blob> {
  const signature = await slice(blob, 0, 8);
  if (signature[0] === 0x50 && signature[1] === 0x4b) return blob;
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => n === signature[i])) throw new Error("文件不是 hocpkg、ZIP 或内嵌 hocpkg 的 PNG。");
  let cursor = 8;
  let payload: Blob | undefined;
  while (cursor + 12 <= blob.size) {
    const header = await slice(blob, cursor, cursor + 8);
    const length = new DataView(header.buffer).getUint32(0);
    const end = cursor + 12 + length;
    if (end > blob.size) throw new Error("PNG 数据不完整。");
    let crc = 0xffffffff;
    for (let offset = cursor + 4; offset < end - 4; offset += 256 * 1024) {
      crc = updateCrc(crc, await slice(blob, offset, Math.min(offset + 256 * 1024, end - 4)));
    }
    const checksum = await slice(blob, end - 4, end);
    if (((crc ^ 0xffffffff) >>> 0) !== new DataView(checksum.buffer).getUint32(0)) throw new Error("PNG 校验失败。");
    const type = new TextDecoder().decode(header.subarray(4));
    if (type === "hcPK" && !payload) payload = blob.slice(cursor + 8, end - 4);
    if (type === "IEND") {
      if (!payload) throw new Error("PNG 中没有 hocpkg 内容包。");
      return payload;
    }
    cursor = end;
  }
  throw new Error("PNG 缺少 IEND。");
}
