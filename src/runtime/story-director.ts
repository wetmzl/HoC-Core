import { createMatchFactBatch, type MatchFactBatch } from "../core/events";
import { createPublicEventBatch, matchPublicEventBatch, type PublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import { capturePublicMatchReadModel } from "../core/events/public-match-read-model";
import { STORY_LIMITS } from "../core/story/schema";
import { selectPublicTriggerEvents, evaluatePublicCondition } from "../core/events/triggers";
import type { StoryAction, StoryBinding, StoryCommandIntent, StoryEngineContext, StoryRun, StoryScene } from "../core/story/types";
import { createStoryRun, advanceStory, chooseStory, skipStory, acknowledgeStoryCommand, interruptStory, retryStory } from "../core/story/engine";
import type { CheckpointSaveRepository, SaveCheckpointContext } from "../persistence/repository";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import type { RuntimeSave } from "../persistence/schema";
import { emptyStorySave, validateStorySave, StoryRequestSchema, STORY_SAVE_LIMITS, type StoryDiagnostic, type StoryPlayback, type StoryRequest, type StorySave } from "./story-checkpoint";

export interface StorySceneEntry { readonly id: string; readonly packageId: string; readonly digest: string; readonly definition: StoryScene }
export interface StoryBindingEntry { readonly id: string; readonly packageId: string; readonly digest: string; readonly definition: StoryBinding }
export interface StoryCatalog { readonly scenes: readonly StorySceneEntry[]; readonly bindings: readonly StoryBindingEntry[] }
export interface StoryDirectorState {
  readonly save: StorySave;
  readonly run: StoryRun | null;
  readonly request: StoryRequest | null;
  readonly blocking: boolean;
  readonly blocked: boolean;
  readonly error?: string;
  readonly diagnostics: readonly StoryDiagnostic[];
}
export interface StoryDirectorDependencies {
  readonly repository: CheckpointSaveRepository;
  readonly catalog: () => StoryCatalog;
  readonly engineContext?: () => Omit<StoryEngineContext, "resolveScene">;
  readonly scopes?: () => PublicEventScopes;
  readonly onBlockingChange?: (blocking: boolean) => void;
  readonly onDiagnostic?: (diagnostic: StoryDiagnostic) => void;
  /** Publishes a command checkpoint to its existing game/flow state owner after successful storage. */
  readonly onSnapshotCommitted?: (snapshot: RawSaveSnapshot, publicEvents?: readonly PublicEventBatch[]) => void | Promise<void>;
  /** Pure host projection; no irreversible effect may run before this snapshot commits. */
  readonly projectCommand?: (intent: StoryCommandIntent, snapshot: RawSaveSnapshot, request: StoryRequest) => RawSaveSnapshot | { readonly snapshot: RawSaveSnapshot; readonly publicEvents?: readonly PublicEventBatch[] };
  readonly perform?: (action: StoryAction, context: { readonly signal: AbortSignal; readonly skip: boolean; readonly restore?: boolean }) => Promise<void>;
}
const terminal = (run: StoryRun): boolean => ["completed", "skipped", "interrupted"].includes(run.status);

/** Durable inbox, content pinning and semantic playback. No DOM, timers or game-state ownership. */
export class StoryDirector {
  private save = emptyStorySave();
  private snapshot: RawSaveSnapshot = { longTerm: null, runtime: null };
  private pending: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(state: StoryDirectorState) => void>();
  private readonly reservations = new Map<string, StoryRequest>();
  private readonly reservationOnce = new Map<string, string>();
  private readonly transientBatches = new Map<string, PublicEventBatch>();
  private error?: string;
  private blocked = false;
  private blocking = false;
  private ready = false;
  private playbackDeferred = false;
  private closed = false;
  private presentation?: { key: string; controller: AbortController };
  private restorePresentation?: string;
  private readonly unsubscribe: (() => void)[];
  private readonly notifiedDiagnostics = new Set<string>();

  constructor(private readonly dependencies: StoryDirectorDependencies) {
    this.unsubscribe = [dependencies.repository.addCheckpointProjector((previous, next, context) => this.project(previous, next, context)),
      dependencies.repository.subscribeCheckpoints(snapshot => this.hydrate(snapshot))];
    const failure = dependencies.repository.subscribeCheckpointFailures?.(error => {
      if (!this.closed && (this.run || this.reservations.size)) {
        this.error = error instanceof Error ? error.message : String(error); this.emit();
      }
    });
    if (failure) this.unsubscribe.push(failure);
  }
  get run(): StoryRun | null { return this.save.active?.run ?? null; }
  get state(): StoryDirectorState { return { save: this.save, run: this.run, request: this.save.active?.request ?? null,
    blocking: this.blocking, blocked: this.blocked, diagnostics: this.save.diagnostics ?? [], ...(this.error ? { error: this.error } : {}) }; }
  subscribe(listener: (state: StoryDirectorState) => void): () => void { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }
  async initialize(options: { readonly deferPlayback?: boolean } = {}): Promise<void> {
    this.playbackDeferred = options.deferPlayback === true;
    this.hydrate(await this.dependencies.repository.readSnapshot());
    if (this.run?.waiting?.type === "presentation") this.restorePresentation = `${this.run.id}:${this.run.sequence}`;
    this.ready = true;
    await this.serial(() => this.drain());
  }
  resumePlayback(): Promise<void> { this.playbackDeferred = false; return this.serial(() => this.drain()); }
  private emit(): void {
    const validActive = this.save.active && !this.contentError(this.save.active.request) && !this.blocked && this.run?.status !== "failed";
    const validPending = this.save.queue.some(request => !this.contentError(request) && this.scopeValid(request));
    const blocking = !this.closed && !this.blocked && !this.save.suspended && Boolean(validActive || validPending || this.reservations.size);
    if (blocking !== this.blocking) { this.blocking = blocking; this.dependencies.onBlockingChange?.(blocking); }
    for (const listener of this.listeners) { try { listener(this.state); } catch { /* A view cannot abort an owner checkpoint. */ } }
  }
  private hydrate(snapshot: RawSaveSnapshot): void {
    if (this.closed) return;
    this.snapshot = snapshot;
    try {
      this.save = validateStorySave(snapshot.story);
      for (const id of this.save.seen) this.reservations.delete(id);
      for (const [id, once] of this.reservationOnce) if (this.save.once.includes(once)) { this.reservations.delete(id); this.reservationOnce.delete(id); }
      for (const diagnostic of this.save.diagnostics ?? []) {
        this.reservations.delete(diagnostic.id); this.reservationOnce.delete(diagnostic.id);
        const key = `${diagnostic.id}:${diagnostic.code}`;
        if (!this.notifiedDiagnostics.has(key)) {
          this.notifiedDiagnostics.add(key); this.dependencies.onDiagnostic?.(diagnostic);
          if (this.notifiedDiagnostics.size > STORY_SAVE_LIMITS.diagnostics * 2) this.notifiedDiagnostics.delete(this.notifiedDiagnostics.values().next().value!);
        }
      }
      this.error = this.save.active ? this.contentError(this.save.active.request) ?? this.playbackError(this.save.active) : undefined;
      this.blocked = Boolean(this.error);
    } catch (error) { this.blocked = true; this.error = error instanceof Error ? error.message : String(error); }
    if (this.presentation && (this.blocked || this.save.suspended || !this.run || this.presentation.key !== `${this.run.id}:${this.run.sequence}`)) {
      this.presentation.controller.abort(); this.presentation = undefined;
    }
    this.emit();
    if (this.ready) void this.serial(() => this.drain()).catch(() => undefined);
  }
  private serial(operation: () => void | Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const result = this.pending.catch(() => undefined).then(operation);
    this.pending = result.catch(error => { this.error = error instanceof Error ? error.message : String(error); this.emit(); });
    return result;
  }
  private scene(id: string): StorySceneEntry | undefined { return this.dependencies.catalog().scenes.find(entry => entry.id === id); }
  private sources(sceneId: string): Readonly<Record<string, string>> {
    const sources: Record<string, string> = {}, visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return; visited.add(id);
      const scene = this.scene(id);
      if (!scene) throw new Error(`剧情片段缺失：${id}`);
      sources[scene.id] = scene.digest;
      for (const node of scene.definition.nodes) if (node.type === "call") visit(node.sceneId);
    };
    visit(sceneId); return sources;
  }
  private contentError(request: StoryRequest): string | undefined {
    if (!this.scene(request.sceneId)) return `剧情内容包未启用或缺失：${request.packageId}`;
    const scenes = this.dependencies.catalog().scenes;
    for (const [id, digest] of Object.entries(request.sources))
      if (!scenes.some(scene => scene.id === id && scene.digest === digest)) return `剧情内容版本已改变：${id}；已保留播放进度`;
    return undefined;
  }
  private playbackError(playback: StoryPlayback): string | undefined {
    const { request, run } = playback;
    if (!Object.hasOwn(request.sources, run.sceneId) || run.stack.some(frame => !Object.hasOwn(request.sources, frame.sceneId)
      || !this.scene(frame.sceneId)?.definition.nodes.some(node => node.id === frame.cursor))) return "剧情调用检查点与固定内容来源不一致";
    const node = this.scene(run.sceneId)?.definition.nodes.find(node => node.id === run.cursor);
    if (!node) return "剧情检查点节点已不存在";
    const waiting = run.waiting;
    if (!waiting) return undefined;
    const expected = node.type === "present" ? "presentation" : node.type;
    if (waiting.type !== expected || waiting.node.type !== node.type || "next" in node && (!('next' in waiting.node) || node.next !== waiting.node.next))
      return "剧情等待节点与固定内容声明不一致";
    if (waiting.type === "presentation" && node.type === "present" && JSON.stringify(waiting.action) !== JSON.stringify(node.action)) return "剧情表现检查点与声明不一致";
    if (waiting.type === "choice" && node.type === "choice") {
      const paths = (options: typeof node.options) => options.map(option => ({ id: option.id, next: option.next, when: option.when, enabledWhen: option.enabledWhen }));
      if (JSON.stringify(paths(waiting.node.options)) !== JSON.stringify(paths(node.options))) return "剧情选项检查点与声明不一致";
    }
    if (waiting.type === "command" && node.type === "command") {
      const { id, ...command } = waiting.intent;
      if (id !== `${run.id}:${run.sequence}:${run.sceneId}:${node.id}` || JSON.stringify(command) !== JSON.stringify(node.command)
        || JSON.stringify(waiting.node.command) !== JSON.stringify(node.command) || waiting.node.onSkip !== node.onSkip || run.receipts.some(receipt => receipt.id === id))
        return "剧情命令检查点与声明或执行回执不一致";
    }
    return undefined;
  }
  private scopeValid(request: StoryRequest, snapshot = this.snapshot): boolean {
    const runtime = snapshot.runtime as RuntimeSave | null;
    if (request.scope === "match") return Boolean(request.scopes.match && runtime?.activeMatch?.id === request.scopes.match);
    if (request.scope === "flow") {
      const id = runtime?.activeProgram?.id ?? runtime?.activeFlow?.id;
      return Boolean(request.scopes.program && id === request.scopes.program);
    }
    return true;
  }
  private context(request: StoryRequest, checkpoint?: RawSaveSnapshot): StoryEngineContext {
    const engine = this.dependencies.engineContext?.();
    const live = engine?.publicContext;
    let batch = request.event ? createPublicEventBatch({ ...request.event,
      context: live?.batch?.context ?? request.event.context }) : live?.batch;
    let match = live?.match, matchQueries = live?.matchQueries;
    if (checkpoint) {
      const runtime = checkpoint.runtime as RuntimeSave | null;
      const run = runtime?.activeProgram;
      match = runtime?.activeMatch ?? undefined;
      matchQueries = match ? capturePublicMatchReadModel(match) : undefined;
      const { match: _match, matchQueries: _queries, program: _program, ...context } = batch?.context ?? {};
      void _match; void _queries; void _program;
      batch = createPublicEventBatch({ id: batch?.id ?? "story-command-checkpoint", facts: batch?.facts ?? [], context: { ...context,
        ...(match ? { match, matchQueries } : {}),
        ...(run ? { program: { id: run.id, definitionId: run.definition.id, nodeId: run.cursor, visitIndex: run.visitIndex, status: run.status } } : {}) } });
    }
    return { ...engine, publicContext: { ...live, match, matchQueries, ...(batch ? { batch } : {}), ...(request.event ? { event: request.event.facts[0] } : {}) },
      resolveScene: id => this.scene(id)?.definition };
  }
  private admissionError(save: StorySave, request: StoryRequest, queue: readonly StoryRequest[], once?: string): StoryDiagnostic | undefined {
    const base = { id: request.id.slice(0, 1024), sceneId: request.sceneId.slice(0, 1024) };
    if (queue.length >= STORY_SAVE_LIMITS.queue) return { ...base, code: "queue-full", message: `剧情待播队列已达 ${STORY_SAVE_LIMITS.queue} 项，本次请求未入队` };
    if (save.seen.length >= STORY_SAVE_LIMITS.ledger || save.once.length >= STORY_SAVE_LIMITS.ledger
      || save.completed.length + save.queue.length + (save.active ? 1 : 0) >= STORY_SAVE_LIMITS.ledger)
      return { ...base, code: "ledger-full", message: "剧情进度记录已达容量，本次请求未入队" };
    if (once && once.length > 1024 || !StoryRequestSchema.safeParse(request).success) return { ...base, code: "request-invalid", message: "剧情请求超出身份、结构或上下文预算，本次请求未入队" };
    return undefined;
  }
  private diagnose(save: StorySave, diagnostic: StoryDiagnostic): StorySave {
    const existing = (save.diagnostics ?? []).filter(item => item.id !== diagnostic.id);
    return { ...save, diagnostics: [...existing, diagnostic].slice(-STORY_SAVE_LIMITS.diagnostics) };
  }
  private matches(save: StorySave, batch: PublicEventBatch): { request: StoryRequest; once?: string; queue: StoryBinding["queue"] }[] {
    const matches: { request: StoryRequest; once?: string; queue: StoryBinding["queue"] }[] = [];
    for (const binding of this.dependencies.catalog().bindings) {
      for (const event of selectPublicTriggerEvents(binding.definition.trigger, batch)) {
        const frequency = binding.definition.frequency ?? "always";
        const scopeName = frequency === "flow" ? "program" : frequency;
        const frequencyId = frequency === "save" ? "save" : frequency === "always" ? event.id : event.scopes[scopeName as keyof PublicEventScopes];
        if (!frequencyId) continue;
        const once = frequency === "always" ? undefined : JSON.stringify([binding.id, frequency, frequencyId]);
        const id = JSON.stringify([binding.id, event.id]);
        if (save.seen.includes(id) || once && save.once.includes(once) || matches.some(match => match.request.id === id || once && match.once === once)) continue;
        const scene = this.scene(binding.definition.sceneId);
        if (!scene) continue;
        let sources: Readonly<Record<string, string>>;
        try { sources = this.sources(scene.id); } catch { continue; }
        // Trigger matching used the complete authoritative source above. Persist only
        // occurrence data and compact semantic context; live gameplay queries come
        // from the host rather than duplicating the full table/history per request.
        const { match: _match, ...compactContext } = batch.context ?? {};
        void _match;
        matches.push({ request: { id, sceneId: scene.id, packageId: scene.packageId, digest: scene.digest, sources,
          bindingId: binding.id, scopes: event.scopes, scope: binding.definition.scope ?? "global", priority: binding.definition.priority ?? 0,
          order: save.sequence + matches.length + 1, event: JSON.parse(JSON.stringify({ ...batch, facts: [event], context: compactContext })) as PublicEventBatch,
          recheck: binding.definition.recheck }, once, queue: binding.definition.queue });
      }
    }
    return matches;
  }
  private acceptInto(save: StorySave, batch: PublicEventBatch): StorySave {
    let next = save;
    for (const match of this.matches(save, batch)) {
      if (match.queue === "drop-if-busy" && (next.active || next.queue.length)) continue;
      const queue = match.queue === "replace-pending" ? next.queue.filter(request => request.bindingId !== match.request.bindingId) : next.queue;
      const diagnostic = this.admissionError(next, match.request, queue, match.once);
      if (diagnostic) { next = this.diagnose(next, diagnostic); continue; }
      next = { ...next, sequence: Math.max(next.sequence, match.request.order), queue: [...queue, match.request].sort((a, b) => b.priority - a.priority || a.order - b.order),
        once: match.once ? [...next.once, match.once] : next.once, seen: [...next.seen, match.request.id] };
    }
    return next;
  }
  private project(previous: RawSaveSnapshot, next: RawSaveSnapshot, context: SaveCheckpointContext): RawSaveSnapshot {
    if (context.storyOnly || this.closed) return next;
    let save: StorySave;
    try { save = validateStorySave(next.story); } catch { return next; }
    const batches = [...(context.publicEvents ?? [])];
    const before = (previous.runtime as RuntimeSave | null)?.activeMatch, after = (next.runtime as RuntimeSave | null)?.activeMatch;
    if (after && after !== before) {
      const program = (next.runtime as RuntimeSave | null)?.activeProgram?.id ?? (next.runtime as RuntimeSave | null)?.activeFlow?.id;
      const scopes = { ...this.dependencies.scopes?.(), ...(program ? { program } : {}) };
      batches.push(matchPublicEventBatch(createMatchFactBatch(before?.id === after.id ? before : undefined, after), scopes));
    }
    const original = save;
    for (const batch of batches) save = this.acceptInto(save, batch);
    if (save === original) return next;
    try { return { ...next, story: validateStorySave(save) }; }
    catch {
      // A content request must not make an otherwise valid gameplay save fail.
      return { ...next, story: validateStorySave(this.diagnose(original, { id: batches[0]?.id.slice(0, 1024) ?? "story-source",
        sceneId: "story-source", code: "request-invalid", message: "剧情请求超过存档预算，已保留原剧情检查点" })) };
    }
  }
  /** Called synchronously during resolved delivery, before AI/automatic navigation can continue. */
  reserve(batch: PublicEventBatch): void {
    if (this.closed || this.blocked || this.save.suspended) return;
    for (const match of this.matches(this.save, batch)) {
      if (match.queue === "drop-if-busy" && (this.save.active || this.save.queue.length || this.reservations.size)) continue;
      if (match.once && [...this.reservationOnce.values()].includes(match.once)) continue;
      const queue = [...this.save.queue, ...this.reservations.values()].filter(request => match.queue !== "replace-pending" || request.bindingId !== match.request.bindingId);
      if (this.admissionError(this.save, match.request, queue, match.once)) continue;
      this.reservations.set(match.request.id, match.request);
      if (match.once) this.reservationOnce.set(match.request.id, match.once);
    }
    this.emit();
  }
  /** Transient shell events have no gameplay checkpoint; durable match/flow events use the projector. */
  accept(batch: PublicEventBatch): Promise<void> {
    this.reserve(batch);
    this.transientBatches.set(batch.id, batch);
    return this.serial(async () => {
      await this.dependencies.repository.projectSnapshot(snapshot => ({ ...snapshot, story: validateStorySave(this.acceptInto(validateStorySave(snapshot.story), batch)) }), { storyOnly: true });
      this.transientBatches.delete(batch.id);
      await this.drain();
    });
  }
  enqueue(sceneId: string, options: { readonly id?: string; readonly scopes?: PublicEventScopes; readonly priority?: number; readonly scope?: StoryRequest["scope"] } = {}): Promise<void> {
    return this.serial(async () => {
      const scene = this.scene(sceneId);
      if (!scene) throw new Error(`剧情片段缺失：${sceneId}`);
      await this.dependencies.repository.projectSnapshot(snapshot => {
        const save = validateStorySave(snapshot.story), id = options.id ?? `story:${save.sequence + 1}:${sceneId}`;
        if (save.seen.includes(id)) return snapshot;
        const request: StoryRequest = { id, sceneId, packageId: scene.packageId, digest: scene.digest, sources: this.sources(sceneId),
          scopes: options.scopes ?? this.dependencies.scopes?.() ?? {}, scope: options.scope ?? "global", priority: options.priority ?? 0, order: save.sequence + 1 };
        const diagnostic = this.admissionError(save, request, save.queue);
        if (diagnostic) throw new Error(diagnostic.message);
        return { ...snapshot, story: validateStorySave({ ...save, sequence: request.order, queue: [...save.queue, request].sort((a, b) => b.priority - a.priority || a.order - b.order), seen: [...save.seen, id] }) };
      }, { storyOnly: true });
      await this.drain();
    });
  }
  private async persist(active: StoryPlayback | null, queue = this.save.queue): Promise<void> {
    await this.dependencies.repository.projectSnapshot(snapshot => ({ ...snapshot, story: validateStorySave({ ...validateStorySave(snapshot.story), active, queue } satisfies StorySave) }), { storyOnly: true });
  }
  private async drain(): Promise<void> {
    if (!this.ready || this.playbackDeferred || this.closed || this.blocked || this.save.suspended) return;
    let commands = 0;
    const commandBudget = Math.max(1, Math.min(this.dependencies.engineContext?.().stepBudget ?? STORY_LIMITS.automaticSteps, STORY_LIMITS.automaticSteps));
    while (!this.closed) {
      if (!this.save.active) {
        const request = this.save.queue.find(request => !this.contentError(request));
        if (!request) {
          if (this.save.queue.length) { this.error = this.contentError(this.save.queue[0]); this.blocked = Boolean(this.error); }
          this.emit(); return;
        }
        if (!this.scopeValid(request)) { await this.persist(null, this.save.queue.filter(item => item.id !== request.id)); continue; }
        const binding = request.bindingId && this.dependencies.catalog().bindings.find(item => item.id === request.bindingId);
        if (request.recheck && binding && binding.definition.trigger.when
          && evaluatePublicCondition(binding.definition.trigger.when, this.context(request).publicContext ?? {}) !== true) {
          await this.persist(null, this.save.queue.filter(item => item.id !== request.id)); continue;
        }
        const run = createStoryRun(request.sceneId, this.context(request), { id: request.id });
        await this.persist({ request, run }, this.save.queue.filter(item => item.id !== request.id));
      }
      const active = this.save.active;
      if (!active) continue;
      const playbackError = this.contentError(active.request) ?? this.playbackError(active);
      if (playbackError) { this.blocked = true; this.error = playbackError; this.emit(); return; }
      if (!this.scopeValid(active.request)) { await this.finish(interruptStory(active.run)); continue; }
      if (terminal(active.run)) { await this.finish(active.run); continue; }
      if (active.run.status === "failed") { this.error = active.run.error ?? "剧情执行失败"; this.blocked = true; this.emit(); return; }
      const waiting = active.run.waiting;
      if (waiting?.type === "command") {
        if (++commands > commandBudget) {
          const error = "剧情连续命令超过推进预算，请检查命令循环";
          await this.persist({ ...active, run: { ...active.run, status: "failed", error } });
          this.error = error; this.blocked = true; this.emit(); return;
        }
        if (!this.dependencies.projectCommand) { this.error = `剧情命令不可用：${waiting.intent.type}`; this.blocked = true; this.emit(); return; }
        let publicEvents: readonly PublicEventBatch[] | undefined;
        const commandEvents: PublicEventBatch[] = [], matchFacts: MatchFactBatch[] = [];
        const checkpoint = await this.dependencies.repository.projectSnapshot(snapshot => {
          const save = validateStorySave(snapshot.story), current = save.active;
          if (!current || current.run.id !== active.run.id || current.run.sequence !== active.run.sequence) throw new Error("剧情检查点已改变");
          const result = this.dependencies.projectCommand!(waiting.intent, snapshot, current.request);
          const projected = "snapshot" in result ? result.snapshot : result;
          publicEvents = "snapshot" in result ? result.publicEvents : undefined;
          commandEvents.push(...publicEvents ?? []);
          const before = (snapshot.runtime as RuntimeSave | null)?.activeMatch;
          const after = (projected.runtime as RuntimeSave | null)?.activeMatch;
          if (after && after !== before) matchFacts.push(createMatchFactBatch(before?.id === after.id ? before : undefined, after));
          let nextSave = save;
          if ("snapshot" in result) for (const batch of result.publicEvents ?? []) nextSave = this.acceptInto(nextSave, batch);
          const run = acknowledgeStoryCommand(current.run, { id: waiting.intent.id }, this.context(current.request, projected));
          return { ...projected, story: validateStorySave({ ...nextSave, active: { ...current, run } } satisfies StorySave) };
        }, { publicEvents: commandEvents, matchFacts });
        await this.dependencies.onSnapshotCommitted?.(checkpoint, publicEvents);
        continue;
      }
      if (waiting?.type === "presentation") this.present(active, waiting.action);
      this.emit(); return;
    }
  }
  private present(active: StoryPlayback, action: StoryAction): void {
    const key = `${active.run.id}:${active.run.sequence}`;
    if (this.presentation?.key === key) return;
    this.presentation?.controller.abort();
    const controller = new AbortController(); this.presentation = { key, controller };
    const restore = this.restorePresentation === key;
    this.restorePresentation = undefined;
    const perform = this.dependencies.perform?.(action, { signal: controller.signal, skip: active.run.skipping || restore, ...(restore ? { restore: true } : {}) }) ?? Promise.resolve();
    void perform.then(() => {
      if (controller.signal.aborted || this.closed) return;
      return this.serial(async () => {
        if (this.run?.id !== active.run.id || this.run.sequence !== active.run.sequence) return;
        this.presentation = undefined;
        await this.persist({ ...active, run: advanceStory(active.run, this.context(active.request)) });
        await this.drain();
      });
    }).catch(error => {
      if (!controller.signal.aborted) { this.presentation = undefined; this.error = error instanceof Error ? error.message : String(error); this.blocked = true; this.emit(); }
    });
  }
  private async finish(run: StoryRun): Promise<void> {
    this.presentation?.controller.abort(); this.presentation = undefined;
    await this.dependencies.repository.projectSnapshot(snapshot => {
      const save = validateStorySave(snapshot.story), request = save.active?.request;
      return request ? { ...snapshot, story: validateStorySave({ ...save, active: null, completed: [...save.completed,
        { id: request.id, sceneId: request.sceneId, status: run.status, choices: run.choices, variables: run.variables, receipts: run.receipts,
          ...(run.result !== undefined ? { result: run.result } : {}) }] } satisfies StorySave) } : snapshot;
    }, { storyOnly: true });
  }
  private transition(update: (run: StoryRun, context: StoryEngineContext) => StoryRun, allowMissing = false): Promise<void> {
    const expected = this.run;
    return this.serial(async () => {
      const active = this.save.active;
      if (!active || active.run !== expected && (active.run.id !== expected?.id || active.run.sequence !== expected.sequence)) return;
      if (!allowMissing && this.contentError(active.request)) throw new Error(this.contentError(active.request));
      this.presentation?.controller.abort(); this.presentation = undefined;
      const run = update(active.run, this.context(active.request));
      if (run === active.run) return;
      if (terminal(run)) await this.finish(run);
      else await this.persist({ ...active, run });
      this.error = undefined; this.blocked = false;
      await this.drain();
    });
  }
  advance(): Promise<void> { return this.transition(advanceStory); }
  choose(optionId: string): Promise<void> { return this.transition((run, context) => chooseStory(run, optionId, context)); }
  skip(): Promise<void> { this.presentation?.controller.abort(); return this.transition(skipStory); }
  cancel(): Promise<void> {
    this.presentation?.controller.abort();
    if (!this.run) return this.serial(async () => {
      this.reservations.clear(); this.reservationOnce.clear(); this.transientBatches.clear(); this.error = undefined; this.blocked = false;
      const invalid = this.save.queue.find(request => this.contentError(request));
      if (invalid) await this.dependencies.repository.projectSnapshot(snapshot => {
        const save = validateStorySave(snapshot.story);
        return { ...snapshot, story: validateStorySave({ ...save, queue: save.queue.filter(request => request.id !== invalid.id), completed: [...save.completed,
          { id: invalid.id, sceneId: invalid.sceneId, status: "interrupted" }] } satisfies StorySave) };
      }, { storyOnly: true });
      await this.drain();
      this.emit();
    });
    return this.transition(interruptStory, true);
  }
  discard(): Promise<void> { return this.cancel(); }
  cancelRequest(id: string): Promise<void> {
    if (this.run?.id === id) { this.presentation?.controller.abort(); this.presentation = undefined; }
    this.reservations.delete(id);
    this.reservationOnce.delete(id);
    return this.serial(async () => {
      const active = this.save.active;
      if (active?.request.id === id) {
        await this.finish(interruptStory(active.run));
      } else {
        await this.dependencies.repository.projectSnapshot(snapshot => {
          const save = validateStorySave(snapshot.story), request = save.queue.find(request => request.id === id);
          return request ? { ...snapshot, story: validateStorySave({ ...save, queue: save.queue.filter(request => request.id !== id), completed: [...save.completed,
            { id, sceneId: request.sceneId, status: "interrupted" }] } satisfies StorySave) } : snapshot;
        }, { storyOnly: true });
      }
      this.error = undefined; this.blocked = false;
      await this.drain();
    });
  }
  suspend(): Promise<void> {
    this.presentation?.controller.abort(); this.presentation = undefined;
    return this.serial(async () => {
      await this.dependencies.repository.projectSnapshot(snapshot => ({ ...snapshot, story: validateStorySave({ ...validateStorySave(snapshot.story), suspended: true } satisfies StorySave) }), { storyOnly: true });
      this.emit();
    });
  }
  retry(): Promise<void> { return this.serial(async () => {
    this.error = undefined; this.blocked = false; this.hydrate(await this.dependencies.repository.readSnapshot());
    if (this.transientBatches.size) {
      const batches = [...this.transientBatches.values()];
      await this.dependencies.repository.projectSnapshot(snapshot => {
        let save = validateStorySave(snapshot.story);
        for (const batch of batches) save = this.acceptInto(save, batch);
        return { ...snapshot, story: validateStorySave(save) };
      }, { storyOnly: true });
      for (const batch of batches) this.transientBatches.delete(batch.id);
    }
    if (!this.save.active && !this.save.queue.length && this.reservations.size) {
      this.error = "玩法检查点尚未保存，请先重试保存或退出剧情"; this.emit(); return;
    }
    if (this.save.suspended) await this.dependencies.repository.projectSnapshot(snapshot => ({ ...snapshot, story: validateStorySave({ ...validateStorySave(snapshot.story), suspended: false } satisfies StorySave) }), { storyOnly: true });
    if (!this.blocked && this.save.active?.run.status === "failed") {
      const active = this.save.active;
      await this.persist({ ...active, run: retryStory(active.run, this.context(active.request)) });
    }
    await this.drain();
  }); }
  flush(): Promise<void> { return this.pending; }
  dispose(): void {
    this.closed = true; this.presentation?.controller.abort(); this.reservations.clear(); this.reservationOnce.clear();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.emit(); this.listeners.clear();
  }
}
