import { mountEmbeddedOfflineControls } from "../resources/embedded-offline";
import { gameAudio } from "../audio/game-audio";
import { openSkinPicker } from "../presentation/skin-picker";
import { isCharacterSkinUnlocked } from "../persistence/skin-unlocks";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, defeatedCharacterIdsByFirstDefeat, getCharacterMetadata, isCharacterUnlocked } from "../content/characters";
import { alertGameDialog } from "../game-dialog";
import type { LobbyLayer } from "../lobby-screen-module";
import { mountPluginSettingsForm } from "../presentation/plugin-settings-form";
import { mountSaveRecovery } from "../presentation/save-recovery";
import { DEFEATED_GUEST_BATCH_SIZE, uiError } from "../presentation/view-helpers";
import { lobbyResourceUrls, resourceLoader } from "../resources/resource-loader";
import { skillArchetypeArtUrls } from "../resources/skill-archetype-art";
export interface LobbyScreenDependencies {
    syncCharacterSkins?: () => Promise<void>;
    loadSkinPreviews?: (key: string, signal: AbortSignal) => Promise<import("../content/packages/skin-previews").SkinPreviews>;
    selectCharacterSkin?: (id: string, skinId: string, signal: AbortSignal) => Promise<void>;
    readonly mainMenuActions: readonly import("../presentation/main-menu-actions").MainMenuAction[];
    readonly pluginCredits: readonly import("../content/packages/plugin-credits").PluginCreditsSection[];
    clearActiveMatch: () => void;
    navigateScreen: (loader: import("../runtime/contracts").RuntimeScreenLoader) => Promise<void>;
    save: import("../persistence/schema").LongTermSave;
    root: HTMLDivElement;
    handScroll: import("../presentation/hand-scroll").HandScrollController;
    stopPluginMatch: () => void;
    renderError: (error: unknown) => void;
    discardActiveTutorial: () => void;
    clearAiSchedule: () => void;
    resetDialogue: () => void;
    clearAbilityNoticeQueue: () => void;
    detachFullscreenListener: () => void;
    skillArchetypeArt: Partial<Record<import("../core/skills/types").SkillTag, {
        readonly default?: string | undefined;
        readonly selected?: string | undefined;
    }>>;
    disposeDeckEditor: (() => void) | undefined;
    requestGameRuntimeExit: () => Promise<void>;
    updateSettings: (event: Event) => Promise<void>;
    writePluginSettings: (packageId: string, values: Record<string, import("../content/packages/plugin-declarations").PluginSettingValue>) => Promise<void>;
    pluginSettingsSession: import("../content/packages/plugin-settings").PluginSettingsSession | undefined;
    repository: import("../persistence/save-service").PersistenceService;
    exportSave: () => Promise<void>;
    requestImport: () => void;
    importFile: (event: Event) => void;
    exportFailedImport: () => Promise<void>;
    confirmResetCurrentData: () => Promise<boolean>;
    resetCurrentData: () => Promise<void>;
    openProfile: (id: string) => Promise<void>;
    invalidateProfile: () => void;
}
export class LobbyScreen {
    private disposed = false;
    dispose = (): void => {
        this.disposed = true;
        this.deps.invalidateProfile();
        this.defeatedGuestObserver?.disconnect();
        this.defeatedGuestObserver = null;
        this.lobbyModulePromise = undefined;
        this.lobbyModule = undefined;
    };
    constructor(private readonly deps: LobbyScreenDependencies) { }
    selectedCharacterId: string = DEFAULT_CHARACTER_ID;
    lobbyLayer: LobbyLayer = "menu";
    guestSelectionIds: string[] = [];
    defeatedGuestObserver: IntersectionObserver | null = null;
    lobbyModulePromise: Promise<typeof import("../lobby-screen-module")> | undefined;
    lobbyModule: typeof import("../lobby-screen-module") | undefined;
    randomUnit = (): number => {
        const bytes = new Uint32Array(1);
        if (globalThis.crypto?.getRandomValues)
            return globalThis.crypto.getRandomValues(bytes)[0] / 0x100000000;
        return Math.random();
    };
    eligibleGuestIds = (): string[] => {
        const defeated = new Set(defeatedCharacterIdsByFirstDefeat(this.deps.save.defeats));
        return CHARACTER_CATALOG
            .filter((character) => isCharacterUnlocked(character, this.deps.save.defeats) && !defeated.has(character.id))
            .map((character) => character.id);
    };
    selectGuestIds = (): string[] => {
        const available = this.eligibleGuestIds().map((id) => getCharacterMetadata(id)).filter((character): character is NonNullable<typeof character> => Boolean(character));
        const shuffled = [...available];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(this.randomUnit() * (index + 1));
            [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
        }
        const next = shuffled.slice(0, 3).map((character) => character.id);
        if (available.length > 3 && this.guestSelectionIds.length > 0) {
            const current = new Set(this.guestSelectionIds);
            if (next.every((id) => current.has(id))) {
                const replacement = shuffled.find((character) => !current.has(character.id));
                if (replacement)
                    next[Math.floor(this.randomUnit() * next.length)] = replacement.id;
            }
        }
        else if (next.length > 1 && next.join(",") === this.guestSelectionIds.join(",")) {
            [next[0], next[1]] = [next[1], next[0]];
        }
        return next;
    };
    defeatedCharactersNewestFirst = (): (typeof CHARACTER_CATALOG)[number][] => {
        return [...defeatedCharacterIdsByFirstDefeat(this.deps.save.defeats)]
            .reverse()
            .map((id) => getCharacterMetadata(id))
            .filter((character): character is NonNullable<typeof character> => Boolean(character));
    };
    wireInviteButtons = (container: ParentNode): void => {
        container.querySelectorAll<HTMLButtonElement>("[data-invite-character]:not([data-invite-wired])").forEach((button) => {
            button.dataset.inviteWired = "true";
            button.addEventListener("click", () => void this.openProfile(button.dataset.inviteCharacter ?? ""));
        });
    };
    loadMoreDefeatedGuests = (): void => {
        const list = this.deps.root.querySelector<HTMLElement>("#defeated-character-list");
        const control = this.deps.root.querySelector<HTMLButtonElement>("[data-load-more-defeated]");
        if (!list || !control)
            return;
        const defeatedCharacters = this.defeatedCharactersNewestFirst();
        const visibleCount = list.querySelectorAll(":scope > .character-card").length;
        const nextCharacters = defeatedCharacters.slice(visibleCount, visibleCount + DEFEATED_GUEST_BATCH_SIZE);
        list.insertAdjacentHTML("beforeend", nextCharacters.map((character) => this.lobbyModule?.characterCardMarkup(character, true) ?? "").join(""));
        this.wireInviteButtons(list);
        const remaining = defeatedCharacters.length - visibleCount - nextCharacters.length;
        if (remaining <= 0) {
            this.defeatedGuestObserver?.disconnect();
            this.defeatedGuestObserver = null;
            control.remove();
            return;
        }
        control.setAttribute("aria-label", `加载更多已击败宾客，剩余 ${remaining} 名`);
        const count = control.querySelector("small");
        if (count)
            count.textContent = `剩余 ${remaining} 名`;
    };
    wireDefeatedGuestLoader = (): void => {
        const control = this.deps.root.querySelector<HTMLButtonElement>("[data-load-more-defeated]");
        if (!control)
            return;
        control.addEventListener("click", this.loadMoreDefeatedGuests);
        if (!("IntersectionObserver" in window))
            return;
        this.defeatedGuestObserver = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting))
                this.loadMoreDefeatedGuests();
        }, { rootMargin: "0px 0px 160px" });
        this.defeatedGuestObserver.observe(control);
    };
    redrawCharacters = (): void => {
        if (this.disposed || !this.lobbyModule) return;
        for (const card of this.deps.root.querySelectorAll<HTMLElement>(".character-card[data-character-id]")) {
            const metadata = getCharacterMetadata(card.dataset.characterId!);
            if (!metadata) continue;
            const actionId = card.querySelector<HTMLButtonElement>("[data-ui-action]")?.dataset.uiAction;
            const action = actionId ? this.deps.mainMenuActions.find(action => action.id === actionId) : undefined;
            const scroll = card.querySelector<HTMLElement>(".character-copy > p:not(.eyebrow)")?.scrollTop ?? 0;
            const template = document.createElement("template");
            template.innerHTML = this.lobbyModule.characterCardMarkup(metadata, card.classList.contains("is-defeated"), action);
            card.innerHTML = template.content.firstElementChild!.innerHTML;
            const description = card.querySelector<HTMLElement>(".character-copy > p:not(.eyebrow)");
            if (description) description.scrollTop = scroll;
            this.wireInviteButtons(card);
        }
    };
    renderLobby = async (layer: LobbyLayer = "menu"): Promise<void> => {
        if (this.disposed)
            return;
        this.deps.invalidateProfile();
        await this.deps.syncCharacterSkins?.();
        await this.deps.navigateScreen(async () => {
            this.lobbyModulePromise ??= import("../lobby-screen-module").catch(error => {
                this.lobbyModulePromise = undefined;
                throw error;
            });
            const module = await this.lobbyModulePromise;
            return { mount: async (_context, signal) => {
                    if (this.disposed || signal.aborted)
                        return { dispose() { } };
                    this.lobbyModule = module;
                    this.showLobby(layer, signal);
                    return { dispose: () => { this.defeatedGuestObserver?.disconnect(); this.defeatedGuestObserver = null; this.deps.disposeDeckEditor?.(); } };
                } };
        });
    };
    private showLobby = (layer: LobbyLayer, signal: AbortSignal): void => {
        this.deps.handScroll.dispose();
        this.deps.stopPluginMatch();
        this.deps.discardActiveTutorial();
        this.deps.clearAiSchedule();
        this.deps.resetDialogue();
        gameAudio.stopHeartbeat();
        gameAudio.setBgmScene("lobby");
        this.deps.clearAbilityNoticeQueue();
        this.deps.detachFullscreenListener();
        this.deps.clearActiveMatch();
        this.lobbyLayer = layer;
        void resourceLoader.enqueue(lobbyResourceUrls(CHARACTER_CATALOG.filter((character) => isCharacterUnlocked(character, this.deps.save.defeats))), "background");
        void resourceLoader.enqueue(skillArchetypeArtUrls(this.deps.skillArchetypeArt), "deferred");
        this.defeatedGuestObserver?.disconnect();
        this.defeatedGuestObserver = null;
        if (layer === "characters") {
            const eligible = new Set(this.eligibleGuestIds());
            const expectedCount = Math.min(3, eligible.size);
            if (this.guestSelectionIds.length !== expectedCount || this.guestSelectionIds.some((id) => !eligible.has(id)))
                this.guestSelectionIds = this.selectGuestIds();
        }
        const guestCharacters = this.guestSelectionIds.map((id) => getCharacterMetadata(id)).filter((character): character is NonNullable<typeof character> => Boolean(character));
        const defeatedCharacters = this.defeatedCharactersNewestFirst();
        const visibleDefeatedCharacters = defeatedCharacters.slice(0, DEFEATED_GUEST_BATCH_SIZE);
        const defeatedGuestsRemaining = defeatedCharacters.length - visibleDefeatedCharacters.length;
        this.deps.disposeDeckEditor?.();
        this.deps.disposeDeckEditor = undefined;
        const menuActions = this.deps.mainMenuActions;
        this.deps.root.innerHTML = this.lobbyModule!.renderLobbyMarkup({ menuActions, save: this.deps.save, layer, guests: guestCharacters, defeated: defeatedCharacters, visibleDefeated: visibleDefeatedCharacters, defeatedRemaining: defeatedGuestsRemaining, pluginCredits: this.deps.pluginCredits });
        const disposeOffline = mountEmbeddedOfflineControls(this.deps.root.querySelector('[data-embedded-offline]'));
        signal.addEventListener("abort", disposeOffline, { once: true });
        this.deps.root.querySelector<HTMLButtonElement>("[data-enter-duel]")?.addEventListener("click", () => { this.guestSelectionIds = []; void this.renderLobby("characters"); });
        this.deps.root.querySelector<HTMLButtonElement>("[data-lobby-home]")?.addEventListener("click", () => { void this.renderLobby("menu"); });
        this.deps.root.querySelector<HTMLButtonElement>("[data-refresh-guests]")?.addEventListener("click", () => { this.guestSelectionIds = this.selectGuestIds(); void this.renderLobby("characters"); });
        this.deps.root.addEventListener("click", event => {
            const skinButton = (event.target as Element).closest<HTMLButtonElement>("[data-change-skin]");
            if (skinButton && this.deps.loadSkinPreviews && this.deps.selectCharacterSkin) {
                const character = getCharacterMetadata(skinButton.dataset.changeSkin!);
                if (character) openSkinPicker({ root: this.deps.root, character, signal, load: this.deps.loadSkinPreviews, select: this.deps.selectCharacterSkin,
                    isUnlocked: id => !!character.appearance && isCharacterSkinUnlocked(this.deps.save, character.appearance, id) });
                return;
            }
            const button = (event.target as Element).closest<HTMLButtonElement>("[data-ui-action]");
            if (!button) return;
            const action = this.deps.mainMenuActions.find(action => action.id === button.dataset.uiAction);
            if (!action || signal.aborted || button.disabled) return;
            button.disabled = true;
            void Promise.resolve().then(() => { if (!signal.aborted) return action.activate(); }).catch(error => {
                if (!signal.aborted) void alertGameDialog("打开失败", uiError(error, "该功能暂时无法打开，请重试。"));
            }).finally(() => { if (!signal.aborted) button.disabled = false; });
        }, { signal });
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
        let badgeHint: HTMLElement | null = null;
        let badgeHintTimer: ReturnType<typeof setTimeout> | undefined;
        const hideBadgeHint = (): void => {
            clearTimeout(badgeHintTimer);
            if (badgeHint) { badgeHint.hidden = true; badgeHint.textContent = ""; }
            badgeHint = null;
        };
        signal.addEventListener("abort", hideBadgeHint, { once: true });
        this.deps.root.addEventListener("error", event => {
            if (!(event.target instanceof HTMLImageElement)) return;
            const badge = event.target.closest<HTMLElement>(".character-badge");
            if (badge) { hideBadgeHint(); badge.hidden = true; }
            const factionIcon = event.target.closest<HTMLElement>(".boss-faction-icon");
            if (factionIcon) factionIcon.hidden = true;
        }, { signal, capture: true });
        // Delegate so cards appended by the defeated-guest loader work too.
        this.deps.root.addEventListener("click", event => {
            const button = (event.target as Element).closest<HTMLButtonElement>("[data-badge-label]");
            if (!button) return;
            hideBadgeHint();
            badgeHint = button.parentElement?.querySelector<HTMLElement>(".character-badge-hint") ?? null;
            if (!badgeHint) return;
            badgeHint.textContent = button.dataset.badgeLabel ?? "";
            badgeHint.hidden = false;
            badgeHintTimer = setTimeout(hideBadgeHint, 1600);
        }, { signal });
        this.wireInviteButtons(this.deps.root);
        this.wireDefeatedGuestLoader();
        this.deps.root.querySelector<HTMLButtonElement>("[data-exit-launcher]")?.addEventListener("click", (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            void this.deps.requestGameRuntimeExit().catch((error) => {
                button.disabled = false;
                void alertGameDialog("返回启动器失败", uiError(error, "返回启动器失败。"));
            });
        });
        this.deps.root.querySelectorAll<HTMLInputElement>("[data-setting]").forEach((input) => input.addEventListener("change", this.deps.updateSettings));
        this.deps.root.querySelector<HTMLInputElement>('[data-setting="musicVolume"]')?.addEventListener("input", event => {
            const input = event.target as HTMLInputElement;
            gameAudio.setMusicVolume(input.valueAsNumber);
            const readout = this.deps.root.querySelector<HTMLElement>("[data-music-volume-value]");
            if (readout) readout.textContent = `${Math.round(input.valueAsNumber * 100)}%`;
        });
        const settingsForm = this.deps.root.querySelector<HTMLElement>("[data-plugin-settings-form]");
        if (settingsForm && this.deps.pluginSettingsSession)
            mountPluginSettingsForm(settingsForm, this.deps.pluginSettingsSession, this.deps.writePluginSettings);
        this.deps.root.querySelector<HTMLButtonElement>("[data-export]")?.addEventListener("click", () => void this.deps.exportSave());
        const recovery = this.deps.root.querySelector<HTMLElement>("[data-save-recovery]");
        if (recovery) mountSaveRecovery(recovery, this.deps.save);
        this.deps.root.querySelector<HTMLButtonElement>("[data-import]")?.addEventListener("click", () => void this.deps.requestImport());
        this.deps.root.querySelector<HTMLInputElement>("#save-file")?.addEventListener("change", this.deps.importFile);
        this.deps.root.querySelector<HTMLButtonElement>("[data-export-import]")?.addEventListener("click", () => void this.deps.exportFailedImport());
        this.deps.root.querySelector<HTMLButtonElement>("[data-reset]")?.addEventListener("click", () => {
            void this.deps.confirmResetCurrentData().then((confirmed) => {
                if (confirmed)
                    return this.deps.resetCurrentData();
            }).catch(this.deps.renderError);
        });
    };
    openProfile = (id: string): Promise<void> => this.deps.openProfile(id);
}
