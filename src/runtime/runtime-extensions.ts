import { gameAudio } from "../audio/game-audio";
import type { PluginGameEventsApi, PluginGameRuntimeContext, PluginRuntimeContext, PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import type { Action, MatchState } from "../core/match/types";
import { alertGameDialog, confirmGameDialog } from "../game-dialog";
import { CleanupErrors } from "./cleanup-errors";
import { getPluginTutorialIdentity, type PluginTutorialApi } from "../content/packages/plugin-tutorials";
import { PLUGIN_MUSIC_API_VERSION, PLUGIN_TUTORIAL_API_VERSION } from "../content/packages/plugin-version";
import { snapshotPublicEventBatch, type PublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import type { RuntimeEventHub, PublicEventSubscription } from "./public-event-hub";

export class RuntimeExtensions {
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly versionListeners = new Set<() => void>();
  private readonly releases: Array<() => void> = [];
  private readonly pauses = new Set<object>();
  constructor(private readonly options: {
    context: PluginRuntimeContext; contributions: readonly PluginRuntimeContribution[];
    getMatch(): MatchState | undefined; dispatch(action: Action): void; autoActionsChanged(): void;
    createTutorialApi?(packageId: string, signal: AbortSignal): PluginTutorialApi;
    createStoryApi?(packageId: string, signal: AbortSignal): import("./story-host").PluginStoryApi | undefined;
    events?: RuntimeEventHub;
    eventScopes?: PublicEventScopes;
  }) {}
  get paused(): boolean { return this.pauses.size > 0; }
  pauseAutoActions = (): (() => void) => {
    if (this.controller.signal.aborted) return () => {};
    const token = {}; this.pauses.add(token); this.options.autoActionsChanged();
    return () => { if (this.pauses.delete(token)) this.options.autoActionsChanged(); };
  };
  notify = (): void => {
    for (const listener of this.listeners) { try { listener(); } catch (error) { console.error("插件运行时订阅失败", error); } }
  };
  async mount(): Promise<void> {
    const signal = this.controller.signal;
    this.options.context.root.addEventListener("click", event => {
      if ((event.target as Element).closest("[data-app-version]")) for (const listener of this.versionListeners) listener();
    }, { signal });
    const context: PluginGameRuntimeContext = { ...this.options.context,
      confirm: confirmGameDialog, alert: alertGameDialog,
      onVersionClick: listener => { this.versionListeners.add(listener); return () => { this.versionListeners.delete(listener); }; },
      game: {
        getMatch: () => { const state = this.options.getMatch(); return state ? JSON.parse(JSON.stringify(state)) as MatchState : undefined; },
        subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
        configureAbility: binding => { if (!signal.aborted) this.options.dispatch({ type: "CONFIGURE_INTRINSIC_ABILITY", binding }); },
        invokeAbility: (definitionId, parameters) => { if (!signal.aborted) this.options.dispatch({ type: "INVOKE_INTRINSIC_ABILITY", definitionId, parameters }); },
        pauseAutoActions: this.pauseAutoActions
      }
    };
    try {
      for (const contribution of this.options.contributions) {
        if (signal.aborted) break;
        const identity = getPluginTutorialIdentity(contribution);
        const tutorials = identity && identity.apiVersion >= PLUGIN_TUTORIAL_API_VERSION
          ? this.options.createTutorialApi?.(identity.packageId, signal) : undefined;
        const music = identity && identity.apiVersion >= PLUGIN_MUSIC_API_VERSION ? gameAudio.musicDirector.forPackage(identity.packageId, identity.signal ? AbortSignal.any([signal, identity.signal]) : signal) : undefined;
        const ownerSignal = identity?.signal ? AbortSignal.any([signal, identity.signal]) : signal;
        const events = this.gameEvents(ownerSignal);
        const ownedContext: PluginGameRuntimeContext = { ...context, ...(music ? { music } : {}), ...(tutorials ? { tutorials } : {}),
          ...(identity && this.options.createStoryApi ? { stories: this.options.createStoryApi(identity.packageId, ownerSignal) } : {}),
          ...(events ? { game: { ...context.game, events } } : {}) };
        const release = await contribution.mountRuntime?.(ownedContext, signal);
        if (signal.aborted) { release?.(); break; }
        if (release) this.releases.push(release);
      }
    } catch (error) {
      try { this.dispose(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "插件运行时挂载和清理失败。"); }
      throw error;
    }
  }
  private gameEvents(signal: AbortSignal): PluginGameEventsApi | undefined {
    const events = this.options.events;
    if (!events) return undefined;
    const snapshots = new WeakMap<PublicEventBatch, PublicEventBatch>();
    const snapshot = (batch: PublicEventBatch): PublicEventBatch => {
      let copy = snapshots.get(batch);
      if (!copy) { copy = snapshotPublicEventBatch(batch); snapshots.set(batch, copy); }
      return copy;
    };
    const scoped = (options: PublicEventSubscription = {}): PublicEventSubscription => ({
      ...options,
      // A caller may narrow its match/program scope, but cannot leave its game.
      scopes: { ...options.scopes, ...this.options.eventScopes },
      signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal
    });
    return Object.freeze({
      subscribe: (stage, listener, options) => events.subscribe(stage, (batch, lifetime) => listener(snapshot(batch), lifetime), scoped(options)),
      subscribeTrigger: (stage, trigger, listener, options) => events.subscribeTrigger(stage, trigger, (batch, lifetime) => listener(snapshot(batch), lifetime), scoped(options))
    } satisfies PluginGameEventsApi);
  }
  dispose(): void {
    const cleanup = new CleanupErrors();
    cleanup.run(() => this.controller.abort());
    for (const release of this.releases.splice(0).reverse()) cleanup.run(release);
    this.listeners.clear(); this.versionListeners.clear(); this.pauses.clear();
    const error = cleanup.error("插件运行时清理失败。");
    if (error) throw error;
  }
}
