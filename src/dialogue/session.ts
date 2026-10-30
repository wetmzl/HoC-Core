import type { MatchState } from "../core/match/types";
import type { CharacterInteraction, MountedDialogueSource } from "../content/packages/plugin-contracts";
import type { DialogueEvent, DialogueSelection } from "./types";
import { DialogueEngine, frozenSnapshot } from "./engine";
import { activeDialogueEvents, extractDialogueEvents, restoreDialogueEvent } from "./events";
import { presentationStore, type PresentationStore } from "../persistence/presentation";

/** One table session owns plugin lifetimes, event snapshots and asynchronous image commits. */
export class DialogueSession {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(event: DialogueEvent) => void>();
  private readonly interactions = new Set<(interaction: CharacterInteraction) => void>();
  private readonly releases: (() => void)[] = [];
  private readonly sources = new Map<string, MountedDialogueSource>();
  private token = 0;
  private notifying = false;
  private readonly seen = new Set<string>();
  private presentedKey: string | undefined;
  private selectedEventType: string | undefined;
  private thinking = false;
  constructor(readonly engine: DialogueEngine, private state: MatchState, readonly store: PresentationStore = presentationStore(), private readonly imageAvailable: (url: string) => Promise<boolean> = async () => true, private readonly changed: () => void = () => {}, private readonly selected: (selection: DialogueSelection, restored: boolean, signal: AbortSignal) => void = () => {}) {
    this.releases.push(engine.registry.subscribeInvalidation(() => { this.token++; engine.invalidateCapabilities(); }));
  }
  async start(sources: readonly MountedDialogueSource[], restored: boolean) {
    await this.store.load(); if (this.lifetime.signal.aborted) return;
    for (const source of sources) {
      if (this.sources.has(source.packageId)) throw Error("对白来源包重复");
      if (source.signal?.aborted) continue;
      this.sources.set(source.packageId, source);
      const sourceSignal = source.signal ? AbortSignal.any([source.signal, this.lifetime.signal]) : this.lifetime.signal;
      const ownReleases: (() => void)[] = [];
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        sourceSignal.removeEventListener("abort", cleanup);
        this.sources.delete(source.packageId);
        this.token++;
        this.engine.invalidateCapabilities();
        // Revoke host state before calling plugin code; one failure must not
        // leave a source live or escape the AbortSignal event handler.
        for (const release of ownReleases.splice(0)) {
          try { release(); }
          catch (error) { console.warn("插件对白来源释放失败", { packageId: source.packageId, error }); }
        }
      };
      const live = () => { if (closed || sourceSignal.aborted) throw Error("对白来源已撤销"); };
      const subscribe = <T>(set: Set<(event: T) => void>, listener: (event: T) => void) => { live(); set.add(listener); const release = () => { set.delete(listener); }; ownReleases.push(release); return release; };
      try {
        const release = source.mount({
          matchId: this.state.id, characterId: this.state.opponentId, restored,
          getMatch: () => { live(); return frozenSnapshot(this.state); },
          getPresentation: () => { live(); return this.store.get(this.state.id, source.packageId, source.declaration); },
          setPresentation: value => { live(); this.store.set(this.state.id, source.packageId, source.declaration, value); },
          subscribeDialogueEvents: listener => subscribe(this.listeners, listener),
          subscribeCharacterInteraction: listener => subscribe(this.interactions, listener),
          publish: (id, apiVersion, data) => {
            live(); if (this.engine.registry.evaluating || this.notifying) throw Error("原语求值或事件通知期间不得重入发布");
            const type = `${source.packageId}#${id}`;
            const test = { id: "validate", type, apiVersion, data }; activeDialogueEvents().validate(test);
            const seq = this.store.nextSequence(this.state.id, source.packageId, source.declaration);
            void this.deliver({ ...test, id: `${this.state.id}:${type}:${seq}` });
          }
        }, sourceSignal);
        if (release) ownReleases.push(release);
      } catch (error) { cleanup(); console.warn("插件对白来源不可用", { packageId: source.packageId, error }); }
      // mount can synchronously revoke its own source before returning a disposer.
      if (sourceSignal.aborted) cleanup();
      if (!closed) {
        sourceSignal.addEventListener("abort", cleanup, { once: true });
        this.releases.push(cleanup);
      }
    }
    const event = restoreDialogueEvent(this.state);
    if (event) void this.deliverEvents([event], restored);
    this.present(restored);
  }
  transition(state: MatchState) {
    const events = extractDialogueEvents(this.state, state);
    if (!events.length && state !== this.state) this.thinking = false;
    this.state = state;
    if (events.length) void this.deliverEvents(events);
  }
  /** A temporary pose, without resampling dialogue or replaying its effects. */
  beginThinking(): boolean {
    if (this.lifetime.signal.aborted || this.state.round.phase !== "turns" || this.state.round.currentActor !== "opponent") return false;
    // Skill, interaction and result portraits retain priority. Use the event that
    // actually selected the rule, including rules shared by several event types.
    if (this.peek().portrait && !["core.action", "core.round-start"].includes(this.selectedEventType ?? "")) return false;
    if (!this.thinking) { this.thinking = true; this.changed(); }
    return true;
  }
  get isThinking(): boolean { return this.thinking && !this.lifetime.signal.aborted; }
  interact(interaction: CharacterInteraction) {
    if (this.lifetime.signal.aborted || this.state.scene !== "match" || this.state.view !== "table") return;
    const input = frozenSnapshot(interaction); for (const listener of this.interactions) try { listener(input); } catch (error) { console.warn("角色交互失败", error); }
  }
  deliver(event: DialogueEvent) { return this.deliverEvents([event]); }
  private async deliverEvents(events: readonly DialogueEvent[], restored = false) {
    const pending = events.filter(event => !this.seen.has(event.id));
    if (this.lifetime.signal.aborted || !pending.length) return;
    for (const event of pending) activeDialogueEvents().validate(event);
    const token = ++this.token;
    const state = this.state;
    for (const event of pending) {
      if (this.lifetime.signal.aborted || token !== this.token) return;
      this.seen.add(event.id);
      this.notifying = true;
      try { for (const listener of this.listeners) try { listener(frozenSnapshot(event)); } catch (error) { console.warn("对白事件监听失败", error); } } finally { this.notifying = false; }
      const presentation = Object.fromEntries([...this.sources].map(([id, source]) => [id, this.store.get(state.id, id, source.declaration)]));
      let candidate = this.engine.accept(state, event, presentation);
      while (candidate !== this.engine.peek(state) && candidate.portrait && candidate.ruleId) {
        let available = false; try { available = await this.imageAvailable(candidate.portrait.image); } catch { /* Continue the captured event without sampling again. */ }
        if (this.lifetime.signal.aborted || token !== this.token) return;
        if (available) break;
        candidate = this.engine.rejectPortrait(candidate.ruleId);
      }
      if (this.lifetime.signal.aborted || token !== this.token) return;
      if (candidate !== this.engine.peek(state)) this.selectedEventType = event.type;
      this.engine.commit(candidate);
    }
    this.thinking = false;
    this.present(restored);
    this.changed();
  }
  private present(restored: boolean) {
    if (this.lifetime.signal.aborted) return;
    const selection = this.peek();
    if (selection.key === this.presentedKey) return;
    this.presentedKey = selection.key;
    try { this.selected(frozenSnapshot(selection), restored, this.lifetime.signal); }
    catch (error) { console.warn("对白表现回调失败", error); }
  }
  peek() { return this.engine.peek(this.state); }
  dispose() { this.lifetime.abort(); this.token++; this.releases.splice(0).forEach(release => release()); this.listeners.clear(); this.interactions.clear(); this.sources.clear(); this.engine.invalidateCapabilities(); if (this.state.status === "finished") this.store.clearMatch(this.state.id); return this.store.flush(); }
}
