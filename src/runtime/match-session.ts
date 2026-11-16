import type { RuntimeEventHub } from "./public-event-hub";
import { createPublicEvent, createPublicEventBatch, matchPublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import type { EncounterPlan, MatchOwner } from "./match-owner";
import { previewPendingTrigger, reconcileMatchAbilities, type CreateMatchOptions } from "../core/match/reducer";
import { isIntrinsicAbility } from "../core/intrinsic-abilities";
import { getAbilityDefinition } from "../core/abilities/registry";
import { IncompleteSkillDeckError } from "../core/flow/initialization";
import type { Action, GameEvent, MatchState } from "../core/match/types";
import { unlockedPlayerSkillIdsForDefeats } from "../core/skills/skills";
import { unlockedTalentIdsForDefeats } from "../core/talents/definitions";
import { DialogueEngine } from "../dialogue/engine";
import { DialogueSession } from "../dialogue/session";
import { presentationStore } from "../persistence/presentation";
import { getCharacterMetadata, loadCharacter, type CharacterDefinition } from "../content/characters";
import type { AutosaveController } from "../persistence/autosave";
import { abilityTriggerNoticesFromFacts, pendingTriggerAbilityNotices } from "../presentation/ability-notices";
import { presentMatchHapticsFacts } from "../presentation/haptics";
import { gameAudio } from "../audio/game-audio";
import { presentMatchAudioFacts, syncMatchAudioState } from "../audio/match-audio";
import { characterResourcePlan, resourceLoader } from "../resources/resource-loader";
import { loadingScreenMarkup } from "../presentation/loading-indicator";
import { createMatchTransition, type MatchTransition, type MatchFactTransition } from "./match-transition";
import { createMatchFactBatch } from "../core/events";
import { MatchFactRuntime } from "./match-fact-runtime";
export interface MatchSessionDependencies {
    readonly isInteractionBlocked?: () => boolean;
    readonly events?: RuntimeEventHub;
    readonly eventScopes?: PublicEventScopes;
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
    tablePortrait: (state: import("../core/match/types").MatchState, character: import("../content/characters/types").CharacterDefinition) => string;
    clearAiSchedule: () => void;
    notifyExtensions: () => void;
    resetDialogue: () => void;
    renderMatch: (state: import("../core/match/types").MatchState) => void;
    runtimeContributions: readonly import("../content/packages/plugin-contracts").PluginRuntimeContribution[];
    scheduleAiTurn: (state: import("../core/match/types").MatchState) => void;
    presentDelta: (transition: MatchTransition) => void;
}
export class MatchSession {
    constructor(private readonly deps: MatchSessionDependencies) { }
    private readonly fallbackFactEvents = new MatchFactRuntime();
    private observedFactEvents: MatchFactRuntime | undefined;
    private factObservers: AbortController | undefined;
    private get factEvents(): MatchFactRuntime {
        const events = this.autosave?.factEvents ?? this.fallbackFactEvents;
        if (this.observedFactEvents !== events) {
            this.factObservers?.abort();
            this.factObservers = new AbortController();
            this.observedFactEvents = events;
            const options = { signal: this.factObservers.signal };
            events.subscribe("resolved", batch => {
                this.deps.events?.publish("resolved", matchPublicEventBatch(batch, this.deps.eventScopes));
            }, options);
            events.subscribe("resolved", batch => { gameAudio.updateMusicFacts(batch); }, options);
            events.subscribe("resolved", batch => { this.deps.presentDelta(batch as MatchFactTransition); }, options);
            events.subscribe("resolved", batch => { presentMatchAudioFacts(gameAudio, batch); }, options);
            events.subscribe("resolved", batch => { this.presentPluginMatchEvents(batch as MatchFactTransition); }, options);
            events.subscribe("resolved", batch => { presentMatchHapticsFacts(batch, !this.deps.save.settings.reducedMotion); }, options);
            events.subscribe("resolved", () => { this.deps.notifyExtensions(); }, options);
        }
        return events;
    }
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
    pauseForNavigation = (): void => { this.setPaused(true); this.deps.clearAiSchedule(); };
    resumeAfterNavigation = (): void => {
        this.setPaused(false);
        if (this.autosave && !this.disposed) this.deps.scheduleAiTurn(this.autosave.getState());
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
        try { await this.autosave?.flush(); }
        finally { this.fallbackFactEvents.dispose(); }
    };
    autosave: AutosaveController | null = null;
    private owner: MatchOwner | undefined;
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
        this.owner = undefined;
        gameAudio.updateMusicContext();
        this.deps.notifyExtensions();
    };
    leave = (): void => {
        gameAudio.updateMusicContext();
        this.characterLoadToken++;
        this.characterLoadInFlight = false;
        this.deps.clearAiSchedule();
        this.stopPluginMatch();
    };
    stopPluginMatch = (): void => {
        this.generation++;
        this.factObservers?.abort();
        this.factObservers = undefined;
        this.observedFactEvents = undefined;
        void this.dialogueSession?.dispose();
        this.dialogueSession = undefined;
        this.pluginMatchController?.abort();
        this.pluginMatchController = undefined;
    };
    startEncounter = (plan: EncounterPlan, owner: MatchOwner): Promise<boolean> => this.openMatch(plan, owner);
    showInitializationError = (error: unknown): boolean => {
        if (!(error instanceof IncompleteSkillDeckError)) return false;
        this.deps.root.querySelector<HTMLDialogElement>("#profile")?.close();
        this.deps.openSkillManagement(error.message);
        return true;
    };
    /** Read profile defaults; the flow resolves and validates the final initialization plan. */
    getMatchDefaults = async (character: CharacterDefinition): Promise<CreateMatchOptions> => {
        const writer = this.deps.getDeckQueue();
        await writer.flush();
        const availableSkills = this.deps.currentAvailableDeckSkills().map(skill => skill.id);
        return {
            opponentId: character.id, aiProfile: character.ai,
            autoSkipAfterStand: this.deps.save.settings.autoSkipAfterStand ?? true,
            unlockedPlayerSkillIds: unlockedPlayerSkillIdsForDefeats(this.deps.save.defeats),
            skillDeckIds: writer.get().carried.filter(id => availableSkills.includes(id)),
            talentIds: unlockedTalentIdsForDefeats(this.deps.save.defeats),
            intrinsicAbilities: this.deps.runtimeContributions.flatMap(contribution => contribution.initialAbilities?.() ?? []),
            opponentAiSkills: character.aiSkills
        };
    };
    private openMatch = async (encounter: EncounterPlan, owner: MatchOwner): Promise<boolean> => {
        if (!encounter.match || encounter.match.opponentId !== encounter.opponentId || encounter.match.seed !== encounter.seed)
            throw new Error("牌局必须先由流程编排器完成初始化");
        const characterId = encounter.opponentId;
        if (this.disposed)
            return false;
        const generation = this.generation;
        this.tableModulePromise ??= import("../table-screen-module");
        await this.tableModulePromise;
        await this.waitForResume();
        if (this.disposed || generation !== this.generation || this.characterLoadInFlight)
            return false;
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
            const character = await loadCharacter(metadata.id);
            await this.waitForResume();
            if (this.disposed || requestToken !== this.characterLoadToken)
                return false;
            this.deps.root.innerHTML = loadingScreenMarkup("布置牌桌");
            this.currentCharacter = character;
            this.deps.selectedCharacterId = character.id;
            this.lastAction = null;
            this.lastDomainEvent = null;
            const match = encounter.match;
            await this.resumeMatch(match, owner, character, false);
            if (!this.disposed && requestToken === this.characterLoadToken)
                this.deps.enqueueAbilityNotices(abilityTriggerNoticesFromFacts(createMatchFactBatch(undefined, match), character.name));
            return !this.disposed && requestToken === this.characterLoadToken;
        }
        catch (error) {
            if (this.disposed || requestToken !== this.characterLoadToken)
                return false;
            throw error;
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
    resumeMatch = async (match: MatchState, owner: MatchOwner, loadedCharacter?: CharacterDefinition, restored = true): Promise<void> => {
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
        const baseCharacter = loadedCharacter ?? await loadCharacter(match.opponentId);
        const character = owner.character(baseCharacter, match);
        await this.waitForResume();
        if (this.disposed || generation !== this.generation)
            return;
        this.currentCharacter = character;
        this.owner = owner;
        gameAudio.setMatchMusic(character.matchMusicSources, character.matchMusicPriorities);
        gameAudio.setBgmScene("match");
        gameAudio.preloadMatch();
        await this.prepareMatchResources(this.currentCharacter, match);
        await this.waitForResume();
        if (this.disposed || generation !== this.generation)
            return;
        this.deps.selectedCharacterId = this.currentCharacter.id;
        const source = match;
        // A restored table owns its effective bindings; current plugin defaults must not
        // delete flow/node bindings or rerun initialization after settings have changed.
        match = reconcileMatchAbilities(match, match.abilities.instances.filter(instance => isIntrinsicAbility(instance)
            && getAbilityDefinition(instance.definitionId, undefined, instance.level)).map(instance => ({
            definitionId: instance.definitionId, level: instance.level ?? 1, enabled: true, parameters: instance.parameters
        })));
        const autosave = await owner.attach(match, source);
        await this.waitForResume();
        if (this.disposed || generation !== this.generation)
            return;
        this.autosave = autosave;
        const state = autosave.getState();
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
            this.showSummary(state);
        else {
            this.deps.renderMatch(state);
            const triggerPreview = state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger"
                ? previewPendingTrigger(state)
                : null;
            if (triggerPreview)
                this.deps.enqueueAbilityNotices(pendingTriggerAbilityNotices(triggerPreview, this.currentCharacter.name));
            syncMatchAudioState(gameAudio, state, restored);
        }
        gameAudio.updateMusicContext(state, [], restored);
        // Initialization shares the same public source and precedes automatic actions.
        this.deps.events?.publish("resolved", matchPublicEventBatch(createMatchFactBatch(undefined, state, { restored }), this.deps.eventScopes));
        if (restored && this.deps.events) {
            const id = this.deps.events.nextId(`match:${state.id}:restored`);
            const batch = createPublicEventBatch({ id, facts: [createPublicEvent({ id, type: "match.restored",
                scopes: { ...this.deps.eventScopes, match: state.id, round: `${state.id}:${state.roundIndex}` },
                data: { roundIndex: state.roundIndex, historyIndex: state.history.length }
            })], context: { match: state } });
            this.deps.events.publish("resolved", batch);
            this.deps.events.publish("committed", batch);
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
    private showSummary = (match: MatchState): void => {
        this.owner?.summary(match);
    };
    dispatch = (action: Action): void => {
        if (this.disposed || this.paused || this.deps.isInteractionBlocked?.() || !this.autosave)
            return;
        const before = this.autosave.getState();
        const after = this.autosave.dispatch(action);
        if (after === before)
            return;
        const transition = createMatchTransition(before, after, this.autosave.getLastFactBatch?.());
        this.dialogueSession?.transitionFacts(transition);
        this.lastAction = action;
        this.lastDomainEvent = transition.facts.at(-1)?.type ?? null;
        // Rendering is required orchestration: do not advance AI behind a failed table.
        if (after.scene === "match" && after.view === "match-summary") this.showSummary(after);
        else if (after.scene === "match") this.deps.renderMatch(after);
        this.factEvents.publish("resolved", transition);
        this.deps.scheduleAiTurn(this.autosave.getState());
    };
}
