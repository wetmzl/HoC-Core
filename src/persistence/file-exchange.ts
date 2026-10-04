import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export type SaveExportMethod = "file-system-access" | "blob-download" | "native-share";

export interface SaveFileWriter {
  write(blob: Blob, filename: string, description: string, accept: Record<string, string[]>): Promise<SaveExportMethod>;
}

interface FileSystemWritable { write(data: Blob | string): Promise<void>; close(): Promise<void>; }
interface FileSystemSaveHandle { createWritable(): Promise<FileSystemWritable>; }
interface FileSystemWindow {
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemSaveHandle>;
}

export class WebSaveFileWriter implements SaveFileWriter {
  async write(blob: Blob, filename: string, description: string, accept: Record<string, string[]>): Promise<SaveExportMethod> {
    const host = globalThis as unknown as FileSystemWindow;
    if (host.showSaveFilePicker) {
      const handle = await host.showSaveFilePicker({ suggestedName: filename, types: [{ description, accept }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "file-system-access";
    }
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    } finally { URL.revokeObjectURL(url); }
    return "blob-download";
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function safeFilename(filename: string): string {
  const name = filename.split(/[\\/]/).pop();
  if (!name || name === "." || name === "..") throw new Error("存档文件名无效。");
  return name;
}

export class CapacitorSaveFileWriter implements SaveFileWriter {
  async write(blob: Blob, filename: string): Promise<SaveExportMethod> {
    const path = `exports/${safeFilename(filename)}`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await Filesystem.writeFile({ path, data: base64(bytes), directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    try {
      await Share.share({ files: [uri], dialogTitle: "导出命运牌桌存档" });
    } finally {
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
    }
    return "native-share";
  }
}

export function createSaveFileWriter(): SaveFileWriter {
  return Capacitor.isNativePlatform() ? new CapacitorSaveFileWriter() : new WebSaveFileWriter();
}
