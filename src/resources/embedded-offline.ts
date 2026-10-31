import { Capacitor } from "@capacitor/core";
import { z } from "zod";
import { sha256 } from "../content/storage/encoding";
import type { ContentPackageAccess } from "../content/packages/content-source";

export const EMBEDDED_MEDIA_CACHE = "hoc-embedded-media-v1";
const resourceSchema = z.object({
  url: z.string().refine(value => /^\/(?:embedded|assets)\//.test(value) && !value.includes("..")),
  bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.string(),
  legacyUrl: z.string().refine(value => value.startsWith('/assets/') && !value.includes('..')).optional()
}).strict();
const offlineSchema = z.object({ format: z.literal("house-of-chances-offline-resources"), formatVersion: z.literal(1), resources: z.array(resourceSchema).max(65536) }).strict();
export type OfflineResource = z.infer<typeof resourceSchema>;
export interface OfflineState { phase: "idle" | "checking" | "downloading" | "complete" | "cancelled" | "error"; completed: number; total: number; bytes: number; totalBytes: number; message: string }

export async function cacheVerifiedResource(cache: Cache, entry: OfflineResource, bytes: Uint8Array): Promise<void> {
  if (bytes.length !== entry.bytes || await sha256(bytes) !== entry.sha256) throw new Error("离线资源校验失败。");
  const copy = new Uint8Array(bytes.length); copy.set(bytes);
  await cache.put(entry.url, new Response(copy.buffer, { headers: { "content-type": entry.mediaType, "x-hoc-digest": entry.sha256 } }));
}

/** Copy only bytes proven identical to the target; never activate the old definitions. */
export async function preserveEmbeddedCache(old: ContentPackageAccess, target: ContentPackageAccess): Promise<void> {
  if (Capacitor.isNativePlatform()) return;
  if (typeof caches === "undefined") {
    if (typeof window !== "undefined") throw new Error("当前浏览器的离线缓存不可用。");
    return;
  }
  const cache = await caches.open(EMBEDDED_MEDIA_CACHE);
  const byDigest = new Map(old.manifest.files.map(file => [file.sha256, file]));
  for (const file of target.manifest.files) {
    const previous = byDigest.get(file.sha256);
    if (!previous || previous.bytes !== file.bytes) continue;
    const { url } = await target.resolveAsset(file.path);
    if (!url.startsWith("/embedded/")) continue;
    const bytes = await old.readFile!(previous.path);
    await cacheVerifiedResource(cache, { ...file, url }, bytes);
  }
}

async function waitForOfflineShell(signal: AbortSignal): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) throw new Error("当前浏览器不支持离线应用外壳。");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new Error("资源已下载，应用外壳尚未完成离线准备，请稍后重新检查。")), 15000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else navigator.serviceWorker.ready.then(() => finish(), finish);
  });
}

/** One session-wide operation; closing settings detaches its view, not the download. */
export class EmbeddedOfflineResources {
  state: OfflineState = { phase: "idle", completed: 0, total: 0, bytes: 0, totalBytes: 0, message: "按需下载，尚未检查离线资源。" };
  private listeners = new Set<(state: OfflineState) => void>();
  private operation?: Promise<void>;
  private abort?: AbortController;
  private manifest?: Promise<readonly OfflineResource[]>;
  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis), private readonly storage: Pick<CacheStorage, "open" | "delete"> | undefined = globalThis.caches, private readonly shellReady: (signal: AbortSignal) => Promise<void> = waitForOfflineShell) {}
  subscribe(listener: (state: OfflineState) => void): () => void { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }
  private update(values: Partial<OfflineState>) { this.state = { ...this.state, ...values }; for (const listener of this.listeners) listener(this.state); }
  resources(): Promise<readonly OfflineResource[]> {
    return this.manifest ??= (async () => {
      const response = await this.request("/embedded/offline.json");
      if (!response.ok) throw new Error("离线清单不可用，请使用构建后的 PWA。");
      const resources = offlineSchema.parse(await response.json()).resources;
      if (new Set(resources.map(entry => entry.url)).size !== resources.length) throw new Error("离线清单包含重复资源。");
      return resources;
    })().catch(error => { this.manifest = undefined; throw error; });
  }
  private async available(cache: Cache, entry: OfflineResource, byDigest: ReadonlyMap<string, Request>): Promise<boolean> {
    let response = await cache.match(entry.url);
    if (!response && byDigest.has(entry.sha256)) {
      const previous = await cache.match(byDigest.get(entry.sha256)!);
      if (previous) {
        try { await cacheVerifiedResource(cache, entry, new Uint8Array(await previous.arrayBuffer())); return true; }
        catch { /* Fetch the expected bytes instead of reusing a damaged cached copy. */ }
      }
    }
    if (!response) return false;
    if (response.headers.get("x-hoc-digest") === entry.sha256) return true;
    try { await cacheVerifiedResource(cache, entry, new Uint8Array(await response.arrayBuffer())); return true; }
    catch { await cache.delete(entry.url); return false; }
  }
  private run(download: boolean): Promise<void> {
    if (this.operation) return this.operation;
    this.operation = (async () => {
      this.abort = new AbortController();
      try {
        if (!this.storage) throw new Error("当前环境不支持离线缓存。");
        this.update({ phase: "checking", completed: 0, bytes: 0, message: "正在检查已缓存资源……" });
        const resources = await this.resources(), cache = await this.storage.open(EMBEDDED_MEDIA_CACHE);
        const byDigest = new Map<string, Request>();
        for (const key of await cache.keys()) {
          const response = await cache.match(key), digest = response?.headers.get("x-hoc-digest");
          if (digest) byDigest.set(digest, key);
        }
        this.update({ total: resources.length, totalBytes: resources.reduce((sum, entry) => sum + entry.bytes, 0) });
        let next = 0, completed = 0, bytes = 0;
        const failures: string[] = [];
        const worker = async () => {
          while (next < resources.length && !this.abort!.signal.aborted) {
            const entry = resources[next++]!;
            try {
              let ready = await this.available(cache, entry, byDigest);
              if (!ready && download) {
                this.update({ phase: "downloading", message: "正在下载完整内嵌资源……" });
                const response = await this.request(entry.url, { signal: this.abort!.signal });
                if (!response.ok) throw new Error(`资源下载失败 (${response.status})`);
                await cacheVerifiedResource(cache, entry, new Uint8Array(await response.arrayBuffer())); ready = true;
              }
              if (ready) { completed++; bytes += entry.bytes; this.update({ completed, bytes }); }
            } catch (error) { if (!this.abort!.signal.aborted) failures.push(error instanceof Error ? error.message : String(error)); }
          }
        };
        await Promise.all([worker(), worker()]);
        if (this.abort.signal.aborted) this.update({ phase: "cancelled", message: "已取消，已完成资源保留；可继续下载。" });
        else if (failures.length) this.update({ phase: "error", message: `${failures.length} 项未完成：${failures[0]}，可重试。` });
        else if (completed === resources.length) {
          // Shell assets are separate from the media cache, and must also be ready.
          await this.shellReady(this.abort.signal);
          this.update({ phase: "complete", message: "完整内嵌资源已缓存，可离线使用。" });
        } else this.update({ phase: "idle", message: "当前按需缓存；尚未下载完整资源。" });
      } catch (error) { this.update(this.abort?.signal.aborted ? { phase: "cancelled", message: "已取消，已完成资源保留；可继续下载。" } : { phase: "error", message: error instanceof Error ? error.message : String(error) }); }
      finally { this.abort = undefined; this.operation = undefined; }
    })(); return this.operation;
  }
  check() { return this.run(false); }
  download() { return this.run(true); }
  cancel() { this.abort?.abort(); }
  async clear(): Promise<void> {
    this.cancel(); await this.operation;
    try { await this.storage?.delete(EMBEDDED_MEDIA_CACHE); this.update({ phase: "idle", completed: 0, bytes: 0, message: "已清除内嵌下载缓存；存档、自定义内容和启停状态保留。" }); }
    catch (error) { this.update({ phase: "error", message: String(error) }); }
  }
}

export const embeddedOffline = new EmbeddedOfflineResources();

export function mountEmbeddedOfflineControls(root: HTMLElement | null): () => void {
  if (!root) return () => {};
  if (Capacitor.isNativePlatform()) { root.replaceChildren(); root.hidden = true; return () => {}; }
  root.innerHTML = '<section class="embedded-offline-controls"><h3>内嵌离线资源</h3><p class="setting-description">默认按需下载。完整下载包含全部内嵌内容、皮肤和共享媒体，不改变播放集。</p><progress max="1" value="0" aria-label="内嵌资源下载进度"></progress><p role="status" data-offline-status></p><div class="save-actions"><button type="button" class="primary-button" data-offline-download>下载完整资源</button><button type="button" class="secondary-button" data-offline-check>检查</button><button type="button" class="secondary-button" data-offline-cancel hidden>取消下载</button><button type="button" class="secondary-button" data-offline-clear>清除下载缓存</button></div></section>';
  const events = new AbortController(), signal = events.signal;
  const off = embeddedOffline.subscribe(state => {
    const busy = state.phase === "checking" || state.phase === "downloading";
    root.dataset.offlineState = state.phase;
    root.querySelector<HTMLElement>('[data-offline-status]')!.textContent = `${state.message} ${state.completed}/${state.total} 项 · ${(state.bytes/1048576).toFixed(1)}/${(state.totalBytes/1048576).toFixed(1)} MiB`;
    const progress = root.querySelector('progress')!; progress.max = Math.max(1, state.totalBytes); progress.value = state.bytes;
    const button = root.querySelector<HTMLButtonElement>('[data-offline-download]')!; button.disabled = busy; button.textContent = state.phase === "complete" ? "检查并补齐资源" : state.completed ? "继续下载" : "下载完整资源";
    root.querySelector<HTMLButtonElement>('[data-offline-check]')!.disabled = busy;
    root.querySelector<HTMLButtonElement>('[data-offline-cancel]')!.hidden = !busy;
  });
  root.querySelector('[data-offline-download]')!.addEventListener('click', () => void embeddedOffline.download(), { signal });
  root.querySelector('[data-offline-check]')!.addEventListener('click', () => void embeddedOffline.check(), { signal });
  root.querySelector('[data-offline-cancel]')!.addEventListener('click', () => embeddedOffline.cancel(), { signal });
  root.querySelector('[data-offline-clear]')!.addEventListener('click', () => void embeddedOffline.clear(), { signal });
  void embeddedOffline.check();
  return () => { off(); events.abort(); };
}
