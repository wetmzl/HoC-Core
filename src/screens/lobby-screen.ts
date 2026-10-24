import { skillRulesMarkup } from "../presentation/skill-copy";
import { gameAudio } from "../audio/game-audio";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, defeatedCharacterIdsByFirstDefeat, getCharacterMetadata, isCharacterUnlocked, loadCharacter } from "../content/characters";
import { getAbilityDefinition } from "../core/abilities/registry";
import { alertGameDialog } from "../game-dialog";
import type { LobbyLayer } from "../lobby-screen-module";
import { mountPluginSettingsForm } from "../presentation/plugin-settings-form";
import { mountSaveRecovery } from "../presentation/save-recovery";
import { DEFEATED_GUEST_BATCH_SIZE, escapeHtml, uiError, unlockConditionLabel } from "../presentation/view-helpers";
import { lobbyResourceUrls, resourceLoader } from "../resources/resource-loader";
import { skillArchetypeArtUrls } from "../resources/skill-archetype-art";
export interface LobbyScreenDependencies {
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
    pluginSettingsSession: import("../content/packages/plugin-settings").PluginSettingsSession | undefined;
    repository: import("../persistence/save-service").PersistenceService;
    exportSave: () => Promise<void>;
    requestImport: () => void;
    importFile: (event: Event) => void;
    exportFailedImport: () => Promise<void>;
    confirmResetCurrentData: () => Promise<boolean>;
    resetCurrentData: () => Promise<void>;
    startMatch: (characterId?: string) => Promise<void>;
}
export class LobbyScreen {
    private disposed = false;
    private profileRequest = 0;
    dispose = (): void => {
        this.disposed = true;
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
    renderLobby = async (layer: LobbyLayer = "menu"): Promise<void> => {
        if (this.disposed)
            return;
        this.profileRequest++;
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
        this.deps.root.querySelector<HTMLButtonElement>("[data-enter-duel]")?.addEventListener("click", () => { this.guestSelectionIds = []; void this.renderLobby("characters"); });
        this.deps.root.querySelector<HTMLButtonElement>("[data-lobby-home]")?.addEventListener("click", () => { void this.renderLobby("menu"); });
        this.deps.root.querySelector<HTMLButtonElement>("[data-refresh-guests]")?.addEventListener("click", () => { this.guestSelectionIds = this.selectGuestIds(); void this.renderLobby("characters"); });
        const actionsById = new Map(menuActions.map(action => [action.id, action]));
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-ui-action]").forEach(button => button.addEventListener("click", () => {
            const action = actionsById.get(button.dataset.uiAction ?? "");
            if (!action || signal.aborted || button.disabled) return;
            button.disabled = true;
            void Promise.resolve().then(() => { if (!signal.aborted) return action.activate(); }).catch(error => {
                if (!signal.aborted) void alertGameDialog("打开失败", uiError(error, "该功能暂时无法打开，请重试。"));
            }).finally(() => { if (!signal.aborted) button.disabled = false; });
        }, { signal }));
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
        const settingsForm = this.deps.root.querySelector<HTMLElement>("[data-plugin-settings-form]");
        if (settingsForm && this.deps.pluginSettingsSession)
            mountPluginSettingsForm(settingsForm, this.deps.pluginSettingsSession, async (packageId, values) => {
                const data = this.deps.pluginSettingsSession!.updated(this.deps.save.settings.pluginSettings ?? {}, packageId, values);
                const next = { ...this.deps.save, settings: { ...this.deps.save.settings, pluginSettings: data }, updatedAt: new Date().toISOString() };
                await this.deps.repository.saveLongTerm(next);
                this.deps.save = next;
                this.deps.pluginSettingsSession!.sync(data);
            });
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
    openProfile = async (id: string): Promise<void> => {
        const request = ++this.profileRequest;
        const metadata = getCharacterMetadata(id);
        if (!metadata)
            return;
        try {
            const character = await loadCharacter(metadata.id);
            if (this.disposed || request !== this.profileRequest) return;
            this.selectedCharacterId = character.id;
            const content = this.deps.root.querySelector<HTMLDivElement>("#profile-content");
            if (content) {
                const abilities = character.aiSkills
                    .filter((binding) => binding.enabled)
                    .map((binding) => getAbilityDefinition(binding.definitionId))
                    .filter((definition): definition is NonNullable<ReturnType<typeof getAbilityDefinition>> => Boolean(definition));
                const abilityMarkup = abilities.length === 0 ? "" : `<section class="profile-abilities" aria-label="角色技能"><h3>技能</h3>${abilities.map((ability) => `<details class="profile-ability"><summary><strong>${escapeHtml(ability.name)}</strong><span>：${escapeHtml(ability.description)}</span></summary><p>${escapeHtml(ability.profileLore ?? ability.description)}</p></details>${skillRulesMarkup(ability.description, ability.usage)}`).join("")}</section>`;
                const defeated = defeatedCharacterIdsByFirstDefeat(this.deps.save.defeats).includes(character.id);
                const unlocked = isCharacterUnlocked(character, this.deps.save.defeats);
                const actionMarkup = defeated
                    ? `<p class="status-line">她曾在这里落败，仍可再次邀请。</p><button class="primary-button profile-start" data-profile-start="${escapeHtml(character.id)}">开始对局 <span>→</span></button>`
                    : unlocked
                        ? `<button class="primary-button profile-start" data-profile-start="${escapeHtml(character.id)}">开始对局 <span>→</span></button>`
                        : `<p class="status-line">尚未解锁：${escapeHtml(unlockConditionLabel(character.unlock))}</p>`;
                content.innerHTML = `<img src="${escapeHtml(character.previewImage)}" alt="${escapeHtml(character.name)}" loading="lazy" decoding="async" /><p class="eyebrow">角色档案 // ${escapeHtml(character.tier)}级</p><h2>${escapeHtml(character.name)}</h2>${abilityMarkup}<p class="profile-description">${escapeHtml(character.profile.description)}</p>${actionMarkup}`;
            }
            content?.querySelector<HTMLButtonElement>("[data-profile-start]")?.addEventListener("click", () => { document.querySelector<HTMLDialogElement>("#profile")?.close(); void this.deps.startMatch(character.id); });
            document.querySelector<HTMLDialogElement>("#profile")?.showModal();
        }
        catch (error) {
            if (this.disposed || request !== this.profileRequest) return;
            this.deps.renderError(error);
        }
    };
}
