import type { GameRuntimeHandle, MountGameRuntimeOptions } from "../runtime-host";
import { gameAudio } from "../audio/game-audio";
import { syncMatchAudioState } from "../audio/match-audio";
import type { PluginRuntimeContext, PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import type { PluginSettingsSession } from "../content/packages/plugin-settings";
import type { MatchState } from "../core/match/types";
import { alertGameDialog, confirmGameDialog } from "../game-dialog";
import { bootLoad, restoreActiveMatch } from "../persistence/boot";
import { createPersistenceService } from "../persistence/factory";
import { bindNativePersistenceLifecycle } from "../persistence/lifecycle";
import { presentationStore } from "../persistence/presentation";
import { SaveValidationError, type LongTermSave } from "../persistence/schema";
import { requestPersistentStorage } from "../persistence/storage";
import { RuntimeExtensions } from "./runtime-extensions";
import { bindHapticLifecycle, haptics } from "../presentation/haptic-service";
import { presentInteractionHaptic } from "../presentation/haptics";
import { RESET_RUNTIME_CONFIRM_MESSAGE } from "../presentation/view-helpers";
import { resourceLoader } from "../resources/resource-loader";
import { type SkillArchetypeArt } from "../resources/skill-archetype-art";
import type { RuntimeScreenLoader } from "./contracts";
import { RuntimeScreenRouter } from "./screen-router";
import { CleanupErrors } from "./cleanup-errors";
export interface RuntimeControllerDependencies {
    pauseMatch: (paused: boolean) => void;
    clearActiveMatch: () => void;
    stopPluginMatch: () => void;
    disposeSession: () => Promise<void>;
    disposePresentation: () => void;
    resetPresentation: () => void;
    disposeLobby: () => void;
    disposeSkills: () => void;
    clearAiSchedule: () => void;
    readonly autosave: import("../runtime/session-ports").ActiveMatchPersistence | null;
    renderLobby: (layer?: import("../lobby-screen-module").LobbyLayer) => Promise<void>;
    enqueueNotification: (text: string) => void;
    requireAdultContentAcknowledgement: () => Promise<void>;
    createTutorialApi: (packageId: string, signal: AbortSignal) => import("../content/packages/plugin-tutorials").PluginTutorialApi;
    discardActiveTutorial: () => void;
    setTutorialsReady: () => void;
    flushTutorials?: () => Promise<void>;
    dispatch: (action: import("../core/match/types").Action) => void;
    writePluginSettings: (packageId: string, values: Readonly<Record<string, import("../content/packages/plugin-declarations").PluginSettingValue>>) => Promise<void>;
    scheduleAiTurn: (state: import("../core/match/types").MatchState) => void;
    devCalibrationCharacterId: () => string | null;
    renderDevRevolverCalibration: () => Promise<void>;
    resumeMatch: (match: import("../core/match/types").MatchState, loadedCharacter?: import("../content/characters/types").CharacterDefinition | undefined, restored?: boolean) => Promise<void>;
    renderError: (error: unknown) => void;
    deckQueue: {
        get: () => import("../core/skills/deck").SkillDeck;
        subscribe(listener: (deck: import("../core/skills/deck").SkillDeck, status: import("../presentation/deck-save-queue").DeckSaveStatus) => void): () => void;
        update(next: import("../core/skills/deck").SkillDeck): Promise<void>;
        flush: () => Promise<void>;
    } | undefined;
}
export class RuntimeController {
    constructor(private readonly deps: RuntimeControllerDependencies) { }
    root!: HTMLDivElement;
    repository!: ReturnType<typeof createPersistenceService>;
    mounted: boolean = false;
    extensions: RuntimeExtensions | undefined;
    private releaseSettingsWriter?: () => void;
    hapticLifecycleDisposer: (() => Promise<void>) | undefined;
    nativeLifecycleDisposer: (() => Promise<void>) | undefined;
    runtimeEventController: AbortController | undefined;
    requestExitToLauncher: (() => Promise<void>) | undefined;
    save!: LongTermSave;
    saveLoaded: boolean = false;
    interactionHapticsAttached: boolean = false;
    private router: RuntimeScreenRouter | undefined;
    navigateScreen = (loader: RuntimeScreenLoader): Promise<void> => this.router?.navigateModule(async () => {
        const module = await loader();
        return { mount: (context, signal, params) => {
            // The router has disposed the previous page; new mounts may now offer tutorials.
            this.deps.discardActiveTutorial();
            return module.mount(context, signal, params);
        } };
    }) ?? Promise.resolve();
    pluginSettingsSession: PluginSettingsSession | undefined;
    runtimeContributions: readonly PluginRuntimeContribution[] = [];
    pluginCredits: readonly import("../content/packages/plugin-credits").PluginCreditsSection[] = [];
    skillArchetypeArt: SkillArchetypeArt = {};
    interactionHapticsHandler = (event: Event): void => {
        const button = event.composedPath().find((entry): entry is HTMLButtonElement => entry instanceof HTMLButtonElement);
        if (button?.hasAttribute("data-own-haptic"))
            return;
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true")
            return;
        presentInteractionHaptic(!document.body.classList.contains("reduced-motion"));
    };
    attachInteractionHaptics = (): void => {
        if (this.interactionHapticsAttached)
            return;
        document.addEventListener("click", this.interactionHapticsHandler, { capture: true });
        this.interactionHapticsAttached = true;
    };
    detachInteractionHaptics = (): void => {
        if (!this.interactionHapticsAttached)
            return;
        document.removeEventListener("click", this.interactionHapticsHandler, { capture: true });
        this.interactionHapticsAttached = false;
    };
    pluginContext = (): PluginRuntimeContext => {
        return {
            root: this.root,
            audio: { setBgmScene: (scene) => gameAudio.setBgmScene(scene) },
            resources: resourceLoader,
            getSave: () => this.save,
            navigateToHistory: this.showHistoryScreen,
            navigateToExtension: this.showExtensionScreen
        };
    };
    showHistoryScreen = async (): Promise<void> => {
        await this.navigateScreen(async () => {
            const module = await import("../history-screen");
            return { mount: async (_context, signal) => {
                    this.deps.stopPluginMatch();
                    this.deps.resetPresentation();
                    this.deps.clearActiveMatch();
                    gameAudio.setBgmScene("lobby");
                    return module.mountHistoryScreen({
                        ...this.pluginContext(), replaceSave: next => { this.save = next; },
                        saveLongTerm: next => this.repository.saveLongTerm(next),
                        navigateToLobby: () => this.deps.renderLobby("menu"), contributions: this.runtimeContributions
                    }, signal);
                } };
        });
    };
    showUiPage = async (action: import("../content/packages/plugin-ui").PluginUiAction): Promise<void> => {
        await this.navigateScreen(async () => ({ mount: async (_context, signal) => {
            const lifetime = new AbortController();
            signal.addEventListener("abort", () => lifetime.abort(), { once: true, signal: lifetime.signal });
            if (signal.aborted) lifetime.abort();
            const shell = document.createElement("main");
            shell.className = "plugin-ui-page";
            const back = document.createElement("button");
            back.type = "button";
            back.className = "secondary-button";
            back.textContent = "返回主菜单";
            back.addEventListener("click", () => { void this.deps.renderLobby("menu"); }, { signal });
            const container = document.createElement("div");
            container.className = "plugin-ui-content";
            shell.append(back, container);
            this.root.replaceChildren(shell);
            try {
                const mounted = await action.mount({
                    container,
                    navigateToMenu: async () => { if (!lifetime.signal.aborted) await this.deps.renderLobby("menu"); },
                    alert: (title, message) => lifetime.signal.aborted ? Promise.resolve() : alertGameDialog(title, message),
                    confirm: (title, message, label) => lifetime.signal.aborted ? Promise.resolve(false) : confirmGameDialog(title, message, label)
                }, lifetime.signal);
                if (!mounted || typeof mounted.dispose !== "function") throw new Error("扩展页面缺少清理函数");
                return { dispose: async () => {
                    lifetime.abort();
                    try { await mounted.dispose(); } catch (error) { console.warn("扩展页面清理失败", error); }
                } };
            } catch (error) {
                lifetime.abort();
                if (!signal.aborted) {
                    container.textContent = "该功能暂时无法打开，请返回主菜单后重试。";
                    console.warn("扩展页面挂载失败", error);
                }
                return { dispose() {} };
            }
        } }));
    };
    showExtensionScreen = async (route: string): Promise<void> => {
        const mount = this.runtimeContributions.map(contribution => contribution.routes?.[route]).find(Boolean);
        if (!mount)
            return;
        await this.navigateScreen(async () => ({ mount: async (_context, signal) => {
                this.deps.stopPluginMatch();
                this.deps.resetPresentation();
                return mount(this.pluginContext(), signal);
            } }));
    };
    boot = async (): Promise<void> => {
        this.deps.clearAiSchedule();
        this.root.innerHTML = `<main class="loading-shell"><span class="mark">✦</span><p>正在洗牌……</p></main>`;
        try {
            const save = await bootLoad(this.repository);
            if (!this.mounted)
                return;
            this.save = save;
            this.pluginSettingsSession?.sync(this.save.settings.pluginSettings ?? {});
            this.saveLoaded = true;
            let activeMatch: MatchState | null;
            try {
                activeMatch = await restoreActiveMatch(this.repository);
            }
            catch (error) {
                if (!(error instanceof SaveValidationError) || error.kind !== "runtime" || !await confirmGameDialog("无法恢复未完成牌局", RESET_RUNTIME_CONFIRM_MESSAGE, "舍弃这局牌"))
                    throw error;
                presentationStore().clearAll();
                await this.repository.deleteRuntime();
                activeMatch = null;
            }
            if (!this.mounted)
                return;
            document.body.classList.toggle("reduced-motion", this.save.settings.reducedMotion);
            gameAudio.configure(this.save.settings.soundEnabled);
            haptics.configure(!this.save.settings.reducedMotion);
            gameAudio.preloadLobby();
            const unlockAudio = () => {
                gameAudio.unlock();
                const state = this.deps.autosave?.getState();
                if (state)
                    syncMatchAudioState(gameAudio, state);
            };
            const signal = this.runtimeEventController?.signal;
            document.addEventListener("pointerdown", unlockAudio, { capture: true, once: true, signal });
            document.addEventListener("keydown", unlockAudio, { capture: true, once: true, signal });
            document.addEventListener("visibilitychange", () => {
                if (document.hidden)
                    gameAudio.pauseBgm();
                else
                    gameAudio.restoreBgm();
            }, { signal });
            void requestPersistentStorage();
            await this.deps.requireAdultContentAcknowledgement();
            if (!this.mounted)
                return;
            this.extensions?.dispose();
            this.releaseSettingsWriter?.();
            this.releaseSettingsWriter = this.pluginSettingsSession?.bindWriter(this.deps.writePluginSettings);
            this.extensions = new RuntimeExtensions({
                context: this.pluginContext(), contributions: this.runtimeContributions,
                createTutorialApi: this.deps.createTutorialApi,
                getMatch: () => this.deps.autosave?.getState(), dispatch: this.deps.dispatch,
                autoActionsChanged: () => {
                    this.deps.clearAiSchedule();
                    const state = this.deps.autosave?.getState();
                    if (state && this.mounted) this.deps.scheduleAiTurn(state);
                }
            });
            await this.extensions.mount();
            if (!this.mounted) { this.extensions.dispose(); return; }
            if (import.meta.env.DEV && this.deps.devCalibrationCharacterId())
                await this.deps.renderDevRevolverCalibration();
            else if (activeMatch)
                await this.deps.resumeMatch(activeMatch);
            else
                await this.deps.renderLobby();
            if (this.mounted) this.deps.setTutorialsReady();
        }
        catch (error) {
            if (this.mounted)
                this.deps.renderError(error);
        }
    };
    requestGameRuntimeExit = async (): Promise<void> => {
        if (!this.requestExitToLauncher)
            throw new Error("启动器没有提供退出处理器。");
        await this.requestExitToLauncher();
    };
    disposeGameRuntime = async (): Promise<void> => {
        if (!this.mounted) return;
        const wasInert = this.root.inert;
        this.root.inert = true;
        this.deps.pauseMatch(true);
        this.deps.clearAiSchedule();
        try {
            await this.deps.deckQueue?.flush();
            await this.deps.flushTutorials?.();
            await this.deps.autosave?.flush();
            if (this.saveLoaded) await this.repository.closeGameRuntime(this.deps.autosave?.getSave() ?? this.save);
            else await this.repository.deleteRuntime();
            await this.repository.flush();
        } catch (error) {
            this.root.inert = wasInert;
            this.deps.pauseMatch(false);
            const state = this.deps.autosave?.getState();
            if (state) this.deps.scheduleAiTurn(state);
            throw error;
        }
        const abandonedMatchId = this.deps.autosave?.getState().id;
        this.mounted = false;
        const cleanup = new CleanupErrors();
        cleanup.run(() => this.runtimeEventController?.abort());
        // Start navigation cleanup now and capture its rejection before awaiting other owners.
        const closingNavigation = cleanup.runAsync(() => this.router?.dispose());
        cleanup.run(() => this.deps.disposePresentation());
        cleanup.run(() => this.deps.disposeLobby());
        cleanup.run(() => this.deps.disposeSkills());
        await cleanup.runAsync(() => this.deps.disposeSession());
        if (abandonedMatchId) cleanup.run(() => presentationStore().clearMatch(abandonedMatchId));
        cleanup.run(() => this.extensions?.dispose());
        this.extensions = undefined;
        cleanup.run(() => this.releaseSettingsWriter?.());
        this.releaseSettingsWriter = undefined;
        cleanup.run(this.detachInteractionHaptics);
        await closingNavigation;
        this.router = undefined;
        this.runtimeEventController = undefined;
        await cleanup.runAsync(() => this.hapticLifecycleDisposer?.());
        this.hapticLifecycleDisposer = undefined;
        await cleanup.runAsync(() => this.nativeLifecycleDisposer?.());
        this.nativeLifecycleDisposer = undefined;
        await cleanup.runAsync(() => presentationStore().flush());
        cleanup.run(() => resourceLoader.dispose());
        await cleanup.runAsync(() => gameAudio.dispose());
        cleanup.run(() => document.querySelector(".adult-content-warning-backdrop")?.remove());
        cleanup.run(() => document.body.classList.remove("reduced-motion", "shake"));
        cleanup.run(() => { this.root.inert = false; });
        cleanup.run(() => this.root.replaceChildren());
        cleanup.run(() => this.deps.clearActiveMatch());
        this.runtimeContributions = [];
        this.pluginCredits = [];
        this.pluginSettingsSession = undefined;
        this.skillArchetypeArt = {};
        this.saveLoaded = false;
        this.requestExitToLauncher = undefined;
        this.mounted = false;
        // The durable exit has succeeded. Teardown failures must not restore a dead session.
        const error = cleanup.error("游戏运行时清理失败。");
        if (error) console.error(error.message, error);
    };
    mountGameRuntime = async (options: MountGameRuntimeOptions): Promise<GameRuntimeHandle> => {
        if (this.mounted)
            throw new Error("游戏运行时已经存在。");
        this.root = options.root;
        this.runtimeContributions = options.contributions ?? [];
        this.pluginCredits = options.pluginCredits ?? [];
        this.pluginSettingsSession = options.pluginSettings;
        this.skillArchetypeArt = this.runtimeContributions.reduce<SkillArchetypeArt>((art, contribution) => ({ ...art, ...contribution.skillArchetypeArt }), {});
        this.repository = createPersistenceService();
        this.requestExitToLauncher = options.onExitRequest;
        this.runtimeEventController = new AbortController();
        this.router = new RuntimeScreenRouter({
            root: this.root, getSave: () => this.save,
            navigate: destination => destination.id === "history" ? this.showHistoryScreen() : this.deps.renderLobby(destination.params?.layer === "characters" ? "characters" : "menu"),
            reportNavigationError: this.deps.enqueueNotification
        }, {});
        this.mounted = true;
        try {
            this.hapticLifecycleDisposer = await bindHapticLifecycle();
            this.attachInteractionHaptics();
            this.nativeLifecycleDisposer = await bindNativePersistenceLifecycle(async () => {
                await this.deps.autosave?.flush();
                await this.repository.flush();
                await presentationStore().flush();
            });
            await this.boot();
            return { dispose: this.disposeGameRuntime };
        }
        catch (error) {
            await this.disposeGameRuntime();
            throw error;
        }
    };
}
