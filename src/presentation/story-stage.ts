import type { StoryAction, StoryActorState, StoryStage, StoryTransform } from "../core/story/types";

export interface StoryFrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}

const browserFrames: StoryFrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id)
};

export function storyAbortError(): Error { return new DOMException("剧情表现已取消。", "AbortError"); }

/** A logical clock: resuming starts a new frame, without counting background time. */
export class StoryClock {
  private readonly tasks = new Set<(elapsed: number) => void>();
  private readonly pauses = new Set<string>();
  private frame?: number;
  private last?: number;
  private disposed = false;
  private playbackRate = 1;
  constructor(private readonly scheduler: StoryFrameScheduler = browserFrames) {}
  subscribe(task: (elapsed: number) => void): () => void {
    if (this.disposed) throw storyAbortError();
    this.tasks.add(task); this.schedule();
    return () => { this.tasks.delete(task); if (!this.tasks.size) this.stopFrame(); };
  }
  setPaused(reason: string, paused: boolean): void {
    if (paused) this.pauses.add(reason); else this.pauses.delete(reason);
    if (this.pauses.size) this.stopFrame(); else this.schedule();
  }
  setPlaybackRate(value: number): void { this.playbackRate = value; }
  get paused(): boolean { return this.pauses.size > 0; }
  private stopFrame(): void {
    if (this.frame !== undefined) this.scheduler.cancel(this.frame);
    this.frame = undefined; this.last = undefined;
  }
  private schedule(): void {
    if (this.disposed || this.pauses.size || !this.tasks.size || this.frame !== undefined) return;
    this.frame = this.scheduler.request(time => {
      this.frame = undefined;
      const elapsed = this.last === undefined ? 0 : Math.max(0, time - this.last);
      this.last = time;
      for (const task of [...this.tasks]) if (this.tasks.has(task)) task(elapsed * this.playbackRate);
      this.schedule();
    });
  }
  dispose(): void { this.disposed = true; this.stopFrame(); this.tasks.clear(); }
}

const transformKeys = ["x", "y", "scale", "rotation", "opacity"] as const;
export type StoryAudioAction = Extract<StoryAction, { type: "audio" }>;
export interface StoryPerformContext { readonly signal: AbortSignal; readonly skip: boolean; readonly restore?: boolean; readonly clock: StoryClock }
export interface StoryTimelineHost {
  getActor(id: string): StoryActorState | undefined;
  version?(): number;
  ensureActor?(id: string, signal: AbortSignal): Promise<StoryActorState | undefined>;
  patchActor(id: string, transform: StoryTransform): void;
  stage(action: Extract<StoryAction, { type: "stage" }>, signal: AbortSignal): void | Promise<void>;
  audio?(action: StoryAudioAction, context: StoryPerformContext): void | Promise<void>;
  extension?(action: Extract<StoryAction, { type: "extension" }>, context: StoryPerformContext): void | Promise<void>;
  reducedMotion?(): boolean;
}

function easing(value: number, name?: string): number {
  if (name === "ease-in") return value * value;
  if (name === "ease-out") return 1 - (1 - value) ** 2;
  if (name === "ease" || name === "ease-in-out") return value * value * (3 - 2 * value);
  return value;
}

/** Interpolate each property independently, including sparse keyframes. */
export function storyAnimationFrame(actor: StoryActorState, keyframes: Extract<StoryAction, { type: "animate" }>["keyframes"], progress: number): StoryTransform {
  const result: Record<string, number> = {};
  for (const property of transformKeys) {
    const frames = [{ offset: 0, value: actor[property] }];
    keyframes.forEach((frame, index) => {
      const value = frame[property];
      if (value !== undefined) frames.push({ offset: frame.offset ?? (keyframes.length === 1 ? 1 : index / (keyframes.length - 1)), value });
    });
    if (frames.length === 1) continue;
    let previous = frames[0];
    for (const frame of frames.slice(1)) {
      if (progress < frame.offset) {
        const fraction = frame.offset === previous.offset ? 1 : (progress - previous.offset) / (frame.offset - previous.offset);
        result[property] = previous.value + (frame.value - previous.value) * Math.max(0, fraction);
        break;
      }
      previous = frame;
    }
    result[property] ??= previous.value;
  }
  return result;
}

function writes(action: StoryAction): Set<string> {
  if (action.type === "parallel" || action.type === "sequence") return new Set(action.actions.flatMap(child => [...writes(child)]));
  if (action.type === "animate") return new Set(transformKeys.filter(key => action.keyframes.some(frame => frame[key] !== undefined)).map(key => `actor:${action.actor}:${key}`));
  if (action.type !== "stage") return new Set();
  const result = new Set<string>();
  if (action.background !== undefined) result.add("background");
  if (action.overlay !== undefined) result.add("overlay");
  for (const actor of action.actors ?? []) for (const key of Object.keys(actor)) if (key !== "id") result.add(`actor:${actor.id}:${key}`);
  for (const id of action.remove ?? []) result.add(`actor:${id}:*`);
  return result;
}

export function validateStoryParallel(action: StoryAction): void {
  if (action.type !== "sequence" && action.type !== "parallel") return;
  action.actions.forEach(validateStoryParallel);
  if (action.type !== "parallel") return;
  const occupied = new Set<string>();
  for (const child of action.actions) for (const property of writes(child)) {
    const actorPrefix = property.startsWith("actor:") ? property.slice(0, property.lastIndexOf(":")) : undefined;
    if (occupied.has(property) || (actorPrefix && (occupied.has(`${actorPrefix}:*`) || (property.endsWith(":*") && [...occupied].some(value => value.startsWith(`${actorPrefix}:`)))))) {
      throw new Error(`并行动画重复写入属性：${property}`);
    }
    occupied.add(property);
  }
}

/** Performs only presentation actions. Host commands never pass through this class. */
export class StoryTimeline {
  readonly clock: StoryClock;
  private fast = false;
  private readonly flushes = new Set<() => void>();
  private readonly lifetime = new AbortController();
  constructor(private readonly host: StoryTimelineHost, scheduler?: StoryFrameScheduler) { this.clock = new StoryClock(scheduler); }
  setFastForward(value: boolean): void {
    this.fast = value;
    if (value) for (const finish of [...this.flushes]) finish();
  }
  delay(durationMs: number, signal?: AbortSignal): Promise<void> { return this.tween(durationMs, () => {}, signal); }
  progress(durationMs: number, apply: (progress: number) => void, signal?: AbortSignal): Promise<void> { return this.tween(durationMs, apply, signal); }
  private tween(durationMs: number, apply: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    const scoped = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
    if (scoped.aborted) return Promise.reject(storyAbortError());
    if (this.fast || durationMs <= 0) { apply(1); return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      let elapsed = 0;
      let release: () => void = () => {};
      let done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true; release(); this.flushes.delete(skip);
        scoped.removeEventListener("abort", abort);
        if (error) reject(error); else { apply(1); resolve(); }
      };
      const skip = () => finish();
      const abort = () => finish(storyAbortError());
      this.flushes.add(skip); scoped.addEventListener("abort", abort, { once: true });
      apply(0);
      release = this.clock.subscribe(delta => {
        elapsed += delta;
        if (elapsed >= durationMs) finish(); else apply(elapsed / durationMs);
      });
    });
  }
  async perform(action: StoryAction, options: { readonly signal?: AbortSignal; readonly skip?: boolean; readonly restore?: boolean; readonly instant?: boolean } = {}): Promise<void> {
    validateStoryParallel(action);
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    await this.execute(action, signal, options.skip === true, options.restore === true, options.instant === true);
  }
  private async execute(action: StoryAction, signal: AbortSignal, skip: boolean, restore: boolean, instant: boolean): Promise<void> {
    if (signal.aborted) throw storyAbortError();
    const immediate = skip || this.fast;
    switch (action.type) {
      case "sequence":
        for (const child of action.actions) await this.execute(child, signal, skip, restore, instant);
        return;
      case "parallel": {
        const group = new AbortController();
        const scope = AbortSignal.any([signal, group.signal]);
        const pending = action.actions.map(child => this.execute(child, scope, skip, restore, instant));
        try { await Promise.all(pending); }
        catch (error) { group.abort(); await Promise.allSettled(pending); throw error; }
        return;
      }
      case "wait": if (!instant && !immediate) await this.delay(action.durationMs, signal); return;
      case "stage": await this.host.stage(action, signal); return;
      case "animate": {
        const actor = this.host.getActor(action.actor) ?? await this.host.ensureActor?.(action.actor, signal);
        if (!actor) throw new Error(`剧情动画角色不存在：${action.actor}`);
        const version = this.host.version?.();
        const initial = Object.fromEntries(transformKeys.filter(key => action.keyframes.some(frame => frame[key] !== undefined)).map(key => [key, actor[key]]));
        const final = () => this.host.patchActor(actor.id, storyAnimationFrame(actor, action.keyframes, 1));
        if (instant || immediate || this.host.reducedMotion?.()) { final(); return; }
        try {
          if (action.delayMs) await this.delay(action.delayMs, signal);
          await this.tween(action.durationMs, progress => this.host.patchActor(actor.id, storyAnimationFrame(actor, action.keyframes, easing(progress, action.easing))), signal);
        } catch (error) { if (version === this.host.version?.()) this.host.patchActor(actor.id, initial); throw error; }
        return;
      }
      case "audio":
        if (!this.host.audio) throw new Error("当前宿主未提供剧情音频适配器。");
        // Continue playing audio, but never hold the next dialogue for its duration.
        await this.host.audio(instant ? { ...action, wait: false, fadeMs: 0 } : action, { signal, skip: immediate, restore, clock: this.clock }); return;
      case "extension":
        if (!this.host.extension && action.required !== false) throw new Error(`剧情表现扩展不可用：${action.typeId}`);
        await this.host.extension?.(action, { signal, skip: instant || immediate, restore: !instant && restore, clock: this.clock }); return;
    }
  }
  dispose(): void { this.lifetime.abort(); this.clock.dispose(); this.flushes.clear(); }
}

export const defaultStoryActor = (id: string): StoryActorState => ({ id, visible: true, x: 50, y: 100, scale: 1, rotation: 0, opacity: 1, anchorX: 0.5, anchorY: 1, layer: 0 });

/** DOM uses textContent and CSS properties; content never becomes executable markup. */
export class StoryStageView {
  private snapshot: StoryStage = { overlay: 0.45, actors: {} };
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly resolved = new Map<string, string>();
  private readonly decoded = new Set<string>();
  private readonly aspects = new Map<string, number>();
  private revision = 0;
  private disposed = false;
  private focusActorId?: string;
  private foregroundActorId?: string;
  private authored = false;
  readonly backdrop: HTMLDivElement;
  readonly actors: HTMLDivElement;
  constructor(readonly element: HTMLElement, private readonly resolveAsset: (path: string) => string | Promise<string>, private readonly actorDefaults?: (id: string) => Partial<StoryActorState>) {
    this.backdrop = element.ownerDocument.createElement("div"); this.backdrop.className = "story-stage-background";
    this.actors = element.ownerDocument.createElement("div"); this.actors.className = "story-stage-actors";
    element.append(this.backdrop, this.actors);
  }
  /** Composition is a view projection; it never changes the authored/checkpointed stage. */
  setComposition(focusActorId?: string, ambient = false, authored = false, foregroundActorId = focusActorId): void {
    this.focusActorId = focusActorId; this.foregroundActorId = foregroundActorId; this.authored = authored;
    this.actors.dataset.layout = authored ? "authored" : "auto";
    this.actors.dataset.composition = focusActorId ? "dialogue" : ambient ? "atmosphere" : "stage";
    this.renderActors();
  }
  getActor = (id: string): StoryActorState | undefined => Object.hasOwn(this.snapshot.actors, id) ? this.snapshot.actors[id] : undefined;
  version = (): number => this.revision;
  ensureActor = async (id: string, signal: AbortSignal): Promise<StoryActorState | undefined> => {
    if (!this.getActor(id)) await this.apply({ type: "stage", actors: [{ id }] }, signal);
    return this.getActor(id);
  };
  patchActor = (id: string, transform: StoryTransform): void => {
    const actor = this.getActor(id); if (!actor) return;
    this.snapshot = { ...this.snapshot, actors: { ...this.snapshot.actors, [id]: { ...actor, ...transform } } };
    const visible = Object.values(this.snapshot.actors).filter(candidate => candidate.visible && candidate.image);
    this.renderActor(this.snapshot.actors[id], visible.findIndex(candidate => candidate.id === id), visible.length);
  };
  private async preload(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    const loading = Promise.all([...new Set(paths)].map(async path => {
      const url = this.resolved.get(path) ?? await this.resolveAsset(path);
      if (!this.decoded.has(url)) {
        const image = this.element.ownerDocument.createElement("img");
        try {
          if (typeof image.decode === "function") { image.src = url; await image.decode(); }
          else await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("图片解码失败")); image.src = url; });
        } catch { throw new Error(`剧情图片无法加载：${path}`); }
        if (!this.disposed) {
          this.decoded.add(url);
          this.aspects.set(url, image.naturalWidth / image.naturalHeight);
        }
      }
      return [path, url] as const;
    }));
    const resources = signal ? await new Promise<Awaited<typeof loading>>((resolve, reject) => {
      const abort = () => reject(storyAbortError());
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      loading.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
    }) : await loading;
    if (this.disposed || signal?.aborted) throw storyAbortError();
    for (const [path, url] of resources) this.resolved.set(path, url);
  }
  async hydrate(stage: StoryStage, signal?: AbortSignal): Promise<void> {
    const revision = ++this.revision;
    const paths = [...new Set([stage.background, ...Object.values(stage.actors).map(actor => actor.image)].filter((path): path is string => typeof path === "string"))];
    await this.preload(paths, signal);
    if (this.disposed || signal?.aborted || revision !== this.revision) return;
    this.commit(stage);
  }
  private commit(stage: StoryStage): void {
    this.snapshot = structuredClone(stage);
    // Empty stages inherit the host's menu background without changing the story checkpoint.
    this.backdrop.style.backgroundImage = stage.background ? `url(${JSON.stringify(this.resolved.get(stage.background))})` : "";
    this.element.style.setProperty("--story-overlay", String(stage.overlay));
    for (const [id, image] of this.images) if (!Object.hasOwn(stage.actors, id)) { image.remove(); this.images.delete(id); }
    this.renderActors();
  }
  async apply(action: Extract<StoryAction, { type: "stage" }>, signal: AbortSignal): Promise<void> {
    const declarations = (action.actors ?? []).map(actor => ({ ...(!this.getActor(actor.id) ? this.actorDefaults?.(actor.id) : {}), ...actor }));
    await this.preload([action.background, ...declarations.map(actor => actor.image)].filter((path): path is string => typeof path === "string"), signal);
    const actors = { ...this.snapshot.actors };
    for (const id of action.remove ?? []) delete actors[id];
    for (const actor of declarations) actors[actor.id] = { ...(Object.hasOwn(actors, actor.id) ? actors[actor.id] : defaultStoryActor(actor.id)), ...actor };
    this.commit({ ...this.snapshot, ...(action.background !== undefined ? { background: action.background } : {}), ...(action.overlay !== undefined ? { overlay: action.overlay } : {}), actors });
    if (signal.aborted) throw storyAbortError();
  }
  private renderActors(): void {
    const visible = Object.values(this.snapshot.actors).filter(actor => actor.visible && actor.image);
    this.actors.dataset.actorCount = String(visible.length);
    this.actors.style.setProperty("--story-actor-width", `${visible.length <= 1 ? 144 : visible.length === 2 ? 106 : 180 / (visible.length + 1)}%`);
    this.actors.style.setProperty("--story-portrait-width", `${visible.length <= 1 ? 144 : visible.length === 2 ? 124 : 180 / (visible.length + 1)}%`);
    const indexes = new Map(visible.map((actor, index) => [actor.id, index]));
    Object.values(this.snapshot.actors).forEach(actor => this.renderActor(actor, indexes.get(actor.id) ?? -1, visible.length));
  }
  private renderActor(actor: StoryActorState, index: number, count: number): void {
    let image = this.images.get(actor.id);
    if (!image) {
      image = this.element.ownerDocument.createElement("img"); image.className = "story-actor";
      image.dataset.storyActor = actor.id; image.alt = ""; image.draggable = false;
      this.images.set(actor.id, image); this.actors.append(image);
    }
    const url = actor.image ? this.resolved.get(actor.image) : undefined;
    image.dataset.framing = url && (this.aspects.get(url) ?? 1) < 1 ? "portrait" : "wide";
    if (url && image.getAttribute("src") !== url) image.src = url;
    if (!url) image.removeAttribute("src");
    image.hidden = !actor.visible || !url;
    const focused = this.focusActorId === actor.id;
    image.dataset.focused = String(focused);
    const foreground = this.foregroundActorId === actor.id;
    image.dataset.foreground = String(foreground);
    if (this.authored) {
      image.style.left = `${actor.x}%`; image.style.top = `${actor.y}%`; image.style.bottom = "auto";
      image.style.transform = `translate(${-actor.anchorX * 100}%, ${-actor.anchorY * 100}%) rotate(${actor.rotation}deg) scale(${actor.scale})`;
      image.style.transformOrigin = `${actor.anchorX * 100}% ${actor.anchorY * 100}%`;
    } else {
      const x = count === 2 ? index === 0 ? 35 : 65 : (index + 1) * 100 / (count + 1);
      image.style.left = `${x}%`; image.style.top = "auto"; image.style.removeProperty("bottom");
      image.style.transform = `translateX(-50%) scale(${actor.scale})`; image.style.transformOrigin = "center bottom";
    }
    image.style.opacity = String(actor.opacity);
    // Foreground emphasis is a view projection over the saved recent speaker.
    image.style.zIndex = String(foreground
      ? Math.max(...Object.values(this.snapshot.actors).map(candidate => candidate.layer)) + 1
      : actor.layer);
  }
  dispose(): void { this.disposed = true; ++this.revision; this.images.clear(); this.resolved.clear(); this.decoded.clear(); this.aspects.clear(); this.element.replaceChildren(); }
}
