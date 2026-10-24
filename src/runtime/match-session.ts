import { skillDeckRequirement } from "../core/skills/deck";
import { createMatch, previewPendingTrigger, reconcileMatchAbilities } from "../core/match/reducer";
import type { Action, GameEvent, MatchState } from "../core/match/types";
import { unlockedPlayerSkillIdsForDefeats } from "../core/skills/skills";
import { unlockedTalentIdsForDefeats } from "../core/talents/definitions";
import { DialogueEngine } from "../dialogue/engine";
import { DialogueSession } from "../dialogue/session";
import { presentationStore } from "../persistence/presentation";
import { defeatedCharacterIdsByFirstDefeat, getCharacterMetadata, isCharacterUnlocked, loadCharacter, type CharacterDefinition } from "../content/characters";
import { createAutosaveController, type AutosaveController } from "../persistence/autosave";
import { abilityTriggerNotice, pendingTriggerAbilityNotices } from "../presentation/ability-notices";
import { presentMatchHapticsTransition } from "../presentation/haptics";
import { gameAudio } from "../audio/game-audio";
import { presentMatchAudioTransition, syncMatchAudioState } from "../audio/match-audio";
import { characterResourcePlan, resourceLoader } from "../resources/resource-loader";
import { secureSeed, legal } from "../presentation/view-helpers";
import { createMatchTransition, type MatchTransition } from "./match-transition";
export interface MatchSessionDependencies {
    enterMatch: () => Promise<void>;
    selectedCharacterId: string;
    getDeckQueue: () => {
        get: () => import("../core/skills/deck").SkillDeck;
        subscribe(listener: (deck: import("../core/skills/deck").SkillDeck, status: import("../presentation/deck-save-queue").DeckSaveStatus) => void): () => void;
        update(next: import("../core/skills/deck").SkillDeck): Promise<void>;
        flush: () => Promise<void>;
    };
    currentAvailableDeckSkills: () => import("../core/skills/types").PlayerSkillDefinition[];
    root: HTMLDivElement;
    openSkillManagement: (statusMessage?: string) => void;
    skillDrawerOpen: boolean;
    clearAbilityNoticeQueue: () => void;
    detachFullscreenListener: () => void;
    save: import("../persistence/schema").LongTermSave;
    enqueueAbilityNotices: (notices: readonly import("../presentation/ability-notices").AbilityNotice[]) => void;
    renderError: (error: unknown) => void;
    tablePortrait: (state: import("../core/match/types").MatchState, character: import("../content/characters/types").CharacterDefinition) => string;
    clearAiSchedule: () => void;
    repository: import("../persistence/save-service").PersistenceService;
    notifyExtensions: () => void;
    resetDialogue: () => void;
    renderMatch: (state: import("../core/match/types").MatchState) => void;
    runtimeContributions: readonly import("../content/packages/plugin-contracts").PluginRuntimeContribution[];
    renderSummary: (state: import("../core/match/types").MatchState) => void;
    offerTutorial: (cue: "skill-draw-available") => void;
    scheduleAiTurn: (state: import("../core/match/types").MatchState) => void;
    presentDelta: (transition: MatchTransition) => void;
    showHistoryScreen: () => Promise<void>;
    renderLobby: (layer?: import("../lobby-screen-module").LobbyLayer) => Promise<void>;
}
export class MatchSession {
    constructor(private readonly deps: MatchSessionDependencies) { }
    private generation = 0;
    private disposed = false;
    private paused = false;
    private readonly resumeWaiters = new Set<() => void>();
    setPaused = (paused: boolean): void => {
        this.paused = paused;
        if (!paused || this.disposed) {
            for (const resume of this.resumeWaiters) resume();
            this.resumeWaiters.clear();
        }
    };
    private waitForResume = async (): Promise<void> => {
        if (this.paused && !this.disposed) await new Promise<void>(resolve => this.resumeWaiters.add(resolve));
    };
    dispose = async (): Promise<void> => {
        if (this.disposed)
            return;
        this.disposed = true;
        this.setPaused(true);
        this.characterLoadToken++;
        this.characterLoadInFlight = false;
        this.deps.clearAiSchedule();
        this.stopPluginMatch();
        await this.autosave?.flush();
    };
    autosave: AutosaveController | null = null;
    currentCharacter!: CharacterDefinition;
    dialogueSession: DialogueSession | undefined;
    characterLoadInFlight: boolean = false;
    characterLoadToken: number = 0;
    lastAction: Action | null = null;
    lastDomainEvent: GameEvent["type"] | null = null;
    tableModulePromise: Promise<unknown> | undefined;
    pluginMatchController: AbortController | undefined;
    clearActiveMatch = (): void => {
        this.leave();
        this.autosave = null;
        this.deps.notifyExtensions();
    };
    leave = (): void => {
        this.characterLoadToken++;
        this.characterLoadInFlight = false;
        this.deps.clearAiSchedule();
        this.stopPluginMatch();
    };
    stopPluginMatch = (): void => {
        this.generation++;
        void this.dialogueSession?.dispose();
        this.dialogueSession = undefined;
        this.pluginMatchController?.abort();
        this.pluginMatchController = undefined;
    };
    startMatch = async (characterId = this.deps.selectedCharacterId): Promise<void> => {
        if (this.disposed)
            return;
        const generation = this.generation;
        this.tableModulePromise ??= import("../table-screen-module");
        await this.tableModulePromise;
        await this.waitForResume();
        if (this.disposed || generation !== this.generation || this.characterLoadInFlight)
            return;
        const writer = this.deps.getDeckQueue();
        await writer.flush();
        await this.waitForResume();
        if (this.disposed || generation !== this.generation || this.characterLoadInFlight)
            return;
        const availableSkills = this.deps.currentAvailableDeckSkills().map((skill) => skill.id);
        const requirement = skillDeckRequirement(writer.get(), availableSkills);
        if (requirement.missing) {
            this.deps.root.querySelector<HTMLDialogElement>("#profile")?.close();
            this.deps.openSkillManagement(`还需加入 ${requirement.missing} 种技能才能开始新对局`);
            return;
        }
        this.deps.skillDrawerOpen = false;
        this.deps.clearAbilityNoticeQueue();
        this.deps.detachFullscreenListener();
        gameAudio.unlock();
        gameAudio.play("shuffle");
        const requestToken = ++this.characterLoadToken;
        this.characterLoadInFlight = true;
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-invite-character], [data-profile-start]").forEach((button) => { button.disabled = true; });
        try {
            const metadata = getCharacterMetadata(characterId);
            if (!metadata)
                throw new Error("所选对手不可用。");
            const defeated = defeatedCharacterIdsByFirstDefeat(this.deps.save.defeats).includes(metadata.id);
            if (!defeated && !isCharacterUnlocked(metadata, this.deps.save.defeats))
                throw new Error("该角色尚未解锁。");
            const character = await loadCharacter(metadata.id);
            await this.waitForResume();
            if (this.disposed || requestToken !== this.characterLoadToken)
                return;
            this.deps.root.innerHTML = `<main class="loading-shell"><span class="mark">✦</span><p>正在布置牌桌……</p></main>`;
            this.currentCharacter = character;
            this.deps.selectedCharacterId = character.id;
            this.lastAction = null;
            this.lastDomainEvent = null;
            const match = createMatch(secureSeed(), {
                opponentId: character.id,
                aiProfile: character.ai,
                autoSkipAfterStand: this.deps.save.settings.autoSkipAfterStand ?? true,
                unlockedPlayerSkillIds: unlockedPlayerSkillIdsForDefeats(this.deps.save.defeats),
                skillDeckIds: writer.get().carried.filter((id) => availableSkills.includes(id)),
                talentIds: unlockedTalentIdsForDefeats(this.deps.save.defeats),
                intrinsicAbilities: this.deps.runtimeContributions.flatMap(contribution => contribution.initialAbilities?.() ?? []),
                opponentAiSkills: character.aiSkills
            });
            await this.resumeMatch(match, character, false);
            if (!this.disposed && requestToken === this.characterLoadToken)
                this.deps.enqueueAbilityNotices(abilityTriggerNotice(match.history, character.name, match));
        }
        catch (error) {
            if (this.disposed || requestToken !== this.characterLoadToken)
                return;
            if (error instanceof Error && /尚未解锁|已经败北/.test(error.message)) {
                const status = this.deps.root.querySelector<HTMLParagraphElement>("#lobby-status");
                if (status)
                    status.textContent = error.message;
            }
            else
                this.deps.renderError(error);
        }
        finally {
            if (requestToken === this.characterLoadToken)
                this.characterLoadInFlight = false;
        }
    };
    initiallyVisibleCharacterArt = (character: CharacterDefinition, state: MatchState): string => {
        if (state.view !== "match-summary")
            return this.deps.tablePortrait(state, character);
        if (state.outcome?.winner === "player")
            return character.assets.defeatedSummary ?? character.assets.unconscious;
        if (state.outcome?.reason === "escaped")
            return character.assets.conflicted;
        return character.assets.relaxed;
    };
    prepareMatchResources = async (character: CharacterDefinition, state: MatchState): Promise<void> => {
        const plan = characterResourcePlan(character, {
            visibleArt: [this.initiallyVisibleCharacterArt(character, state)],
            includeTableBase: state.view === "table"
        });
        const visible = resourceLoader.enqueue(plan.visible, "visible");
        void resourceLoader.enqueue(plan.display, "display");
        void resourceLoader.enqueue(plan.background, "background");
        await visible;
    };
    resumeMatch = async (match: MatchState, loadedCharacter?: CharacterDefinition, restored = true): Promise<void> => {
        if (this.disposed)
            return;
        this.stopPluginMatch();
        const generation = this.generation;
        this.pluginMatchController = new AbortController();
        this.tableModulePromise ??= import("../table-screen-module");
        await this.tableModulePromise;
        if (this.disposed || generation !== this.generation)
            return;
        this.deps.clearAiSchedule();
        const character = loadedCharacter ?? await loadCharacter(match.opponentId);
        await this.waitForResume();
        if (this.disposed || generation !== this.generation)
            return;
        this.currentCharacter = character;
        gameAudio.setMatchMusic(character.matchMusicSources);
        gameAudio.setBgmScene("match");
        gameAudio.preloadMatch();
        await this.prepareMatchResources(this.currentCharacter, match);
        await this.waitForResume();
        if (this.disposed || generation !== this.generation)
            return;
        this.deps.selectedCharacterId = this.currentCharacter.id;
        match = reconcileMatchAbilities(match, this.deps.runtimeContributions.flatMap(contribution => contribution.initialAbilities?.() ?? []));
        this.autosave = createAutosaveController(this.deps.repository, this.deps.save, match);
        const state = this.autosave.getState();
        await this.deps.enterMatch();
        if (this.disposed || generation !== this.generation)
            return;
        this.deps.resetDialogue();
        const session = new DialogueSession(new DialogueEngine(this.currentCharacter.dialogue, this.currentCharacter.id), state, presentationStore(), async (url) => {
            if ((await resourceLoader.enqueue([url], "visible"))[0] !== true)
                return false;
            return new Promise<boolean>(resolve => {
                const image = new Image();
                image.onload = () => resolve(image.naturalWidth > 0);
                image.onerror = () => resolve(false);
                image.src = url;
            });
        }, () => {
            if (this.dialogueSession === session && this.autosave?.getState().view === "table")
                this.deps.renderMatch(this.autosave.getState());
        }, (selection, restored, signal) => {
            if (this.dialogueSession !== session || this.autosave?.getState().view !== "table") return;
            const context = Object.freeze({ ...selection, matchId: state.id, characterId: state.opponentId, restored });
            for (const contribution of this.deps.runtimeContributions) {
                try { void Promise.resolve(contribution.presentDialogue?.(context, signal)).catch(error => console.warn("插件对白表现失败", error)); }
                catch (error) { console.warn("插件对白表现失败", error); }
            }
        });
        this.dialogueSession = session;
        await session.start(this.deps.runtimeContributions.flatMap(c => c.dialogueSource ? [c.dialogueSource] : []), restored);
        await this.waitForResume();
        if (this.disposed || generation !== this.generation || this.dialogueSession !== session)
            return;
        if (state.view === "match-summary")
            this.deps.renderSummary(state);
        else {
            this.deps.renderMatch(state);
            const triggerPreview = state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger"
                ? previewPendingTrigger(state)
                : null;
            if (triggerPreview)
                this.deps.enqueueAbilityNotices(pendingTriggerAbilityNotices(triggerPreview, this.currentCharacter.name));
            syncMatchAudioState(gameAudio, state, restored);
            if (legal(state, { type: "OPEN_SKILL_DRAW" }))
                this.deps.offerTutorial("skill-draw-available");
        }
        // Runtime subscribers may open contextual UI; its screen must already exist.
        this.deps.notifyExtensions();
        if (state.view !== "match-summary") this.deps.scheduleAiTurn(this.autosave.getState());
    };
    presentPluginMatchEvents = ({ after, events }: MatchTransition): void => {
        const signal = this.pluginMatchController?.signal;
        if (!signal || signal.aborted)
            return;
        const context = { opponentId: after.opponentId, events };
        for (const contribution of this.deps.runtimeContributions) {
            try {
                void Promise.resolve(contribution.presentMatchEvents?.(context, signal)).catch((error) => console.error("插件牌局表现失败", error));
            }
            catch (error) {
                console.error("插件牌局表现失败", error);
            }
        }
    };
    dispatch = (action: Action): void => {
        if (this.disposed || this.paused || !this.autosave)
            return;
        const before = this.autosave.getState();
        const after = this.autosave.dispatch(action);
        if (after === before)
            return;
        const transition = createMatchTransition(before, after);
        this.dialogueSession?.transition(after);
        this.lastAction = action;
        this.lastDomainEvent = transition.events.at(-1)?.type ?? null;
        if (after.scene === "match" && after.view === "match-summary")
            this.deps.renderSummary(after);
        else if (after.scene === "match")
            this.deps.renderMatch(after);
        this.deps.presentDelta(transition);
        presentMatchAudioTransition(gameAudio, transition);
        this.presentPluginMatchEvents(transition);
        presentMatchHapticsTransition(transition, !this.deps.save.settings.reducedMotion);
        this.deps.notifyExtensions();
        this.deps.scheduleAiTurn(after);
    };
    completeMatch = async (destination: "history" | "rewind" | "lobby"): Promise<void> => {
        if (!this.autosave)
            return;
        this.stopPluginMatch();
        const generation = this.generation;
        await this.autosave.flush();
        if (this.disposed || generation !== this.generation)
            return;
        this.deps.save = this.autosave.getSave();
        const match = this.autosave.getState();
        const winner = match.outcome?.winner ?? null;
        const escaped = match.outcome?.reason === "escaped";
        const opponentId = match.opponentId;
        this.autosave = null;
        if (destination === "history" && winner === "player" && !escaped)
            await this.deps.showHistoryScreen();
        else if (destination === "rewind" && winner !== "player" && !escaped)
            await this.startMatch(opponentId);
        else
            await this.deps.renderLobby();
    };
}
