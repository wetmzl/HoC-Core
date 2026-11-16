import { registerBackHandler } from "../platform/back-navigation";
import type { MatchState } from "../core/match/types";
import { moveDeckSkill, resolveSkillDeck } from "../core/skills/deck";
import { haptics } from "../presentation/haptic-service";
import { projectSummaryView, type SummaryDestination, type SummarySettlement } from "./summary-view";
export interface SummaryScreenDependencies {
    flushTutorials?: () => Promise<void>;
    beforeShow: () => void;
    currentCharacter: import("../content/characters/types").CharacterDefinition;
    save: import("../persistence/schema").LongTermSave;
    root: HTMLDivElement;
    getDeckQueue: () => {
        get: () => import("../core/skills/deck").SkillDeck;
        subscribe(listener: (deck: import("../core/skills/deck").SkillDeck, status: import("../presentation/deck-save-queue").DeckSaveStatus) => void): () => void;
        update(next: import("../core/skills/deck").SkillDeck): Promise<void>;
        flush: () => Promise<void>;
    };
    currentAvailableDeckSkills: () => import("../core/skills/types").PlayerSkillDefinition[];
    deckQueue: {
        get: () => import("../core/skills/deck").SkillDeck;
        subscribe(listener: (deck: import("../core/skills/deck").SkillDeck, status: import("../presentation/deck-save-queue").DeckSaveStatus) => void): () => void;
        update(next: import("../core/skills/deck").SkillDeck): Promise<void>;
        flush: () => Promise<void>;
    } | undefined;
    completeMatch: (destination: SummaryDestination) => Promise<void>;
    claimReward: (id: string) => Promise<void>;
    refreshTutorials?: () => void;
}
export class SummaryScreen {
    constructor(private readonly deps: SummaryScreenDependencies) { }
    private lifetime?: AbortController;
    dispose = (): void => { this.lifetime?.abort(); this.lifetime = undefined; };
    renderSummary = (state: MatchState, settlement?: SummarySettlement): void => {
        this.lifetime?.abort();
        this.deps.beforeShow();
        const { html, newlyUnlocked } = projectSummaryView({ state, character: this.deps.currentCharacter, save: this.deps.save, settlement });
        this.deps.root.innerHTML = html;
        const lifetime = this.lifetime = new AbortController();
        const summary = this.deps.root.querySelector<HTMLElement>(".summary-shell");
        const isCurrent = () => Boolean(summary?.isConnected && this.deps.root.querySelector(".summary-shell") === summary && !lifetime.signal.aborted);
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-reward-deck]").forEach((button) => button.addEventListener("click", () => {
            const id = button.dataset.rewardDeck!;
            const writer = this.deps.getDeckQueue();
            button.disabled = true;
            button.textContent = "正在加入…";
            this.deps.refreshTutorials?.();
            void Promise.resolve(this.deps.flushTutorials?.()).then(() => {
                const prepared = resolveSkillDeck(writer.get(), [...this.deps.currentAvailableDeckSkills().map((skill) => skill.id), ...newlyUnlocked]);
                return writer.update(moveDeckSkill(prepared, id, "carried"));
            }).then(() => {
                const added = writer.get().carried.includes(id);
                button.disabled = added;
                button.textContent = added ? "已加入卡组" : "重试加入";
                const status = button.parentElement?.querySelector("[data-reward-status]");
                if (status)
                    status.textContent = added ? "下一局生效" : "保存失败，请重试";
                this.deps.refreshTutorials?.();
            });
            if (!this.deps.save.settings.reducedMotion)
                void haptics.play([18]);
        }));
        let inFlight = false;
        const execute = async (operation: () => Promise<void>) => {
            if (inFlight) return;
            inFlight = true;
            const buttons = [...this.deps.root.querySelectorAll<HTMLButtonElement>("[data-summary-action], [data-claim-encounter-reward]")].map(button => ({ button, disabled: button.disabled }));
            buttons.forEach(({ button }) => button.disabled = true);
            this.deps.refreshTutorials?.();
            try { await this.deps.flushTutorials?.(); await this.deps.deckQueue?.flush(); await operation(); }
            catch (error) {
                const status = this.deps.root.querySelector<HTMLElement>("[data-encounter-status]");
                if (status) status.textContent = error instanceof Error ? error.message : "保存失败，请重试";
            } finally {
                buttons.forEach(({ button, disabled }) => { if (button.isConnected) button.disabled = disabled; });
                inFlight = false;
                this.deps.refreshTutorials?.();
            }
        };
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-summary-action]").forEach(button => button.onclick = () => {
            const destination = button.dataset.summaryAction as SummaryDestination;
            void execute(() => this.deps.completeMatch(destination));
        });
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-claim-encounter-reward]").forEach(button => button.onclick = () => {
            const kind = button.dataset.claimEncounterReward!;
            void execute(() => this.deps.claimReward(kind));
        });
        registerBackHandler({
            signal: lifetime.signal, priority: 5, enabled: isCurrent,
            handle: () => execute(() => this.deps.completeMatch("lobby"))
        });
        this.deps.refreshTutorials?.();
    };
}
