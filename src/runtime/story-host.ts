import { prepareStoryContent, type PreparedStoryContent } from "../content/packages/stories";
import type { ExtensionResource } from "../content/packages/resources";
import type { PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import { StoryExtensions, validateStorySceneCapabilities } from "../core/story/extensions";
import type { StoryAction, StoryScalar } from "../core/story/types";
import { createPublicEventBatch, type PublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import type { PublicQueryContext } from "../core/events/public-queries";
import { createStoryPresenter, type StoryPresenter } from "../presentation/story-presenter";
import { createStoryAudio } from "../audio/story-audio";
import type { CheckpointSaveRepository } from "../persistence/repository";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import type { LongTermSave } from "../persistence/schema";
import type { RuntimeEventHub } from "./public-event-hub";
import { InteractionGate } from "./interaction-gate";
import { StoryDirector, type StoryDirectorState } from "./story-director";
import { STORY_COMMAND_CAPABILITIES, projectStoryCommand } from "./story-commands";
import { createProgramLifecycleBatch } from "./program-events";
import { RuntimeEventHub as ReplayEventHub } from "./public-event-hub";
import { PersistenceService } from "../persistence/save-service";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { replayStoryResources, unlockedStorySceneIds } from "./story-replay";

export interface StoryPlaybackResult { readonly id: string; readonly sceneId: string; readonly status: string; readonly result?: StoryScalar }
export interface PluginStoryApi {
  play(sceneId: string, options?: { readonly signal?: AbortSignal; readonly priority?: number }): Promise<StoryPlaybackResult>;
  getState(): StoryDirectorState;
  cancel(): Promise<void>;
}
export interface StoryHostDependencies {
  readonly repository: CheckpointSaveRepository;
  readonly events: RuntimeEventHub;
  readonly gate: InteractionGate;
  resources(): Readonly<Record<string, readonly ExtensionResource[]>>;
  contributions(): readonly PluginRuntimeContribution[];
  scopes(): PublicEventScopes;
  publicContext(): PublicQueryContext;
  reducedMotion(): boolean;
  committed(snapshot: RawSaveSnapshot, events?: readonly PublicEventBatch[]): Promise<void>;
  changed(): void;
}

/** Browser composition only; requests, effects and progress remain owned by the director. */
export class StoryHost {
  readonly director: StoryDirector;
  private replayHost?: StoryHost;
  private replayPending = false;
  get blocking(): boolean { return this.replayPending || this.director.state.blocking; }
  archiveScenes(snapshot: RawSaveSnapshot) {
    const scenes = this.content().scenes;
    const unlocked = unlockedStorySceneIds(snapshot.story, scenes, snapshot.longTerm as LongTermSave | null);
    return scenes.filter(scene => unlocked.has(scene.id));
  }
  async replay(sceneId: string, signal?: AbortSignal): Promise<StoryPlaybackResult> {
    if (this.blocking) throw new Error("请先完成当前剧情。");
    if (signal?.aborted || this.lifetime.signal.aborted) throw new DOMException("回看已取消", "AbortError");
    this.replayPending = true;
    const release = this.deps.gate.acquire();
    this.deps.changed();
    try {
      const snapshot = await this.deps.repository.readSnapshot();
      if (!this.content().resolveScene(sceneId)) throw new Error("剧情资源当前不可用。");
      if (!this.archiveScenes(snapshot).some(scene => scene.id === sceneId)) throw new Error("这段剧情尚未解锁。");
      const resources = replayStoryResources(this.deps.resources());
      const replay = this.replayHost = new StoryHost({ ...this.deps,
        repository: new PersistenceService(new MemorySaveStorageDriver({ longTerm: structuredClone(snapshot.longTerm), runtime: null })),
        events: new ReplayEventHub(), resources: () => resources,
        committed: async () => {}
      });
      await replay.initialize(); replay.setReady();
      const lifetime = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      return await replay.forPackage(sceneId.split("#")[0], lifetime).play(sceneId);
    } finally {
      this.replayHost?.dispose(); this.replayHost = undefined;
      this.replayPending = false; release(); this.update(this.director.state); this.deps.changed();
    }
  }
  private readonly extensions = new StoryExtensions();
  private readonly lifetime = new AbortController();
  private presenter?: StoryPresenter;
  private releaseLease?: () => void;
  private ready = false;
  private restoredLine?: { readonly id: string; readonly sceneId: string; readonly cursor: string; readonly sequence: number };
  private wakeReady!: () => void;
  private readonly readiness = new Promise<void>(resolve => { this.wakeReady = resolve; });
  private readonly unsubscribe: (() => void)[] = [];
  private prepared?: { resources: Readonly<Record<string, readonly ExtensionResource[]>>; content: PreparedStoryContent };
  private activeExtensions: readonly PluginRuntimeContribution[] | undefined;
  private releaseExtensions: (() => void)[] = [];
  private readonly extensionCleanups = new Set<Promise<unknown>>();

  constructor(private readonly deps: StoryHostDependencies) {
    for (const command of STORY_COMMAND_CAPABILITIES) this.extensions.registerCommand(command);
    this.director = new StoryDirector({
      repository: deps.repository, catalog: () => this.content(), scopes: deps.scopes,
      onDiagnostic: diagnostic => console.warn("剧情调度诊断", diagnostic),
      engineContext: () => ({ extensions: this.extensions, publicContext: deps.publicContext() }),
      projectCommand: (intent, snapshot, request) => {
        const program = (snapshot.runtime as import("../persistence/schema").RuntimeSave | null)?.activeProgram;
        if (intent.type.startsWith("core.program.") && request.scopes.program && program?.id !== request.scopes.program)
          throw new Error("剧情所属流程已改变，不能执行旧请求的玩法命令");
        const publicEvents: PublicEventBatch[] = [];
        const next = projectStoryCommand(intent, snapshot, (run, changes) => publicEvents.push(createProgramLifecycleBatch(
          { ...request.scopes, ...deps.scopes() }, { id: run.id, definitionId: run.definition.id, nodeId: run.cursor, visitIndex: run.visitIndex, status: run.status }, changes, intent.type)));
        return { snapshot: next, publicEvents };
      },
      onSnapshotCommitted: async (snapshot, events) => {
        await deps.committed(snapshot, events);
        for (const batch of events ?? []) { deps.events.publish("resolved", batch); deps.events.publish("committed", batch); }
      },
      onBlockingChange: blocking => {
        if (blocking && !this.releaseLease) this.releaseLease = deps.gate.acquire();
        if (!blocking) { this.releaseLease?.(); this.releaseLease = undefined; }
        deps.changed();
      },
      perform: (action, context) => this.perform(action, context)
    });
    this.unsubscribe.push(this.director.subscribe(state => this.update(state)));
    this.unsubscribe.push(deps.events.subscribe("resolved", batch => {
      if (this.replayPending) return;
      this.director.reserve(batch);
      const transient = batch.facts.filter(event => event.type.startsWith("core.") || event.type === "program.restored" || event.type === "match.restored");
      if (transient.length) return this.director.accept(createPublicEventBatch({ ...batch, facts: transient }));
    }, { signal: this.lifetime.signal }));
  }
  private content(): PreparedStoryContent {
    const contributions = this.deps.contributions();
    if (contributions !== this.activeExtensions) {
      for (const release of this.releaseExtensions) release();
      this.releaseExtensions = [];
      for (const contribution of contributions) for (const extension of contribution.storyActions ?? [])
        this.releaseExtensions.push(this.extensions.registerAction(extension));
      this.activeExtensions = contributions;
    }
    const resources = this.deps.resources();
    if (this.prepared?.resources !== resources) {
      this.prepared = { resources, content: prepareStoryContent([...(resources["story.scene"] ?? []), ...(resources["story.binding"] ?? [])]) };
      for (const diagnostic of this.prepared.content.diagnostics) console.warn("剧情资源未激活", diagnostic);
    }
    return this.prepared.content;
  }
  private asset = (path: string): string => {
    const sceneId = this.director.run?.sceneId;
    if (!sceneId) throw new Error("当前没有剧情舞台");
    return this.content().resolveAsset(sceneId, path);
  };
  private view(): StoryPresenter {
    return this.presenter ??= createStoryPresenter({
      resolveAsset: this.asset, resolveScene: id => this.content().resolveScene(id), reducedMotion: this.deps.reducedMotion,
      audio: createStoryAudio(this.asset),
      onAdvance: () => this.director.advance(), onChoice: id => this.director.choose(id),
      onSkip: () => this.director.skip(), onCancel: () => this.director.cancel(), onRetry: () => this.director.retry(),
      extension: async (action, context) => {
        const extension = this.extensions.action(action.typeId, action.apiVersion);
        if (!extension) { if (action.required === false) return; throw new Error(`剧情动作不可用：${action.typeId}`); }
        const parsed = extension.schema.safeParse(action.args);
        if (!parsed.success) throw new Error(`剧情动作参数无效：${action.typeId}`);
        const scope = { runId: this.director.run?.id ?? "", signal: context.signal, clock: context.clock };
        let cancel = () => {};
        const cancelled = new Promise<void>((resolve, reject) => {
          cancel = () => {
            const cleanup = Promise.resolve().then(() => extension.cancel(parsed.data, scope));
            this.extensionCleanups.add(cleanup);
            void cleanup.then(() => resolve(), reject).finally(() => this.extensionCleanups.delete(cleanup));
          };
          context.signal.addEventListener("abort", cancel, { once: true });
        });
        const execution = Promise.resolve().then(() => context.restore && !this.director.run?.skipping ? extension.restore(parsed.data, scope)
          : context.skip ? extension.fastForward(parsed.data, scope) : extension.execute(parsed.data, scope));
        try { await Promise.race([execution, cancelled]); }
        finally { context.signal.removeEventListener("abort", cancel); }
      }
    });
  }
  private update(state: StoryDirectorState): void {
    if (!this.ready || this.lifetime.signal.aborted || this.replayPending) return;
    if (!state.run) {
      if (state.error) this.view().update({ id: "story-pending-error", sceneId: "", cursor: "", stack: [], variables: {}, stage: { overlay: 0.5, actors: {} },
        status: "failed", skipping: false, sequence: 0, choices: [], receipts: [], error: state.error });
      else this.presenter?.update(null);
      return;
    }
    const errors = this.content().resolveScene(state.run.sceneId);
    const capabilityErrors = errors ? validateStorySceneCapabilities(errors, this.extensions) : [];
    const error = state.error ?? capabilityErrors[0];
    const restored = this.restoredLine;
    const sameRestoredLine = Boolean(restored && restored.id === state.run.id && restored.sceneId === state.run.sceneId
      && restored.cursor === state.run.cursor && restored.sequence === state.run.sequence);
    if (!sameRestoredLine) this.restoredLine = undefined;
    this.view().update(error ? { ...state.run, status: "failed", error } : state.run, { restored: sameRestoredLine });
  }
  private async perform(action: StoryAction, context: { signal: AbortSignal; skip: boolean; restore?: boolean }): Promise<void> {
    await this.readiness;
    if (context.signal.aborted || this.lifetime.signal.aborted) return;
    await Promise.allSettled([...this.extensionCleanups]);
    this.update(this.director.state);
    await this.view().perform(action, context);
  }
  async initialize(): Promise<void> {
    await this.director.initialize({ deferPlayback: true });
    const run = this.director.run;
    if (run?.waiting?.type === "say") this.restoredLine = { id: run.id, sceneId: run.sceneId, cursor: run.cursor, sequence: run.sequence };
  }
  setReady(): void {
    this.ready = true; this.wakeReady(); this.update(this.director.state);
    void this.director.resumePlayback().catch(() => this.update(this.director.state));
  }
  forPackage(packageId: string, lifetime: AbortSignal): PluginStoryApi {
    return {
      play: async (reference, options = {}) => {
        const signal = options.signal ? AbortSignal.any([this.lifetime.signal, lifetime, options.signal]) : AbortSignal.any([this.lifetime.signal, lifetime]);
        if (signal.aborted) throw new DOMException("剧情请求已取消", "AbortError");
        const sceneId = reference.includes("#") ? reference : `${packageId}#${reference}`;
        const id = `story:${crypto.randomUUID()}`;
        await this.director.enqueue(sceneId, { id, priority: options.priority, scopes: this.deps.scopes() });
        return new Promise<StoryPlaybackResult>((resolve, reject) => {
          let release = () => {};
          const abort = () => {
            release(); void this.director.cancelRequest(id).catch(() => {});
            reject(new DOMException("剧情请求已取消", "AbortError"));
          };
          signal.addEventListener("abort", abort, { once: true });
          const listener = (state: StoryDirectorState) => {
            const completed = state.save.completed.find(item => item.id === id);
            if (completed) { release(); signal.removeEventListener("abort", abort); resolve(structuredClone(completed)); }
          };
          release = this.director.subscribe(listener);
          listener(this.director.state);
          if (signal.aborted) abort();
        });
      },
      getState: () => structuredClone(this.director.state),
      cancel: () => this.director.state.request?.packageId === packageId ? this.director.cancel() : Promise.resolve()
    };
  }
  async flush(): Promise<void> { await this.director.flush(); await this.replayHost?.flush(); }
  dispose(): void {
    this.lifetime.abort(); this.wakeReady(); this.replayHost?.dispose();
    this.director.dispose(); this.presenter?.dispose();
    this.releaseLease?.(); this.releaseLease = undefined;
    for (const release of [...this.unsubscribe, ...this.releaseExtensions]) release();
  }
}
