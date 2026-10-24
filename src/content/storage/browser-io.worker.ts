import type { ContentFileSource, ContentOperationProgress } from "./contracts";
import { archiveBlob, extractZipEntry, zipIndex } from "./browser-archive";
import { sha256 } from "./encoding";

const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
let cancelled = false;
let lastProgress = 0;
function check() { if (cancelled) throw new Error("操作已取消。"); }
function segments(path: string): string[] {
  const parts = path.split("/");
  if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) throw new Error("非法内容路径。");
  return parts;
}
async function blobFor(source: ContentFileSource, root: FileSystemDirectoryHandle): Promise<Blob> {
  if (source.kind === "blob") return source.blob;
  if (source.kind === "asset") {
    const response = await fetch(source.path);
    if (!response.ok) throw new Error(`内容读取失败：${source.path}`);
    return response.blob();
  }
  const parts = segments(source.path);
  let parent = root;
  for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
  return (await parent.getFileHandle(parts.at(-1)!)).getFile();
}
function progress(phase: ContentOperationProgress["phase"], path: string, bytes: number): void {
  const now = performance.now();
  if (now - lastProgress < 100) return;
  lastProgress = now;
  scope.postMessage({ progress: { phase, path, completedBytes: bytes, totalBytes: bytes } });
}
async function write(root: FileSystemDirectoryHandle, destination: string, bytes: Uint8Array) {
  check();
  const digest = { bytes: bytes.length, sha256: await sha256(bytes) };
  check();
  const parts = segments(destination);
  let parent = root;
  for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
  const handle = await parent.getFileHandle(parts.at(-1)!, { create: true });
  const writable = await handle.createWritable();
  // A cancelled operation acknowledges only after the writable has closed.
  try { check(); await writable.write(new Uint8Array(bytes)); await writable.close(); }
  catch (error) { await writable.abort().catch(() => undefined); throw error; }
  check();
  return digest;
}
scope.onmessage = (event) => {
  if (event.data.cancel) { cancelled = true; return; }
  void (async () => {
    const root = await navigator.storage.getDirectory();
    const { action, source, paths, path, destination, files } = event.data as {
      action: string; source: ContentFileSource; paths: string[]; path: string; destination: string;
      files: { source: ContentFileSource; path: string; destination: string }[];
    };
    check();
    if (action === "inspect") {
      const results = [];
      for (const path of paths) {
        check();
        const bytes = new Uint8Array(await (await blobFor({ kind: "stored", path }, root)).arrayBuffer());
        results.push({ bytes: bytes.length, sha256: await sha256(bytes) });
        progress("verifying", path, bytes.length);
      }
      check(); return results;
    }
    if (action === "copyMany") {
      const results = [];
      for (const file of files) {
        check();
        // Only this file's bytes survive while its digest and OPFS write settle.
        results.push(await write(root, file.destination, new Uint8Array(await (await blobFor(file.source, root)).arrayBuffer())));
        progress("copying", file.destination, results.at(-1)!.bytes);
      }
      check(); return results;
    }
    const blob = await blobFor(source, root);
    check();
    if (action === "index") {
      const archive = await archiveBlob(blob);
      check();
      return { entries: await zipIndex(archive), source: { kind: "blob", blob: archive } };
    }
    if (action === "extract" || action === "extractMany") {
      const archive = await archiveBlob(blob);
      const entries = await zipIndex(archive);
      const results = [];
      for (const file of action === "extract" ? [{ path, destination }] : files) {
        check();
        const entry = entries.find(entry => entry.path === file.path);
        if (!entry) throw new Error(`ZIP 条目不存在：${file.path}`);
        results.push(await write(root, file.destination, await extractZipEntry(archive, entry, check)));
        progress("extracting", file.path, entry.bytes);
      }
      check(); return action === "extract" ? results[0] : results;
    }
    const digest = await write(root, destination, new Uint8Array(await blob.arrayBuffer()));
    progress("copying", destination, digest.bytes);
    return digest;
  })().then(result => scope.postMessage({ result }), error => scope.postMessage({ error: error instanceof Error ? error.message : String(error) }));
};
