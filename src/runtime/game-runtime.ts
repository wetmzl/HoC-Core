import type { GameRuntimeHandle, MountGameRuntimeOptions } from "../runtime-host";
import { gameAudio } from "../audio/game-audio";
import { CHARACTER_CATALOG, getCharacterMetadata } from "../content/characters";
import { DEFAULT_MUSIC_VOLUME } from "../audio/music-volume";
import { syncMatchAudioState } from "../audio/match-audio";
import type { PluginRuntimeContext, PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import type { PluginSettingsSession } from "../content/packages/plugin-settings";
import type { MatchState } from "../core/match/types";
import { alertGameDialog, confirmGameDialog } from "../game-dialog";
import { bootLoad } from "../persistence/boot";
import { createPersistenceService } from "../persistence/factory";
import { gameTelemetry, setTelemetryPackages } from "../telemetry";
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
import { changeCharacterSkinUnlocks, grantDeclaredSkinUnlocks, isCharacterSkinUnlocked } from "../persistence/skin-unlocks";
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
    flushSettings?: () => Promise<void>;
    writeCharacterSkinUnlocks?: (update: (save: LongTermSave) => LongTermSave) => Promise<void>;
    redrawLobbyCharacters?: () => void;
    dispatch: (action: import("../core/match/types").Action) => void;
    writePluginSettings: (packageId: string, values: Readonly<Record<string, import("../content/packages/plugin-declarations").PluginSettingValue>>) => Promise<void>;
    scheduleAiTurn: (state: import("../core/match/types").MatchState) => void;
    devCalibrationCharacterId: () => string | null;
    renderDevRevolverCalibration: () => Promise<void>;
    pauseEncounters?: (paused: boolean) => void;
    flushEncounters?: () => Promise<void>;
    restoreEncounter?: (snapshot: import("../persistence/schema").RuntimeSave) => Promise<void>;
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
    private preparePresentation?: MountGameRuntimeOptions["preparePresentation"];
    loadSkinPreviews?: MountGameRuntimeOptions["loadSkinPreviews"];
    private appliedSkins = "";
    private changingSkin = false;
    private closing = false;
    private skinUnlockWrites: Promise<void> = Promise.resolve();
    isSkinUnlocked = (characterId: string, skinId: string): boolean => {
        const appearance = getCharacterMetadata(characterId)?.appearance;
        return !!appearance && isCharacterSkinUnlocked(this.save, appearance, skinId);
    };
    private writeSkinUnlocks = (characterId: string, changes: Readonly<Record<string, boolean>> | null): Promise<void> => {
        // Detach caller-owned data before any asynchronous work.
        const snapshot = changes === null ? null : { ...changes };
        if (this.closing || !this.mounted) return Promise.reject(new Error("游戏运行时已退出。"));
        const write = this.skinUnlockWrites.catch(() => {}).then(async () => {
            if (!this.mounted || this.changingSkin || !this.deps.writeCharacterSkinUnlocks) throw new Error("请稍后重试修改服装解锁状态。");
            this.changingSkin = true;
            try {
                await this.deps.flushTutorials?.();
                await this.deps.writeCharacterSkinUnlocks(save => {
                    const appearance = getCharacterMetadata(characterId)?.appearance;
                    if (!appearance) throw new Error("角色服装不可用。");
                    return changeCharacterSkinUnlocks(save, appearance, snapshot);
                });
                this.root.dispatchEvent(new Event("character-skin-unlocks-changed"));
            } finally { this.changingSkin = false; }
        });
        this.skinUnlockWrites = write;
        return write;
    };
    private pendingSkinSelection?: { cancel: AbortController; settled: Promise<void> };
    private readonly presentationRetirements = new Set<() => void>();
    private redrawPresentation = (): void => {
        try { this.deps.redrawLobbyCharacters?.(); }
        catch (error) { console.warn("角色外观已保存，角色列表刷新失败。", error); }
    };
    private retirePresentation = (retire: () => void, signal?: AbortSignal): void => {
        const safelyRetire = () => {
            try { retire(); }
            catch (error) { console.warn("角色外观已切换，旧资源清理失败。", error); }
        };
        if (!signal || signal.aborted || !this.mounted) { safelyRetire(); return; }
        const release = () => {
            if (!this.presentationRetirements.delete(release)) return;
            signal.removeEventListener("abort", release);
            safelyRetire();
        };
        this.presentationRetirements.add(release);
        signal.addEventListener("abort", release, { once: true });
    };
    private preferenceKey = (preferences: import("../content/packages/character-presentation").CharacterSkinPreferences, unlocks = this.save?.characterSkinUnlocks): string => JSON.stringify([
        Object.entries(preferences).sort(([a], [b]) => a.localeCompare(b)),
        Object.entries(unlocks ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Object.entries(value).sort(([a], [b]) => a.localeCompare(b))])
    ]);
    private mountExtensions = async (): Promise<void> => {
        this.extensions?.dispose();
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
        if (!this.mounted) this.extensions.dispose();
    };
    private useContributions = (contributions: readonly PluginRuntimeContribution[]): void => {
        this.runtimeContributions = contributions;
        this.skillArchetypeArt = contributions.reduce<SkillArchetypeArt>((art, contribution) => ({ ...art, ...contribution.skillArchetypeArt }), {});
    };
    syncCharacterSkins = async (): Promise<void> => {
        if (this.changingSkin) return;
        if (grantDeclaredSkinUnlocks(this.save, CHARACTER_CATALOG) !== this.save) {
            await this.deps.flushTutorials?.();
            if (this.changingSkin) return;
            if (this.deps.writeCharacterSkinUnlocks) await this.deps.writeCharacterSkinUnlocks(save => grantDeclaredSkinUnlocks(save, CHARACTER_CATALOG));
            else {
                const granted = grantDeclaredSkinUnlocks(this.save, CHARACTER_CATALOG);
                await this.repository.saveLongTerm(granted);
                this.save = granted;
            }
        }
        const preferences = this.save.settings.characterSkins ?? {};
        const key = this.preferenceKey(preferences);
        if (!this.preparePresentation || key === this.appliedSkins || this.changingSkin) return;
        this.changingSkin = true;
        let prepared: import("../runtime-host").PreparedGamePresentation | undefined;
        const previous = this.runtimeContributions;
        try {
            prepared = await this.preparePresentation(preferences, this.save.characterSkinUnlocks);
            if (!this.mounted) return;
            this.extensions?.dispose();
            prepared.activate(); this.useContributions(prepared.contributions);
            if (this.extensions) await this.mountExtensions();
            this.appliedSkins = key;
            this.redrawPresentation();
            const committed = prepared;
            this.retirePresentation(() => committed.retirePrevious());
        } catch (error) {
            prepared?.rollback(); this.useContributions(previous);
            throw error;
        } finally { prepared?.dispose(); this.changingSkin = false; }
    };
    selectCharacterSkin = async (characterId: string, skinId: string, signal: AbortSignal, retainPreviousUntil?: AbortSignal): Promise<void> => {
        const cancel = new AbortController();
        const settled = this.commitCharacterSkin(characterId, skinId, AbortSignal.any([signal, cancel.signal]), retainPreviousUntil);
        const selection = { cancel, settled };
        // A concurrent rejected request must not replace the active transaction.
        if (!this.pendingSkinSelection) this.pendingSkinSelection = selection;
        try { await settled; }
        finally { if (this.pendingSkinSelection === selection) this.pendingSkinSelection = undefined; }
    };
    private commitCharacterSkin = async (characterId: string, skinId: string, signal: AbortSignal, retainPreviousUntil?: AbortSignal): Promise<void> => {
        if (signal.aborted) throw new Error("换装已取消。");
        if (!this.mounted || this.closing || this.changingSkin || !this.preparePresentation || this.deps.autosave) throw new Error("请在与会者大厅稍后重试换装。");
        const appearance = getCharacterMetadata(characterId)?.appearance;
        if (!appearance?.skins.some(skin => skin.id === skinId)) throw new Error("所选服装不可用。");
        if (!isCharacterSkinUnlocked(this.save, appearance, skinId)) throw new Error("该服装尚未解锁。");
        if (appearance.skinId === skinId) return;
        this.changingSkin = true;
        let prepared: import("../runtime-host").PreparedGamePresentation | undefined;
        let previousSave: LongTermSave | undefined;
        const previous = this.runtimeContributions;
        try {
            await this.deps.flushSettings?.();
            await this.deps.deckQueue?.flush();
            await this.deps.flushTutorials?.();
            const preferences = { ...this.save.settings.characterSkins, [appearance.key]: skinId };
            prepared = await this.preparePresentation(preferences, this.save.characterSkinUnlocks);
            const character = prepared.characters.find(character => character.id === characterId);
            if (!character) throw new Error("角色暂时不可用。");
            const loaded = await resourceLoader.enqueue([character.previewImage, character.dialogue.poolPortraits![character.dialogue.fallbackPoolId].image], "visible");
            if (loaded.some(value => !value)) throw new Error("服装立绘加载失败，请重试。");
            if (!this.mounted || signal.aborted) throw new Error("换装已取消。");
            previousSave = this.save;
            const next = { ...this.save, settings: { ...this.save.settings, characterSkins: preferences }, updatedAt: new Date().toISOString() };
            await this.repository.saveLongTerm(next);
            this.save = next;
            if (!this.mounted) return;
            if (signal.aborted || this.deps.autosave) throw new Error("换装已取消。");
            this.extensions?.dispose();
            prepared.activate(); this.useContributions(prepared.contributions);
            await this.mountExtensions();
            this.appliedSkins = this.preferenceKey(preferences);
            this.redrawPresentation();
            const committed = prepared;
            this.retirePresentation(() => committed.retirePrevious(), retainPreviousUntil);
        } catch (error) {
            prepared?.rollback(); this.useContributions(previous);
            if (previousSave && this.mounted) {
                await this.repository.saveLongTerm(previousSave);
                this.save = previousSave;
                await this.mountExtensions();
            }
            throw error;
        } finally { prepared?.dispose(); this.changingSkin = false; }
    };
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
            ...(this.deps.writeCharacterSkinUnlocks ? { characterSkinUnlocks: {
                get: (id: string) => getCharacterMetadata(id)?.appearance?.skins.map(skin => ({ ...structuredClone(skin), unlocked: this.isSkinUnlocked(id, skin.id) })),
                isUnlocked: this.isSkinUnlocked,
                setMany: this.writeSkinUnlocks,
                setUnlocked: (id: string, skinId: string, unlocked: boolean) => this.writeSkinUnlocks(id, { [skinId]: unlocked }),
                unlock: (id: string, skinId: string) => this.writeSkinUnlocks(id, { [skinId]: true }),
                lock: (id: string, skinId: string) => this.writeSkinUnlocks(id, { [skinId]: false }),
                reset: (id: string) => this.writeSkinUnlocks(id, null)
            } } : {}),
            root: this.root,
            audio: { setBgmScene: (scene) => gameAudio.setBgmScene(scene) },
            resources: resourceLoader,
            ...(this.preparePresentation ? { characterPresentation: {
                get: (id: string) => {
                    const appearance = getCharacterMetadata(id)?.appearance;
                    return appearance ? { ...appearance, skins: appearance.skins.map(skin => structuredClone(skin)) } : undefined;
                },
                select: (id: string, skinId: string, signal: AbortSignal) => this.selectCharacterSkin(id, skinId, signal, signal)
            } } : {}),
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
            await gameTelemetry()?.start().catch(() => undefined);
            await this.syncCharacterSkins();
            this.pluginSettingsSession?.sync(this.save.settings.pluginSettings ?? {});
            this.saveLoaded = true;
            let activeMatch: MatchState | null;
            let activeRuntime: import("../persistence/schema").RuntimeSave | null = null;
            try {
                const runtime = await this.repository.loadRuntime();
                activeMatch = runtime?.activeMatch ?? null;
                activeRuntime = runtime;
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
            gameAudio.configure(this.save.settings.soundEnabled, this.save.settings.musicVolume ?? DEFAULT_MUSIC_VOLUME);
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
            await this.mountExtensions();
            if (!this.mounted) return;
            if (import.meta.env.DEV && this.deps.devCalibrationCharacterId())
                await this.deps.renderDevRevolverCalibration();
            else if (activeRuntime && (activeRuntime.activeProgram || activeRuntime.activeFlow || activeRuntime.activeChallenge || activeMatch) && this.deps.restoreEncounter)
                await this.deps.restoreEncounter(activeRuntime);
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
        this.closing = true;
        const wasInert = this.root.inert;
        this.root.inert = true;
        this.deps.pauseEncounters?.(true);
        try {
            const selection = this.pendingSkinSelection;
            selection?.cancel.abort();
            // Complete any cancellation rollback before closing the repository;
            // the next runtime must not race a late appearance write.
            await selection?.settled.catch(() => undefined);
            await this.skinUnlockWrites.catch(() => undefined);
            await this.deps.flushSettings?.();
            await this.deps.flushEncounters?.();
            this.deps.pauseMatch(true);
            this.deps.clearAiSchedule();
            await this.deps.deckQueue?.flush();
            await this.deps.flushTutorials?.();
            await this.deps.autosave?.flush();
            await gameTelemetry()?.flush().catch(() => undefined);
            if (this.saveLoaded) await this.repository.closeGameRuntime(this.deps.autosave?.getSave() ?? this.save);
            else await this.repository.deleteRuntime();
            await this.repository.flush();
        } catch (error) {
            this.closing = false;
            this.root.inert = wasInert;
            this.deps.pauseEncounters?.(false);
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
        for (const release of [...this.presentationRetirements]) cleanup.run(release);
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
        this.preparePresentation = undefined;
        this.loadSkinPreviews = undefined;
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
        this.closing = false;
        setTelemetryPackages(options.telemetryPackages ?? {});
        this.runtimeContributions = options.contributions ?? [];
        this.preparePresentation = options.preparePresentation;
        this.loadSkinPreviews = options.loadSkinPreviews;
        this.appliedSkins = this.preferenceKey(options.characterSkins ?? {}, options.characterSkinUnlocks);
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
