import type { ContentFileSystem, ContentImportFile, ContentOperationOptions } from "./contracts";
import { checkCancelled } from "./file-operations";

export type ImportFile = File | ContentImportFile;

export async function readImportRange(fs: ContentFileSystem | undefined, file: ImportFile, offset: number, length: number, options?: ContentOperationOptions): Promise<Uint8Array> {
  checkCancelled(options);
  const source = "source" in file ? file.source : { kind: "blob" as const, blob: file };
  let bytes: Uint8Array;
  if (source.kind === "blob") bytes = new Uint8Array(await source.blob.slice(offset, offset + length).arrayBuffer());
  else if (fs?.readRange) bytes = await fs.readRange(source, offset, length, options);
  else if (source.kind === "stored" && fs) {
    if (file.size > 2 * 1024 * 1024) throw new Error("当前宿主不支持大型文件识别，请从资源包入口导入。");
    const body = await fs.read(source.path);
    if (!body) throw new Error("导入文件不存在，请重新选择。");
    bytes = body.slice(offset, offset + length);
  } else throw new Error("当前文件来源无法读取，请重新选择文件。");
  checkCancelled(options);
  if (bytes.length !== Math.min(length, Math.max(0, file.size - offset))) throw new Error("导入文件读取不完整，请重新选择。");
  return bytes;
}

/** Only picker-owned temporary inputs may be released, never the user's original. */
export async function releaseImportFile(fs: ContentFileSystem | undefined, file: ImportFile): Promise<void> {
  if ("source" in file && file.source.kind === "stored" && /^content\/v1\/import-inputs\/[A-Za-z0-9._-]+$/.test(file.source.path)) {
    await fs?.remove(file.source.path);
  }
}
