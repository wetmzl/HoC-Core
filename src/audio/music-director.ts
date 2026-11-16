import { z } from "zod";
import type { InstalledMusicResource } from "../content/packages/music";
import { MusicPackageOrderSchema } from "../content/packages/music";
import { LOBBY_BGM_URL, TABLE_BGM_URL } from "../resources/cache-policy";
import { MUSIC_PRIORITIES, type MusicCandidate, type MusicContext, type MusicRequest, type MusicScene, type MusicStatus, type PluginMusicApi } from "./music-contracts";
import type { GameEvent, MatchState } from "../core/match/types";

const requestId = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/).max(80);
const requestSchema = z.object({
  track: z.string().regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*#[a-z0-9][a-z0-9:_-]*\/[a-z0-9][a-z0-9:_-]*$/),
  priority: z.enum(["background", "override", "conditional", "temporary"]),
  scope: z.enum(["scene", "match", "runtime"]), loop: z.boolean().default(true),
  transitionMs: z.number().int().min(0).max(10000).default(800), restart: z.boolean().default(false)
}).strict();
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
interface OwnedRequest { owner: object; packageId: string; key: string; request: z.infer<typeof requestSchema>; matchId?: string }

/** Presentation-only arbitration; never consumes game RNG or writes match/save data. */
export class MusicDirector {
  private resources: readonly InstalledMusicResource[] = [];
  private order: readonly string[] = [];
  private requests: OwnedRequest[] = [];
  private legacy: readonly MusicCandidate[] = [];
  private context: MusicContext = { scene: "lobby", events: [], restored: false };
  private readonly contextListeners = new Set<(context: MusicContext) => void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly failed = new Set<string>();
  private readonly completed = new Set<string>();
  private current?: MusicCandidate;
  private readonly temporaryTracks = new Map<object, MusicCandidate>();
  /** Host-owned temporary media participates in the existing priority and volume system. */
  holdTrack(url: string, options: { loop?: boolean; transitionMs?: number } = {}): () => void {
    const owner = {};
    const id = `story:${crypto.randomUUID()}`;
    this.temporaryTracks.set(owner, { id, track: id, url, title: "剧情音乐", packageId: "", priority: "temporary", order: Number.MAX_SAFE_INTEGER,
      loop: options.loop ?? true, transitionMs: options.transitionMs ?? 300 });
    this.refresh();
    return () => { if (this.temporaryTracks.delete(owner)) this.refresh(); };
  }
  constructor(private readonly changed: (candidates: readonly MusicCandidate[]) => void) {}

  install(resources: readonly InstalledMusicResource[]): void {
    this.resources = structuredClone(resources);
    this.failed.clear(); this.completed.clear();
    for (const resource of resources) for (const [id, track] of Object.entries(resource.tracks)) {
      if (!track.url) this.failed.add(`${resource.packageId}#${resource.resourceId}/${id}`);
    }
    this.refresh();
  }
  setOrder(order: readonly string[]): void { this.order = MusicPackageOrderSchema.parse(order); this.refresh(); }
  setLegacy(sources: readonly string[] = [], priorities?: readonly ("character" | "faction")[]): void {
    this.legacy = sources.filter(url => url && url !== TABLE_BGM_URL).map((url, index) => ({
      id: `legacy:${index}:${url}`, track: url, url, title: priorities?.[index] === "faction" ? "阵营音乐" : "角色音乐",
      packageId: "", priority: priorities?.[index] ?? (index === 0 ? "character" : "faction"), order: index, loop: true, transitionMs: 800
    }));
    this.refresh();
  }
  setScene(scene: MusicScene): void {
    if (scene !== "lobby" && scene !== "match") throw new Error("音乐场景无效");
    if (scene === this.context.scene) return;
    this.requests = this.requests.filter(entry => entry.request.scope !== "scene" && !(scene === "lobby" && entry.request.scope === "match"));
    this.context = { ...this.context, scene, ...(scene === "lobby" ? { match: undefined, characterId: undefined } : {}), events: [], restored: false };
    this.refresh(); this.notifyContext();
  }
  updateMatch(match?: MatchState, events: readonly GameEvent[] = [], restored = false): void {
    const changedMatch = this.context.match?.id !== match?.id;
    if (changedMatch) {
      this.requests = this.requests.filter(entry => entry.request.scope !== "match");
    }
    this.context = { scene: this.context.scene, match, characterId: match?.opponentId, events, restored };
    if (changedMatch) this.refresh();
    this.notifyContext();
  }
  private notifyContext(): void {
    if (!this.contextListeners.size) return;
    const snapshot = this.snapshot();
    for (const listener of this.contextListeners) this.call(listener, snapshot);
  }
  private call(listener: (context: MusicContext) => void, context: MusicContext): void {
    try { void Promise.resolve(listener(context)).catch(error => console.warn("插件音乐条件回调失败", error)); } catch (error) { console.warn("插件音乐条件回调失败", error); }
  }
  private snapshot(initial = false): MusicContext {
    return freeze(structuredClone({ ...this.context, events: initial ? [] : this.context.events }));
  }
  forPackage(packageId: string, signal: AbortSignal): PluginMusicApi {
    const owner = {};
    const ownedListeners = new Set<(context: MusicContext) => void>();
    const release = (id: string) => {
      if (signal.aborted) return;
      const next = this.requests.filter(entry => entry.owner !== owner || entry.key !== id);
      if (next.length === this.requests.length) return;
      this.requests = next; this.refresh();
    };
    const cleanup = () => {
      this.requests = this.requests.filter(entry => entry.owner !== owner);
      for (const listener of ownedListeners) this.contextListeners.delete(listener);
      ownedListeners.clear(); this.refresh();
    };
    if (!signal.aborted) signal.addEventListener("abort", cleanup, { once: true });
    return {
      set: (id, input: MusicRequest) => {
        if (signal.aborted) return;
        requestId.parse(id);
        const request = requestSchema.parse(input);
        if (!this.track(request.track)) throw new Error(`音乐曲目未安装或未启用：${request.track}`);
        if (request.scope === "match" && (!this.context.match || this.context.scene !== "match")) throw new Error("当前没有活动牌局");
        if (this.requests.some(entry => entry.packageId === packageId && entry.key === id && entry.owner !== owner)) throw new Error("音乐请求 ID 已被同包另一模块使用");
        const existing = this.requests.find(entry => entry.owner === owner && entry.key === id);
        // Repeated condition notifications do not revive a completed one-shot or restart playback.
        if (existing && JSON.stringify(existing.request) === JSON.stringify(request)) return;
        const entry = { owner, packageId, key: id, request, matchId: this.context.match?.id };
        if (existing) this.requests[this.requests.indexOf(existing)] = entry;
        else this.requests.push(entry);
        this.completed.delete(`plugin:${packageId}:${id}`); this.refresh();
      },
      release,
      subscribeContext: (listener, options = {}) => {
        if (signal.aborted || options.signal?.aborted) return () => {};
        // A separate wrapper makes independent subscriptions of the same callback safe.
        const wrapped = (context: MusicContext) => listener(context);
        const unsubscribe = () => {
          this.contextListeners.delete(wrapped); ownedListeners.delete(wrapped);
          options.signal?.removeEventListener("abort", unsubscribe);
          signal.removeEventListener("abort", unsubscribe);
        };
        this.contextListeners.add(wrapped); ownedListeners.add(wrapped);
        options.signal?.addEventListener("abort", unsubscribe, { once: true });
        signal.addEventListener("abort", unsubscribe, { once: true });
        this.call(wrapped, this.snapshot(true));
        return unsubscribe;
      }
    };
  }
  private track(key: string) {
    for (const resource of this.resources) for (const [id, track] of Object.entries(resource.tracks)) {
      if (`${resource.packageId}#${resource.resourceId}/${id}` === key) return track;
    }
    return undefined;
  }
  candidates(): readonly MusicCandidate[] {
    const candidates: MusicCandidate[] = [];
    for (const resource of this.resources) resource.rules.forEach((rule, index) => {
      const track = resource.tracks[rule.track];
      if (rule.scene !== this.context.scene || !track?.url) return;
      candidates.push({ id: `${resource.packageId}#${resource.resourceId}/${rule.id}`, track: `${resource.packageId}#${resource.resourceId}/${rule.track}`,
        url: track.url, title: track.name, packageId: resource.packageId, priority: rule.priority, order: index, loop: true, transitionMs: rule.transitionMs ?? 800 });
    });
    for (const entry of this.requests) {
      const track = this.track(entry.request.track);
      if (!track?.url || (entry.request.scope === "match" && (entry.matchId !== this.context.match?.id || this.context.scene !== "match"))) continue;
      candidates.push({ ...entry.request, id: `plugin:${entry.packageId}:${entry.key}`, url: track.url, title: track.name, packageId: entry.request.track.split("#")[0], order: Number.MAX_SAFE_INTEGER });
    }
    if (this.context.scene === "match") candidates.push(...this.legacy);
    const url = this.context.scene === "lobby" ? LOBBY_BGM_URL : TABLE_BGM_URL;
    candidates.push({ id: `core:${this.context.scene}`, track: url, url, title: this.context.scene === "lobby" ? "默认大厅音乐" : "默认牌局音乐",
      packageId: "", priority: "core", order: 0, loop: true, transitionMs: 800 });
    const rank = (id: string) => { const index = this.order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    candidates.push(...this.temporaryTracks.values());
    return candidates.sort((a, b) => MUSIC_PRIORITIES[b.priority] - MUSIC_PRIORITIES[a.priority]
      || rank(a.packageId) - rank(b.packageId) || a.packageId.localeCompare(b.packageId) || a.order - b.order || a.id.localeCompare(b.id));
  }
  private refresh(): void {
    this.changed(this.candidates().filter(candidate => !this.failed.has(candidate.track) && !this.completed.has(candidate.id)));
    for (const listener of this.statusListeners) { try { listener(); } catch (error) { console.warn("音乐状态订阅失败", error); } }
  }
  failedTrack(track: string): void { this.failed.add(track); this.refresh(); }
  ended(id: string): void { this.completed.add(id); this.refresh(); }
  playing(candidate?: MusicCandidate): void { this.current = candidate; for (const listener of this.statusListeners) { try { listener(); } catch { /* Presentation diagnostics only. */ } } }
  status(): MusicStatus {
    const ids = [...new Set(this.resources.map(resource => resource.packageId))];
    const rank = (id: string) => { const index = this.order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return freeze(structuredClone({ scene: this.context.scene, current: this.current, candidates: this.candidates(), failedTracks: [...this.failed],
      packages: ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(id => ({ id, title: this.resources.find(resource => resource.packageId === id)!.title })) }));
  }
  subscribeStatus(listener: () => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.statusListeners.add(listener); signal.addEventListener("abort", () => this.statusListeners.delete(listener), { once: true }); listener();
  }
  dispose(): void {
    this.resources = []; this.requests = []; this.legacy = []; this.order = []; this.current = undefined; this.temporaryTracks.clear();
    this.failed.clear(); this.completed.clear(); this.contextListeners.clear(); this.statusListeners.clear();
    this.context = { scene: "lobby", events: [], restored: false };
  }
}
