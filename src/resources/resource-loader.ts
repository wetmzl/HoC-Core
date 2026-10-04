import type { CharacterDefinition, CharacterMetadata } from "../content/characters/types";
import {
  LOBBY_BACKGROUND_URL,
  STAFF_REVOLVER_URL,
  TABLE_BACKGROUND_URL
} from "./cache-policy";

export type ResourceLoadPriority = "visible" | "display" | "background" | "deferred";

export interface CharacterResourcePlan {
  /** Resources required by the first rendered table frame. */
  readonly visible: readonly string[];
  /** Remaining art used by later table and summary states. */
  readonly display: readonly string[];
  /** Remaining match-owned assets not required by the first two stages. */
  readonly background: readonly string[];
}

export interface CharacterResourcePlanOptions {
  readonly visibleArt?: readonly string[];
  readonly includeTableBase?: boolean;
}

interface ResourceLoaderDependencies {
  readonly fetch?: typeof fetch;
  readonly concurrency?: number;
}

interface QueueItem {
  readonly url: string;
  priority: number;
  readonly sequence: number;
  readonly resolve: (loaded: boolean) => void;
}

const PRIORITY: Readonly<Record<ResourceLoadPriority, number>> = {
  visible: 0,
  display: 1,
  background: 2,
  deferred: 3
};

function isResourceUrl(url: string): boolean {
  return url.startsWith("/assets/")
    || url.startsWith("/characters/")
    || url.startsWith("blob:")
    || /^https?:\/\//.test(url);
}

function uniqueUrls(urls: Iterable<string>): string[] {
  return [...new Set([...urls].filter(isResourceUrl))];
}

/** Recursively discovers media references so future character asset slots join the pack automatically. */
export function collectAssetUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (isResourceUrl(candidate)) urls.add(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    Object.values(candidate as Readonly<Record<string, unknown>>).forEach(visit);
  };
  visit(value);
  return [...urls];
}

/** The lobby only needs unlocked attendee portraits, not full definitions or extension art. */
export function lobbyResourceUrls(characters: readonly CharacterMetadata[]): string[] {
  return uniqueUrls([
    LOBBY_BACKGROUND_URL,
    ...characters.map((character) => character.previewImage)
  ]);
}

export function characterResourcePlan(
  character: CharacterDefinition,
  options: CharacterResourcePlanOptions = {}
): CharacterResourcePlan {
  const visibleArt = options.visibleArt ?? [character.assets.relaxed];
  const visible = uniqueUrls([
    ...(options.includeTableBase === false ? [] : [TABLE_BACKGROUND_URL]),
    ...visibleArt,
    ...(options.includeTableBase === false ? [] : [STAFF_REVOLVER_URL])
  ]);
  const visibleSet = new Set(visible);
  const display = uniqueUrls(Object.entries(character.assets).filter(([key]) => key !== "staffRevolver").map(([, url]) => url)).filter((url) => !visibleSet.has(url));
  return { visible, display, background: [] };
}

/**
 * A small priority queue shared by lobby and match transitions. Requests already
 * running are left alone, while newly visible art overtakes queued background art.
 */
export class ResourceLoader {
  private readonly requestFetch: typeof fetch;
  private readonly concurrency: number;
  private readonly queued: QueueItem[] = [];
  private readonly pending = new Map<string, { readonly promise: Promise<boolean>; readonly item: QueueItem }>();
  private readonly loaded = new Set<string>();
  private active = 0;
  private activeBackground = 0;
  private activeDeferred = 0;
  private sequence = 0;
  private readonly controllers = new Set<AbortController>();

  constructor(dependencies: ResourceLoaderDependencies = {}) {
    this.requestFetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.concurrency = Math.max(1, dependencies.concurrency ?? 3);
  }

  enqueue(urls: readonly string[], priority: ResourceLoadPriority): Promise<readonly boolean[]> {
    const requests = uniqueUrls(urls).map((url) => this.enqueueOne(url, priority));
    this.drain();
    return Promise.all(requests);
  }

  private enqueueOne(url: string, priority: ResourceLoadPriority): Promise<boolean> {
    if (this.loaded.has(url)) return Promise.resolve(true);
    const existing = this.pending.get(url);
    if (existing) {
      existing.item.priority = Math.min(existing.item.priority, PRIORITY[priority]);
      return existing.promise;
    }
    let resolveRequest!: (loaded: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { resolveRequest = resolve; });
    const item: QueueItem = { url, priority: PRIORITY[priority], sequence: this.sequence++, resolve: resolveRequest };
    this.pending.set(url, { promise, item });
    this.queued.push(item);
    return promise;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queued.length > 0) {
      this.queued.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      const backgroundLimit = Math.max(1, this.concurrency - 1);
      const nextIndex = this.queued.findIndex((candidate) => {
        if (candidate.priority < PRIORITY.background) return true;
        if (this.activeBackground >= backgroundLimit) return false;
        return candidate.priority < PRIORITY.deferred || this.activeDeferred < 1;
      });
      if (nextIndex < 0) return;
      const [item] = this.queued.splice(nextIndex, 1);
      if (!item) return;
      this.active += 1;
      const isBackground = item.priority >= PRIORITY.background;
      const isDeferred = item.priority === PRIORITY.deferred;
      if (isBackground) this.activeBackground += 1;
      if (isDeferred) this.activeDeferred += 1;
      void this.load(item.url).then((loaded) => {
        if (loaded) this.loaded.add(item.url);
        if (this.pending.get(item.url)?.item === item) this.pending.delete(item.url);
        item.resolve(loaded);
      }).finally(() => {
        this.active -= 1;
        if (isBackground) this.activeBackground -= 1;
        if (isDeferred) this.activeDeferred -= 1;
        this.drain();
      });
    }
  }

  private async load(url: string): Promise<boolean> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await this.requestFetch(url, {
        credentials: "same-origin",
        signal: controller.signal
      });
      if (!response.ok) return false;
      return true;
    } catch {
      return false;
    } finally {
      this.controllers.delete(controller);
    }
  }

  dispose(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const item of this.queued.splice(0)) item.resolve(false);
    this.pending.clear();
    this.loaded.clear();
  }
}

export const resourceLoader = new ResourceLoader();
