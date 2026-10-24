import type { ContentDigest, ContentFileEntry, ContentFileSystem, ContentOperationOptions } from "./contracts";
import { sha256 } from "./encoding";

export function checkCancelled(options?: ContentOperationOptions): void {
  options?.signal?.throwIfAborted();
}

export async function inspectFiles(fs: ContentFileSystem, paths: readonly string[], options?: ContentOperationOptions): Promise<readonly ContentDigest[]> {
  checkCancelled(options);
  if (fs.inspect) {
    const result = await fs.inspect(paths, options);
    checkCancelled(options);
    if (result.length !== paths.length) throw new Error("校验返回的文件数量不符。");
    return result;
  }
  const result: ContentDigest[] = [];
  for (const path of paths) {
    checkCancelled(options);
    const bytes = await fs.read(path);
    if (!bytes) throw new Error(`内容文件缺失：${path}`);
    result.push({ bytes: bytes.length, sha256: await sha256(bytes) });
    options?.onProgress?.({ phase: "verifying", path, completedBytes: bytes.length, totalBytes: bytes.length });
  }
  return result;
}

export async function copyFile(fs: ContentFileSystem, entry: ContentFileEntry, destination: string, options?: ContentOperationOptions): Promise<ContentDigest> {
  checkCancelled(options);
  if (entry.source && fs.copy) return fs.copy(entry.source, destination, options);
  const bytes = entry.bytes ?? (entry.source?.kind === "stored" ? await fs.read(entry.source.path) : null);
  if (!bytes) throw new Error(`内容来源不可读取：${entry.path}`);
  const digest = { bytes: bytes.length, sha256: await sha256(bytes) };
  checkCancelled(options);
  await fs.write(destination, bytes);
  return digest;
}
