import type { ContentArchive, ContentArchiveEntry, ContentDigest, ContentFileSource, ContentFileSystem, ContentOperationOptions } from "./contracts";
import { archiveBlob, extractZipEntry, zipIndex } from "./browser-archive";
import { checkCancelled } from "./file-operations";
import { sha256 } from "./encoding";

export function browserIo<T>(request: unknown, options?: ContentOperationOptions): Promise<T> {
  checkCancelled(options);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./browser-io.worker.ts", import.meta.url), { type: "module" });
    const cancel = () => worker.postMessage({ cancel: true });
    const finish = () => { options?.signal?.removeEventListener("abort", cancel); worker.terminate(); };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    worker.onerror = event => { finish(); reject(new Error(event.message)); };
    worker.onmessage = event => {
      if (event.data.progress) { options?.onProgress?.(event.data.progress); return; }
      finish();
      if (options?.signal?.aborted) reject(options.signal.reason);
      else if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result as T);
    };
    worker.postMessage(request);
  });
}

export async function openBrowserArchive(fs: ContentFileSystem, source: ContentFileSource, options?: ContentOperationOptions, inWorker = false): Promise<ContentArchive> {
  if (inWorker) {
    const archive = await browserIo<{ entries: ContentArchiveEntry[]; source: ContentFileSource }>({ action: "index", source }, options);
    return { entries: archive.entries, extractMany: (files, options) => browserIo<ContentDigest[]>({ action: "extractMany", source: archive.source, files }, options), extract: (path, destination, options) => browserIo<ContentDigest>({ action: "extract", source: archive.source, path, destination }, options), async close() {} };
  }
  // Neutral in-memory hosts and unit tests exercise the same bounded ZIP reader.
  const blob = source.kind === "blob" ? source.blob : source.kind === "stored"
    ? new Blob([new Uint8Array(await fs.read(source.path) ?? [])]) : await (await fetch(source.path)).blob();
  const archive = await archiveBlob(blob);
  const entries = await zipIndex(archive);
  return { entries, async extract(path, destination, options) {
    checkCancelled(options);
    const entry = entries.find(entry => entry.path === path);
    if (!entry) throw new Error(`ZIP 条目不存在：${path}`);
    const bytes = await extractZipEntry(archive, entry, () => checkCancelled(options));
    const digest = { bytes: bytes.length, sha256: await sha256(bytes) };
    checkCancelled(options);
    await fs.write(destination, bytes);
    return digest;
  }, async close() {} };
}
