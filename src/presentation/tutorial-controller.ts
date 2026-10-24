import "./tutorial.css";
import { ADULT_CONTENT_WARNING_ID, completeTutorial, firstTutorialForCue, type TutorialCue, type TutorialResource } from "../tutorials/tutorials";
import { pluginTutorialProgressId, validatePluginTutorialDefinition, type PluginTutorialApi, type PluginTutorialDefinition } from "../content/packages/plugin-tutorials";
import { TUTORIAL_AUTO_SKIP_MS, TUTORIAL_DISMISS_MS, escapeHtml } from "./view-helpers";
export interface TutorialControllerDependencies {
    save: import("../persistence/schema").LongTermSave;
    root: HTMLDivElement;
    repository: import("../persistence/save-service").PersistenceService;
    readonly autosave: import("../runtime/session-ports").ActiveMatchPersistence | null;
    enqueueNotification: (text: string) => void;
    pauseAutoActions?: () => () => void;
    flushPendingSaveWrites?: () => Promise<void>;
}
interface TutorialRequest {
    readonly definition: PluginTutorialDefinition;
    readonly progressId: string;
    readonly replay: boolean;
    readonly release: () => void;
}
export class TutorialController {
    private disposed = false;
    private ready = false;
    private queue: TutorialRequest[] = [];
    private surface: HTMLElement | null = null;
    private releasePause?: () => void;
    private returnFocus?: HTMLElement;
    private saving = false;
    private pendingCompletion: Promise<void> = Promise.resolve();
    flush = (): Promise<void> => this.pendingCompletion;
    private finishAcknowledgement?: () => void;
    dispose = (): void => {
        this.disposed = true;
        this.clearRequests();
        this.finishAcknowledgement?.();
        this.finishAcknowledgement = undefined;
        document.querySelector(".adult-content-warning-backdrop")?.remove();
    };
    constructor(private readonly deps: TutorialControllerDependencies) { }
    activeTutorial: {
        readonly request: TutorialRequest;
        readonly definition: PluginTutorialDefinition;
        readonly pageIndex: number;
        readonly autoSkipCancelled: boolean;
        readonly error?: string;
    } | null = null;
    tutorialAutoSkipTimer: number | undefined;
    tutorialDismissAnimation: Animation | null = null;
    requireAdultContentAcknowledgement = async (): Promise<void> => {
        if (this.disposed || this.deps.save.tutorialProgress.completedIds.includes(ADULT_CONTENT_WARNING_ID))
            return;
        this.deps.root.inert = true;
        const backdrop = document.createElement("div");
        backdrop.className = "adult-content-warning-backdrop";
        backdrop.innerHTML = `<section id="adult-content-warning" class="adult-content-warning-modal" role="dialog" aria-modal="true" aria-labelledby="adult-content-warning-title" aria-describedby="adult-content-warning-copy adult-content-warning-disclaimer"><p class="eyebrow">House of Chances</p><h1 id="adult-content-warning-title">成人内容警告</h1><p id="adult-content-warning-copy">本作包含赌博及其他不适宜年轻玩家游玩的主题，仅面向成年玩家。</p><p id="adult-content-warning-disclaimer">游戏支持玩家自行导入社区模组。社区模组由各自作者提供，内容可能与基础游戏不同，请在导入前确认其内容说明。</p><button type="button" class="primary-button" data-acknowledge-adult-content>我已成年并继续</button><p class="adult-content-warning-status" role="status" aria-live="polite"></p></section>`;
        document.body.append(backdrop);
        const button = backdrop.querySelector<HTMLButtonElement>("[data-acknowledge-adult-content]");
        button?.focus();
        await new Promise<void>((resolve) => {
            this.finishAcknowledgement = resolve;
            button?.addEventListener("click", () => {
                if (this.disposed || button.disabled)
                    return;
                button.disabled = true;
                const status = backdrop.querySelector<HTMLElement>(".adult-content-warning-status");
                const progress = completeTutorial(this.deps.save.tutorialProgress, ADULT_CONTENT_WARNING_ID);
                const nextSave = { ...this.deps.save, tutorialProgress: { completedIds: [...progress.completedIds] }, updatedAt: new Date().toISOString() };
                void this.deps.repository.saveLongTerm(nextSave).then(() => {
                    if (this.disposed)
                        return;
                    this.finishAcknowledgement = undefined;
                    this.deps.save = nextSave;
                    backdrop.remove();
                    this.deps.root.inert = false;
                    resolve();
                }).catch(() => {
                    if (this.disposed)
                        return;
                    button.disabled = false;
                    if (status)
                        status.textContent = "确认状态保存失败，请重试。";
                    button.focus();
                });
            });
        });
    };
    setReady = (): void => {
        if (this.disposed) return;
        this.ready = true;
        this.showNext();
    };
    forPackage = (packageId: string, lifetime: AbortSignal): PluginTutorialApi => ({
        isCompleted: id => !this.disposed && !lifetime.aborted
            && this.deps.save.tutorialProgress.completedIds.includes(pluginTutorialProgressId(packageId, id)),
        show: (input, options = {}) => {
            if (this.disposed || lifetime.aborted || options.signal?.aborted) return () => {};
            const definition = validatePluginTutorialDefinition(input);
            const progressId = pluginTutorialProgressId(packageId, definition.id);
            const signal = options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
            return this.enqueue(definition, progressId, options.replay === true, signal);
        }
    });
    private enqueue(definition: PluginTutorialDefinition, progressId: string, replay = false, signal?: AbortSignal): () => void {
        if (this.disposed || signal?.aborted || this.deps.save.skipTutorial
            || (!replay && this.deps.save.tutorialProgress.completedIds.includes(progressId))
            || this.activeTutorial?.request.progressId === progressId
            || this.queue.some(request => request.progressId === progressId)) return () => {};
        if (this.queue.length >= 128) throw new Error("等待中的教程过多，请在玩家遇到对应功能时再触发。");
        const cancel = () => {
            signal?.removeEventListener("abort", cancel);
            this.queue = this.queue.filter(pending => pending !== request);
            if (this.activeTutorial?.request === request) {
                this.activeTutorial = null;
                this.clearTutorialSurface();
            }
            this.showNext();
        };
        const request: TutorialRequest = { definition, progressId, replay, release: () => signal?.removeEventListener("abort", cancel) };
        signal?.addEventListener("abort", cancel, { once: true });
        this.queue.push(request);
        this.showNext();
        return cancel;
    }
    private showNext(): void {
        if (this.disposed || !this.ready || this.activeTutorial || this.saving) return;
        while (this.queue.length) {
            const request = this.queue.shift()!;
            if (this.deps.save.skipTutorial || (!request.replay && this.deps.save.tutorialProgress.completedIds.includes(request.progressId))) {
                request.release();
                continue;
            }
            const mode = request.definition.presentation ?? "popover";
            const autoSkipMs = request.definition.autoSkipMs === undefined
                ? (mode === "popover" ? TUTORIAL_AUTO_SKIP_MS : null) : request.definition.autoSkipMs;
            this.activeTutorial = { request, definition: request.definition, pageIndex: 0, autoSkipCancelled: autoSkipMs === null };
            this.renderTutorialSurface();
            return;
        }
    }
    tutorialResourceMarkup = (resource: TutorialResource): string => {
        return `<figure class="tutorial-resource"><img src="${escapeHtml(resource.src)}" alt="${escapeHtml(resource.alt)}">${resource.caption ? `<figcaption>${escapeHtml(resource.caption)}</figcaption>` : ""}</figure>`;
    };
    clearTutorialAutoSkip = (): void => {
        window.clearTimeout(this.tutorialAutoSkipTimer);
        this.tutorialAutoSkipTimer = undefined;
        this.tutorialDismissAnimation?.cancel();
        this.tutorialDismissAnimation = null;
    };
    clearTutorialSurface = (finished = true): void => {
        this.clearTutorialAutoSkip();
        if (this.surface instanceof HTMLDialogElement && this.surface.open) this.surface.close();
        this.surface?.remove();
        this.surface = null;
        if (finished) {
            this.releasePause?.();
            this.releasePause = undefined;
            if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
            this.returnFocus = undefined;
        }
    };
    private clearRequests(): void {
        this.queue.splice(0).forEach(request => request.release());
        this.activeTutorial?.request.release();
        this.activeTutorial = null;
        this.clearTutorialSurface();
    }
    discardActiveTutorial = (): void => {
        // Runtime mounts may offer tutorials before the first actual screen exists.
        if (this.ready) this.clearRequests();
    };
    cancelTutorialAutoSkip = (surface: HTMLElement): void => {
        if (!this.activeTutorial || this.activeTutorial.autoSkipCancelled) return;
        this.activeTutorial = { ...this.activeTutorial, autoSkipCancelled: true };
        this.clearTutorialAutoSkip();
        surface.classList.remove("is-auto-dismissing");
        surface.classList.add("is-auto-skip-cancelled");
    };
    startTutorialAutoSkip = (surface: HTMLElement): void => {
        if (!this.activeTutorial || this.activeTutorial.autoSkipCancelled) return;
        const delay = this.activeTutorial.definition.autoSkipMs ?? TUTORIAL_AUTO_SKIP_MS;
        surface.style.setProperty("--tutorial-auto-skip-ms", `${delay}ms`);
        this.tutorialAutoSkipTimer = window.setTimeout(() => {
            this.tutorialAutoSkipTimer = undefined;
            if (!this.activeTutorial || this.activeTutorial.autoSkipCancelled || !surface.isConnected) return;
            surface.classList.add("is-auto-dismissing");
            const animation = surface.animate([
                { opacity: 1, transform: "translateY(0) scale(1)" },
                { opacity: 0, transform: "translateY(-6px) scale(.985)" }
            ], { duration: this.deps.save.settings.reducedMotion ? 1 : TUTORIAL_DISMISS_MS, easing: "ease", fill: "forwards" });
            this.tutorialDismissAnimation = animation;
            void animation.finished.then(() => {
                if (this.tutorialDismissAnimation !== animation || !surface.isConnected || this.activeTutorial?.autoSkipCancelled) return;
                this.tutorialDismissAnimation = null;
                this.finishActiveTutorial();
            }).catch(() => undefined);
        }, delay);
    };
    finishActiveTutorial = (): void => {
        const active = this.activeTutorial;
        if (!active || this.saving) return;
        const { request } = active;
        this.clearTutorialAutoSkip();
        const current = this.deps.autosave?.getSave() ?? this.deps.save;
        const finish = () => {
            request.release();
            if (this.activeTutorial?.request === request) {
                this.activeTutorial = null;
                this.clearTutorialSurface();
            }
            this.showNext();
        };
        if (current.tutorialProgress.completedIds.includes(request.progressId)) { finish(); return; }
        this.saving = true;
        this.activeTutorial = { ...active, autoSkipCancelled: true, error: undefined };
        this.renderTutorialSurface();
        let addedCompletion = false;
        const persist = async () => {
            // Non-modal tutorials can finish while the player is editing another feature.
            // Await its pending snapshot before reading and extending the current save.
            if (this.deps.flushPendingSaveWrites) await this.deps.flushPendingSaveWrites();
            const current = this.deps.autosave?.getSave() ?? this.deps.save;
            const progress = completeTutorial(current.tutorialProgress, request.progressId);
            if (progress === current.tutorialProgress) return;
            addedCompletion = true;
            this.deps.save = { ...current, tutorialProgress: { completedIds: [...progress.completedIds] }, updatedAt: new Date().toISOString() };
            const autosave = this.deps.autosave;
            if (autosave) { autosave.updateSave(this.deps.save); await autosave.flush(); }
            else await this.deps.repository.saveLongTerm(this.deps.save);
        };
        this.pendingCompletion = persist().then(() => {
            this.saving = false;
            finish();
        }).catch(() => {
            this.saving = false;
            // Remove only this failed completion, preserving other concurrent save changes.
            if (addedCompletion) {
                const latest = this.deps.autosave?.getSave() ?? this.deps.save;
                this.deps.save = { ...latest, tutorialProgress: { completedIds: latest.tutorialProgress.completedIds.filter(id => id !== request.progressId) } };
                this.deps.autosave?.updateSave(this.deps.save);
                void this.deps.autosave?.flush().catch(() => undefined);
            }
            if (!this.disposed) {
                const error = "教程进度保存失败，请重试。";
                if (this.activeTutorial?.request === request) {
                    this.activeTutorial = { ...this.activeTutorial, autoSkipCancelled: true, error };
                    this.renderTutorialSurface();
                }
                this.deps.enqueueNotification(error);
                this.showNext();
            }
        });
    };
    renderTutorialSurface = (): void => {
        this.clearTutorialSurface(false);
        if (!this.activeTutorial) return;
        const { definition, pageIndex, autoSkipCancelled, request, error } = this.activeTutorial;
        const page = definition.pages[pageIndex];
        if (!page) return;
        const mode = definition.presentation ?? "popover";
        const surface = document.createElement(mode === "modal" ? "dialog" : "aside");
        this.surface = surface;
        surface.id = "tutorial-popover";
        surface.className = `tutorial-popover${autoSkipCancelled ? " is-auto-skip-cancelled" : ""}`;
        surface.dataset.tutorialId = request.progressId;
        surface.dataset.presentation = mode;
        surface.setAttribute("role", "dialog");
        surface.setAttribute("aria-modal", String(mode === "modal"));
        surface.setAttribute("aria-labelledby", "tutorial-title");
        surface.setAttribute("aria-describedby", "tutorial-copy");
        const lastPage = pageIndex === definition.pages.length - 1;
        const resources = page.resources?.map(this.tutorialResourceMarkup).join("") ?? "";
        const disabled = this.saving ? " disabled" : "";
        surface.innerHTML = `<div class="tutorial-heading"><span>教程 · ${pageIndex + 1} / ${definition.pages.length}</span><h2 id="tutorial-title">${escapeHtml(definition.title)}</h2></div><div class="tutorial-content"><p id="tutorial-copy">${escapeHtml(page.body)}</p>${resources ? `<div class="tutorial-resources">${resources}</div>` : ""}</div><div class="tutorial-actions"><button type="button" class="tutorial-skip" data-tutorial-skip${disabled}>跳过</button>${pageIndex > 0 ? `<button type="button" class="tutorial-skip" data-tutorial-previous${disabled}>上一步</button>` : ""}<button type="button" class="tutorial-next" data-tutorial-next${disabled}>${lastPage ? "好的" : "下一步"}</button></div><p class="tutorial-status" role="status">${this.saving ? "正在保存……" : escapeHtml(error ?? "")}</p><span class="tutorial-auto-progress" aria-hidden="true"></span>`;
        document.body.append(surface);
        if (surface instanceof HTMLDialogElement) {
            this.returnFocus ??= document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
            this.releasePause ??= this.deps.pauseAutoActions?.();
            surface.addEventListener("cancel", event => { event.preventDefault(); this.finishActiveTutorial(); });
            surface.showModal();
            surface.querySelector<HTMLButtonElement>("[data-tutorial-next]")?.focus();
        }
        const interact = (event: Event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target?.closest("[data-tutorial-skip]")) this.cancelTutorialAutoSkip(surface);
        };
        surface.addEventListener("pointerdown", interact, { capture: true });
        surface.addEventListener("click", interact, { capture: true });
        surface.addEventListener("keydown", interact, { capture: true });
        surface.addEventListener("focusin", interact);
        surface.querySelector<HTMLButtonElement>("[data-tutorial-skip]")?.addEventListener("click", this.finishActiveTutorial);
        const turnPage = (index: number) => {
            if (this.saving || this.activeTutorial?.request !== request) return;
            this.activeTutorial = { ...this.activeTutorial, pageIndex: index, autoSkipCancelled: true };
            this.renderTutorialSurface();
            this.surface?.querySelector<HTMLButtonElement>("[data-tutorial-next]")?.focus({ preventScroll: true });
        };
        surface.querySelector<HTMLButtonElement>("[data-tutorial-previous]")?.addEventListener("click", () => turnPage(pageIndex - 1));
        surface.querySelector<HTMLButtonElement>("[data-tutorial-next]")?.addEventListener("click", () => {
            if (lastPage) this.finishActiveTutorial();
            else turnPage(pageIndex + 1);
        });
        this.startTutorialAutoSkip(surface);
    };
    offerTutorial = (cue: TutorialCue): void => {
        if (this.disposed) return;
        const definition = firstTutorialForCue(cue, this.deps.save.tutorialProgress, this.deps.save.skipTutorial);
        if (definition) this.enqueue(definition, definition.id);
    };
}
