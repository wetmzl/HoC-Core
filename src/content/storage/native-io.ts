import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { ContentArchive, ContentArchiveEntry, ContentDigest, ContentFileSource, ContentImportFile, ContentOperationOptions, ContentOperationProgress } from "./contracts";
import { checkCancelled } from "./file-operations";
interface NativeContentIo {
  inspect(options: unknown): Promise<{ results: ContentDigest[] }>;
  copy(options: unknown): Promise<ContentDigest>;
  copyMany(options: unknown): Promise<{ results: ContentDigest[] }>;
  openArchive(options: unknown): Promise<{ token: string; entries: ContentArchiveEntry[] }>;
  extract(options: unknown): Promise<ContentDigest>;
  extractMany(options: unknown): Promise<{ results: ContentDigest[] }>;
  closeArchive(options: unknown): Promise<void>;
  cancel(options: unknown): Promise<void>;
  pickFile(options: unknown): Promise<{ file: ContentImportFile | null }>;
  addListener(event: "progress", listener: (progress: ContentOperationProgress & { operationId: string }) => void): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<NativeContentIo>("ContentIo");
async function operation<T>(method: "inspect" | "copy" | "openArchive" | "extract" | "pickFile" | "copyMany" | "extractMany", args: Record<string, unknown>, options?: ContentOperationOptions): Promise<T> {
  checkCancelled(options);
  const operationId = crypto.randomUUID();
  const listener = options?.onProgress ? await plugin.addListener("progress", progress => {
    if (progress.operationId === operationId) options.onProgress?.(progress);
  }) : undefined;
  const cancel = () => { void plugin.cancel({ operationId }).catch(() => undefined); };
  options?.signal?.addEventListener("abort", cancel, { once: true });
  try {
    checkCancelled(options);
    const result = await plugin[method]({ ...args, operationId });
    if (options?.signal?.aborted && method === "openArchive") await plugin.closeArchive({ token: (result as { token: string }).token });
    if (options?.signal?.aborted && method === "pickFile") {
      const file = (result as { file: ContentImportFile | null }).file;
      if (file?.source.kind === "stored") await Filesystem.deleteFile({ path: file.source.path, directory: Directory.Data });
    }
    checkCancelled(options);
    return result as T;
  } finally {
    options?.signal?.removeEventListener("abort", cancel);
    await listener?.remove();
  }
}
export const nativeIo = {
  async inspect(paths: readonly string[], options?: ContentOperationOptions) {
    return (await operation<{ results: ContentDigest[] }>("inspect", { paths }, options)).results;
  },
  copy(source: ContentFileSource, destination: string, options?: ContentOperationOptions) {
    return operation<ContentDigest>("copy", { source, destination }, options);
  },
  async copyMany(files: readonly { readonly source: ContentFileSource; readonly destination: string }[], options?: ContentOperationOptions) {
    return (await operation<{ results: ContentDigest[] }>("copyMany", { files }, options)).results;
  },
  async openArchive(source: ContentFileSource, options?: ContentOperationOptions): Promise<ContentArchive> {
    const archive = await operation<{ token: string; entries: ContentArchiveEntry[] }>("openArchive", { source }, options);
    return { entries: archive.entries,
      extract: (path, destination, options) => operation<ContentDigest>("extract", { token: archive.token, path, destination }, options),
      extractMany: async (files, options) => (await operation<{ results: ContentDigest[] }>("extractMany", { token: archive.token, files }, options)).results,
      close: () => plugin.closeArchive({ token: archive.token }) };
  },
  async pickFile(options?: ContentOperationOptions) { return (await operation<{ file: ContentImportFile | null }>("pickFile", {}, options)).file; }
};
