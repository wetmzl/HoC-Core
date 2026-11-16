import type { StoryAction, StoryRun, StoryScene, StorySayNode } from "../core/story/types";
import { storyComposition } from "../core/story/composition";
import { registerBackHandler } from "../platform/back-navigation";
import { TextOutputHaptics } from "./text-output-haptics";
import { presentInteractionHaptic } from "./haptics";
import { StoryStageView, StoryTimeline, type StoryPerformContext, type StoryAudioAction } from "./story-stage";
import "./story.css";

export interface StoryPresenterAudio {
  perform(action: StoryAudioAction, context: StoryPerformContext): void | Promise<void>;
  setPaused?(paused: boolean): void;
  fastForward?(): void;
  dispose?(): void;
}
export interface StoryPresenterDependencies {
  readonly resolveAsset: (path: string) => string | Promise<string>;
  readonly resolveScene?: (id: string) => StoryScene | undefined;
  readonly onAdvance: () => void | Promise<void>;
  readonly onChoice: (id: string) => void | Promise<void>;
  readonly onSkip: () => void | Promise<void>;
  readonly onCancel: () => void | Promise<void>;
  readonly onRetry?: () => void | Promise<void>;
  readonly audio?: StoryPresenterAudio;
  readonly extension?: (action: Extract<StoryAction, { type: "extension" }>, context: StoryPerformContext) => void | Promise<void>;
  readonly reducedMotion?: () => boolean;
  readonly document?: Document;
}

interface StoryHistoryEntry { readonly speaker: string; readonly text: string }

export function storyLineText(node: StorySayNode): string { return node.segments.map(segment => "text" in segment ? segment.text : "").join(""); }

/** Explicit movement keeps its authored transform while ordinary entrances use auto layout. */
function hasPositionedAction(action: StoryAction): boolean {
  if (action.type === "sequence" || action.type === "parallel") return action.actions.some(hasPositionedAction);
  return action.type === "animate" || action.type === "stage" && Boolean(action.actors?.some(actor =>
    [actor.x, actor.y, actor.scale, actor.rotation, actor.anchorX, actor.anchorY].some(value => value !== undefined)));
}

const STORY_CONTROL_ICONS = {
  speed: '<text x="12" y="16" text-anchor="middle" font-size="14" font-weight="700" stroke="none" fill="currentColor">1×</text>',
  auto: '<g class="story-auto-play"><path d="m9 5 11 7-11 7Z"/></g><g class="story-auto-pause"><path d="M8 5v14M16 5v14"/></g>',
  skip: '<path d="m3 5 8 7-8 7Zm8 0 8 7-8 7ZM21 5v14"/>',
  log: '<path d="M12 5v15M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z"/><path d="M5 8h4M5 12h4M15 8h4M15 12h4"/>'
} as const;

/** A body-owned modal survives launcher/table re-renders. It never mutates gameplay. */
export class StoryPresenter {
  private readonly doc: Document;
  private readonly lifetime = new AbortController();
  private readonly dialog: HTMLDialogElement;
  private readonly stage: StoryStageView;
  private readonly timeline: StoryTimeline;
  private readonly speaker: HTMLElement;
  private readonly text: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly choices: HTMLElement;
  private readonly status: HTMLElement;
  private readonly dialogue: HTMLElement;
  private readonly speedButton: HTMLButtonElement;
  private readonly autoButton: HTMLButtonElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly log: HTMLElement;
  private readonly exit: HTMLElement;
  private readonly skip: HTMLElement;
  private readonly errors: HTMLElement;
  private readonly releaseBack: () => void;
  private readonly observer?: MutationObserver;
  private readonly dialogueObserver?: ResizeObserver;
  private returnFocus?: HTMLElement;
  private run: StoryRun | null = null;
  private viewKey = "";
  private typewriter?: AbortController;
  private outputFeedback?: TextOutputHaptics;
  private outputKey = "";
  private autoDelay?: AbortController;
  private fullText = "";
  private typing = false;
  private auto = false;
  private playbackRate = 1;
  private commandPending = false;
  private readonly history: StoryHistoryEntry[] = [];
  private localError?: string;
  private hydration: Promise<void> = Promise.resolve();
  private tap?: { readonly id: number; readonly x: number; readonly y: number; moved: boolean };

  constructor(private readonly deps: StoryPresenterDependencies) {
    this.doc = deps.document ?? document;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
      const node = this.doc.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
    };
    const button = (label: string, action: () => void, className = "secondary-button"): HTMLButtonElement => {
      const node = element("button", className, label); node.type = "button"; node.addEventListener("click", action, { signal: this.lifetime.signal }); return node;
    };
    const control = (label: string, icon: keyof typeof STORY_CONTROL_ICONS, action: () => void): HTMLButtonElement => {
      const node = button(label, action, "story-control");
      node.setAttribute("aria-label", label); node.title = label;
      node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${STORY_CONTROL_ICONS[icon]}</svg>`;
      return node;
    };
    this.dialog = element("dialog", "story-player");
    this.dialog.setAttribute("aria-label", "剧情播放"); this.dialog.setAttribute("data-story-player", "");
    const stage = element("div", "story-stage"); stage.setAttribute("aria-hidden", "true");
    this.stage = new StoryStageView(stage, deps.resolveAsset, id => {
      const actor = this.run ? deps.resolveScene?.(this.run.sceneId)?.actors?.[id] : undefined;
      return { image: actor?.image, scale: actor?.scale ?? 1 };
    });
    this.timeline = new StoryTimeline({
      getActor: this.stage.getActor, ensureActor: this.stage.ensureActor, version: this.stage.version, patchActor: this.stage.patchActor,
      stage: (action, signal) => this.stage.apply(action, signal),
      ...(deps.audio ? { audio: (action: StoryAudioAction, context: StoryPerformContext) => deps.audio!.perform(action, context) } : {}),
      ...(deps.extension ? { extension: deps.extension } : {}),
      reducedMotion: () => this.isReducedMotion()
    });
    const layout = element("div", "story-player-layout");
    this.controls = element("nav", "story-player-controls"); this.controls.setAttribute("aria-label", "剧情播放控制");
    this.speedButton = control("倍速", "speed", () => this.setPlaybackRate(this.playbackRate === 1 ? 2 : 1));
    this.speedButton.setAttribute("aria-pressed", "false"); this.speedButton.title = "倍速（1×）";
    this.autoButton = control("自动", "auto", () => this.setAuto(!this.auto)); this.autoButton.setAttribute("aria-pressed", "false");
    this.skipButton = control("跳过", "skip", () => this.requestSkip());
    this.controls.append(this.speedButton, this.autoButton, control("回看", "log", () => this.toggleLog()), this.skipButton);
    this.dialogue = element("section", "story-dialogue");
    const dialogue = this.dialogue;
    dialogue.tabIndex = 0;
    dialogue.setAttribute("aria-label", "剧情正文，按空格或回车继续");
    this.speaker = element("div", "story-speaker");
    this.text = element("p", "story-text"); this.text.setAttribute("aria-live", "off");
    this.choices = element("div", "story-choices"); this.choices.setAttribute("role", "group"); this.choices.setAttribute("aria-label", "剧情选项");
    this.status = element("p", "story-status"); this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    dialogue.append(this.speaker, this.text, this.choices, this.status);
    // The shared actor stage extends behind the dialogue; only its lower edge is covered.
    layout.append(this.controls, this.stage.actors, dialogue);
    if (typeof ResizeObserver !== "undefined") {
      this.dialogueObserver = new ResizeObserver(() => {
        this.stage.actors.style.setProperty("--story-dialogue-height", `${dialogue.getBoundingClientRect().height}px`);
      });
      this.dialogueObserver.observe(dialogue);
    }
    this.log = element("section", "story-subpanel story-log"); this.log.hidden = true; this.log.setAttribute("aria-label", "本段剧情回看");
    this.log.append(element("h2", "", "剧情回看"), element("ol", "story-log-entries"), button("返回剧情", () => this.toggleLog(false)));
    this.exit = element("section", "story-subpanel story-exit"); this.exit.hidden = true; this.exit.setAttribute("aria-label", "退出剧情确认");
    this.exit.append(element("h2", "", "退出当前剧情？"), element("p", "", "退出会中断本次播放。"), button("继续播放", () => this.setPanel(this.exit, false)), button("退出剧情", () => this.invoke(deps.onCancel), "danger-button"));
    this.skip = element("section", "story-subpanel story-skip"); this.skip.hidden = true; this.skip.setAttribute("aria-label", "跳过剧情确认");
    this.skip.append(element("h2", "", "是否跳过剧情？"), button("继续播放", () => this.setPanel(this.skip, false)), button("跳过剧情", () => this.invoke(async () => {
      this.setAuto(false); this.setPanel(this.skip, false);
      if (this.run?.waiting?.type === "say") this.completeText();
      this.setFastForward(true); await deps.onSkip();
    }), "danger-button"));
    this.errors = element("section", "story-subpanel story-error"); this.errors.hidden = true; this.errors.setAttribute("role", "alert");
    this.errors.append(element("h2", "", "剧情播放遇到问题"), element("p", "story-error-message"), button("重试", () => this.invoke(() => this.retry())), button("退出剧情", () => this.invoke(deps.onCancel), "danger-button"));
    this.dialog.append(stage, layout, this.log, this.exit, this.skip, this.errors);
    this.dialog.addEventListener("pointerdown", event => {
      this.tap = event.isPrimary && event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : undefined;
    }, { signal: this.lifetime.signal });
    this.dialog.addEventListener("pointermove", event => {
      if (this.tap?.id === event.pointerId && Math.hypot(event.clientX - this.tap.x, event.clientY - this.tap.y) > 10) this.tap.moved = true;
    }, { signal: this.lifetime.signal });
    this.dialog.addEventListener("pointercancel", event => {
      if (this.tap?.id === event.pointerId) this.tap.moved = true;
    }, { signal: this.lifetime.signal });
    this.dialog.addEventListener("click", event => {
      const tap = this.tap; this.tap = undefined;
      const target = event.target instanceof Element ? event.target : undefined;
      if (event.defaultPrevented || tap?.moved || target?.closest("button, a, input, textarea, select, [contenteditable], [role=button], .story-player-controls, .story-subpanel")) return;
      // Protect the entire top band, including the safe area and gaps around icons.
      const protectedBottom = this.controls.getBoundingClientRect().bottom;
      if (event.clientY <= protectedBottom || (tap && tap.y <= protectedBottom)) return;
      if (this.doc.getSelection()?.isCollapsed === false) return;
      this.advance();
    }, { signal: this.lifetime.signal });
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.requestCancel(); }, { signal: this.lifetime.signal });
    this.dialog.addEventListener("keydown", event => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.requestCancel(); return; }
      if ((event.key === " " || event.key === "Enter") && (event.target === this.dialog || event.target === this.dialogue)) {
        event.preventDefault(); this.advance();
      }
    }, { signal: this.lifetime.signal });
    this.doc.addEventListener("visibilitychange", () => this.syncPause(), { signal: this.lifetime.signal });
    this.releaseBack = registerBackHandler({ priority: 110, enabled: () => Boolean(this.run && this.dialog.open && !this.covered()), handle: () => this.requestCancel(), signal: this.lifetime.signal });
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver(() => this.ensureOpen());
      this.observer.observe(this.doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden"] });
    }
  }

  private isReducedMotion(): boolean {
    return this.deps.reducedMotion?.() ?? (this.doc.body.classList.contains("reduced-motion") || this.doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  }
  private covered(): boolean {
    return [...this.doc.querySelectorAll<HTMLDialogElement>("dialog[open]")].some(dialog => dialog !== this.dialog && !dialog.hidden)
      || Boolean(this.doc.querySelector(".adult-content-warning-backdrop, .third-party-content-warning-backdrop"));
  }
  private ensureOpen(): void {
    if (!this.run || this.lifetime.signal.aborted) return;
    if (!this.dialog.isConnected) this.doc.body.append(this.dialog);
    if (!this.dialog.open && !this.covered()) {
      this.dialog.showModal(); this.dialog.tabIndex = -1; this.dialog.focus();
    }
    this.syncPause();
  }
  private syncPause(): void {
    const paused = this.doc.hidden || this.covered() || !this.dialog.open || !this.log.hidden || !this.exit.hidden || !this.skip.hidden || !this.errors.hidden;
    this.timeline.clock.setPaused("ui", paused); this.deps.audio?.setPaused?.(paused);
    this.outputFeedback?.setPaused(paused);
  }

  update = (run: StoryRun | null, options: { readonly restored?: boolean } = {}): void => {
    if (this.lifetime.signal.aborted) return;
    if (!run || ["completed", "skipped", "interrupted"].includes(run.status)) { this.hide(); return; }
    const first = !this.run || this.run.id !== run.id;
    if (first) {
      this.returnFocus = this.doc.activeElement instanceof HTMLElement ? this.doc.activeElement : undefined;
      this.history.length = 0; this.viewKey = ""; this.outputKey = ""; this.localError = undefined;
      this.log.hidden = true; this.exit.hidden = true; this.skip.hidden = true; this.errors.hidden = true;
    }
    const key = `${run.id}:${run.sceneId}:${run.cursor}:${run.sequence}:${run.status}`;
    if (key === this.viewKey) { this.run = run; this.setFastForward(run.skipping); this.renderError(); this.ensureOpen(); return; }
    this.typewriter?.abort(); this.outputFeedback?.stop(); this.autoDelay?.abort();
    this.run = run;
    this.setFastForward(run.skipping);
    this.viewKey = key;
    this.typing = false;
    // Keep the last line visible while assets and semantic checkpoints catch up.
    if (first || run.waiting?.type === "say" || run.waiting?.type === "choice" || run.status === "failed") {
      this.fullText = ""; this.text.textContent = ""; this.speaker.textContent = ""; this.speaker.hidden = true;
    }
    this.dialog.dataset.storyTyping = "false";
    this.choices.replaceChildren();
    this.speedButton.disabled = run.status === "failed"; this.skipButton.disabled = run.status === "failed"; this.autoButton.disabled = run.status === "failed";
    this.status.textContent = "";
    const composition = storyComposition(run, this.deps.resolveScene?.(run.sceneId));
    this.stage.setComposition(composition.speaker, composition.atmosphere,
      run.waiting?.type === "presentation" && hasPositionedAction(run.waiting.action), composition.foreground);
    this.hydration = this.stage.hydrate(run.stage, this.lifetime.signal);
    void this.hydration.catch(error => { if (this.viewKey === key) this.showError(error); });
    if (run.waiting?.type === "say") {
      const node = run.waiting.node;
      this.fullText = storyLineText(node);
      this.speaker.textContent = node.speaker ? this.deps.resolveScene?.(run.sceneId)?.actors?.[node.speaker]?.name ?? node.speaker : "";
      this.speaker.hidden = !this.speaker.textContent;
      this.history.push({ speaker: this.speaker.textContent, text: this.fullText });
      if (this.history.length > 500) this.history.shift();
      const outputKey = `${run.id}:${run.sceneId}:${run.cursor}:${run.sequence}`;
      const restored = options.restored || outputKey === this.outputKey;
      this.outputKey = outputKey;
      const scope = new AbortController(); this.typewriter = scope;
      this.outputFeedback = new TextOutputHaptics({ enabled: () => !this.isReducedMotion() && !this.doc.hidden && !this.covered() && !this.run?.skipping, signal: scope.signal, restored });
      void this.typeLine(node, scope.signal, restored).catch(error => { if (!scope.signal.aborted) this.showError(error); });
    } else if (run.waiting?.type === "choice") {
      this.text.textContent = run.waiting.node.prompt ?? "请选择";
      this.status.textContent = run.skipping ? "跳过已暂停，请处理选项后继续。" : "";
      for (const option of run.waiting.options) {
        const button = this.doc.createElement("button"); button.type = "button"; button.className = "story-choice secondary-button";
        const label = this.doc.createElement("span"); label.textContent = option.text; button.append(label);
        button.disabled = !option.enabled;
        if (!option.enabled && option.disabledReason) {
          const reason = this.doc.createElement("small"); reason.textContent = option.disabledReason; button.append(reason);
        }
        button.addEventListener("click", () => this.invoke(() => this.deps.onChoice(option.id)), { signal: this.lifetime.signal });
        this.choices.append(button);
      }
      if (!run.waiting.options.some(option => option.enabled)) this.status.textContent = "当前没有可用选项。请检查条件，或退出剧情。";
    } else if (run.waiting?.type === "command") this.status.textContent = "正在处理……";
    this.renderError(); this.ensureOpen();
  };

  private async typeLine(node: StorySayNode, signal: AbortSignal, restored = false): Promise<void> {
    this.typing = !restored && !this.isReducedMotion() && !this.run?.skipping;
    this.dialog.dataset.storyTyping = String(this.typing);
    if (this.typing) {
      const speed = Math.max(1, node.speed ?? 32);
      for (const segment of node.segments) {
        if ("pauseMs" in segment) continue;
        const characters = Array.from(segment.text), prefix = this.text.textContent ?? "";
        await this.timeline.progress(characters.length * 1000 / speed, progress => {
          this.text.textContent = prefix + characters.slice(0, Math.floor(characters.length * progress)).join("");
          this.outputFeedback?.progress(this.text.textContent);
        }, signal);
        if (signal.aborted) return;
      }
    } else this.text.textContent = this.fullText;
    if (signal.aborted) return;
    this.typing = false; this.dialog.dataset.storyTyping = "false";
    this.outputFeedback?.complete(this.fullText);
    this.status.textContent = this.auto ? "自动播放中" : "点击继续";
    this.scheduleAuto();
  }
  private completeText(): void {
    this.outputFeedback?.complete(this.fullText, true);
    this.typewriter?.abort(); this.typing = false;
    this.text.textContent = this.fullText; this.dialog.dataset.storyTyping = "false"; this.scheduleAuto();
    this.status.textContent = this.auto ? "自动播放中" : "点击继续";
  }
  private advance(feedback = true): void {
    if (!this.log.hidden || !this.exit.hidden || !this.skip.hidden || !this.errors.hidden || this.covered()) return;
    if (this.run?.waiting?.type !== "say") return;
    if (this.typing) this.completeText(); else this.invoke(this.deps.onAdvance);
    if (feedback) presentInteractionHaptic(!this.isReducedMotion());
  }
  private setPlaybackRate(value: number): void {
    this.playbackRate = value; this.timeline.clock.setPlaybackRate(value);
    this.speedButton.setAttribute("aria-pressed", String(value !== 1)); this.speedButton.title = `倍速（${value}×）`;
    this.speedButton.querySelector("text")!.textContent = `${value}×`;
  }
  private setAuto(value: boolean): void {
    this.auto = value; this.autoButton.setAttribute("aria-pressed", String(value));
    this.autoDelay?.abort(); this.scheduleAuto();
  }
  private scheduleAuto(): void {
    this.autoDelay?.abort();
    if (!this.auto || this.typing || this.run?.waiting?.type !== "say" || this.run.skipping || this.commandPending) return;
    const scope = new AbortController(); this.autoDelay = scope;
    void this.timeline.delay(Math.min(5000, Math.max(1000, Array.from(this.fullText).length * 45)), scope.signal)
      .then(() => { if (!scope.signal.aborted && this.auto) this.advance(false); }).catch(() => {});
  }
  private toggleLog(show = this.log.hidden): void {
    if (show) {
      const entries = this.log.querySelector("ol")!; entries.replaceChildren();
      for (const entry of this.history) {
        const item = this.doc.createElement("li");
        const speaker = this.doc.createElement("strong"); speaker.textContent = entry.speaker;
        const line = this.doc.createElement("p"); line.textContent = entry.text;
        if (entry.speaker) item.append(speaker);
        item.append(line); entries.append(item);
      }
    }
    this.setPanel(this.log, show);
  }
  private requestSkip(): void {
    if (this.commandPending || !this.run || this.run.status === "failed") return;
    this.setPanel(this.skip, true);
  }
  private requestCancel(): void {
    if (this.commandPending) return;
    if (!this.skip.hidden) { this.setPanel(this.skip, false); return; }
    if (!this.log.hidden) { this.toggleLog(false); return; }
    if (!this.exit.hidden) { this.setPanel(this.exit, false); return; }
    this.setPanel(this.exit, true);
  }
  private setPanel(panel: HTMLElement, visible: boolean): void {
    panel.hidden = !visible;
    this.dialog.querySelector<HTMLElement>(".story-player-layout")!.inert = visible || !this.errors.hidden;
    this.syncPause();
    (visible ? panel.querySelector<HTMLButtonElement>("button") : this.run?.waiting?.type === "say" ? this.dialogue : this.choices.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? this.dialog)?.focus();
  }
  private invoke(action: () => void | Promise<void>): void {
    if (this.commandPending || this.lifetime.signal.aborted) return;
    this.commandPending = true; this.dialog.setAttribute("aria-busy", "true");
    void Promise.resolve().then(action).catch(error => this.showError(error)).finally(() => {
      this.commandPending = false; this.dialog.removeAttribute("aria-busy");
      // A committed update may finish typing while its advance callback still owns the lock.
      this.scheduleAuto();
    });
  }
  private showError(error: unknown): void {
    if (this.lifetime.signal.aborted || !this.run) return;
    this.localError = error instanceof Error ? error.message : String(error); this.renderError();
  }
  private async retry(): Promise<void> {
    this.localError = undefined;
    // A restored line can fail before the director has any action to retry.
    // Rebuild its stage even when the semantic checkpoint has not changed.
    if (this.run) {
      this.hydration = this.stage.hydrate(this.run.stage, this.lifetime.signal);
      await this.hydration;
    }
    await this.deps.onRetry?.();
    this.renderError();
  }
  private renderError(): void {
    const error = this.localError ?? this.run?.error;
    const newlyVisible = this.errors.hidden && Boolean(error);
    this.errors.hidden = !error;
    this.errors.querySelector<HTMLElement>(".story-error-message")!.textContent = error ?? "";
    this.dialog.querySelector<HTMLElement>(".story-player-layout")!.inert = Boolean(error) || !this.log.hidden || !this.exit.hidden || !this.skip.hidden;
    this.syncPause();
    if (newlyVisible) this.errors.querySelector<HTMLButtonElement>("button")?.focus();
  }

  perform = async (action: StoryAction, options: { readonly signal?: AbortSignal; readonly skip?: boolean; readonly restore?: boolean } = {}): Promise<void> => {
    await this.hydration;
    return this.timeline.perform(action, { ...options, instant: true });
  };
  setFastForward = (value: boolean): void => { this.timeline.setFastForward(value); if (value) this.deps.audio?.fastForward?.(); };
  private hide(): void {
    this.run = null; this.viewKey = ""; this.typewriter?.abort(); this.outputFeedback?.stop(); this.autoDelay?.abort();
    this.dialog.close(); this.dialog.remove(); this.timeline.clock.setPaused("ui", true);
    this.deps.audio?.fastForward?.(); this.timeline.setFastForward(false);
    this.deps.audio?.setPaused?.(false);
    if (this.returnFocus?.isConnected) this.returnFocus.focus(); this.returnFocus = undefined;
  }
  dispose = (): void => {
    if (this.lifetime.signal.aborted) return;
    this.hide(); this.lifetime.abort(); this.releaseBack(); this.observer?.disconnect(); this.dialogueObserver?.disconnect();
    this.timeline.dispose(); this.stage.dispose(); this.deps.audio?.dispose?.();
  };
}

export function createStoryPresenter(deps: StoryPresenterDependencies): StoryPresenter { return new StoryPresenter(deps); }
