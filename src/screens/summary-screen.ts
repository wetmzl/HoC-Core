import type { MatchState } from "../core/match/types";
import { moveDeckSkill, resolveSkillDeck } from "../core/skills/deck";
import { haptics } from "../presentation/haptic-service";
import { projectSummaryView } from "./summary-view";
export interface SummaryScreenDependencies {
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
    requestDispatch: (action: import("../core/match/types").Action) => void;
    completeMatch: (destination: "history" | "rewind" | "lobby") => Promise<void>;
}
export class SummaryScreen {
    constructor(private readonly deps: SummaryScreenDependencies) { }
    renderSummary = (state: MatchState): void => {
        this.deps.beforeShow();
        const { html, newlyUnlocked } = projectSummaryView({ state, character: this.deps.currentCharacter, save: this.deps.save });
        this.deps.root.innerHTML = html;
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-reward-deck]").forEach((button) => button.addEventListener("click", () => {
            const id = button.dataset.rewardDeck!;
            const writer = this.deps.getDeckQueue();
            const prepared = resolveSkillDeck(writer.get(), [...this.deps.currentAvailableDeckSkills().map((skill) => skill.id), ...newlyUnlocked]);
            button.disabled = true;
            button.textContent = "正在加入…";
            void writer.update(moveDeckSkill(prepared, id, "carried")).then(() => {
                const added = writer.get().carried.includes(id);
                button.disabled = added;
                button.textContent = added ? "已加入卡组" : "重试加入";
                const status = button.parentElement?.querySelector("[data-reward-status]");
                if (status)
                    status.textContent = added ? "下一局生效" : "保存失败，请重试";
            });
            if (!this.deps.save.settings.reducedMotion)
                void haptics.play([18]);
        }));
        let summaryActionInFlight = false;
        this.deps.root.querySelectorAll<HTMLButtonElement>("[data-summary-action]").forEach((button) => button.addEventListener("click", () => {
            if (summaryActionInFlight)
                return;
            summaryActionInFlight = true;
            this.deps.root.querySelectorAll<HTMLButtonElement>("[data-summary-action]").forEach((candidate) => { candidate.disabled = true; });
            const destination = button.dataset.summaryAction;
            void (async () => {
                await this.deps.deckQueue?.flush();
                this.deps.requestDispatch({ type: "ACK_MATCH_RESULT" });
                await this.deps.completeMatch(destination === "history" || destination === "rewind" ? destination : "lobby");
            })();
        }));
    };
}
