import { availableDeckSkills, resolveSkillDeck, type SkillDeck } from "../core/skills/deck";
import { createDeckSaveQueue, type DeckSaveQueue } from "../presentation/deck-save-queue";
import { mountDeckEditor } from "../presentation/deck-editor";
import { PLAYER_SKILL_DEFINITIONS } from "../core/skills/definitions";
import { unlockedPlayerSkillIdsForDefeats } from "../core/skills/skills";
import { TALENT_DEFINITIONS, unlockedTalentIdsForDefeats } from "../core/talents/definitions";
import { defeatedCharacterIdsByFirstDefeat } from "../content/characters";
import { escapeHtml, TALENT_PLACEHOLDER_MILESTONES } from "../presentation/view-helpers";
export interface SkillLibraryControllerDependencies {
    save: import("../persistence/schema").LongTermSave;
    repository: import("../persistence/save-service").PersistenceService;
    readonly autosave: import("../runtime/session-ports").ActiveMatchPersistence | null;
    root: HTMLDivElement;
}
export class SkillLibraryController {
    constructor(private readonly deps: SkillLibraryControllerDependencies) { }
    dispose = (): void => {
        this.disposeDeckEditor?.();
        this.disposeDeckEditor = undefined;
    };
    skillManagementTab: "skills" | "talents" = "skills";
    deckQueue: DeckSaveQueue | undefined;
    disposeDeckEditor: (() => void) | undefined;
    talentRoadMarkup = (): string => {
        const defeatCount = defeatedCharacterIdsByFirstDefeat(this.deps.save.defeats).length;
        const unlockedTalentIds = new Set(unlockedTalentIdsForDefeats(this.deps.save.defeats));
        const talentNodes = TALENT_DEFINITIONS
            .filter((talent) => !talent.hidden)
            .map((talent) => ({
            id: talent.id,
            count: talent.unlock.count,
            unlockLabel: talent.unlock.label,
            name: talent.name,
            description: talent.description,
            placeholder: false,
            unlocked: unlockedTalentIds.has(talent.id)
        }));
        const occupiedMilestones = new Set(talentNodes.map((node) => node.count));
        const nodes = [
            ...talentNodes,
            ...TALENT_PLACEHOLDER_MILESTONES.filter((count) => !occupiedMilestones.has(count))
                .map((count) => ({
                id: `preview-${count}`,
                count,
                unlockLabel: `击败 ${count} 名与会者`,
                name: "敬请期待",
                description: "新的策展人天赋仍在筹备中。",
                placeholder: true,
                unlocked: false
            }))
        ].sort((left, right) => left.count - right.count);
        const lastReachedIndex = nodes.reduce((result, node, index) => defeatCount >= node.count ? index : result, -1);
        const progress = nodes.length > 1 && lastReachedIndex >= 0 ? lastReachedIndex / (nodes.length - 1) : 0;
        const checkpoints = nodes.map((node) => {
            const reached = defeatCount >= node.count;
            const stateClass = node.placeholder ? (reached ? "is-reached" : "is-locked") : (node.unlocked ? "is-unlocked" : "is-locked");
            const progressCount = Math.min(defeatCount, node.count);
            const status = node.placeholder
                ? (reached ? "里程碑已到达" : `进度 ${progressCount}/${node.count}`)
                : (node.unlocked ? "已解锁" : `未解锁 · 进度 ${progressCount}/${node.count}`);
            return `<article class="talent-checkpoint ${node.placeholder ? "talent-placeholder" : ""} ${stateClass}" data-threshold="${node.count}" ${node.placeholder ? "" : `data-talent-id="${escapeHtml(node.id)}"`}><span class="talent-checkpoint-dot" aria-hidden="true"><b>${node.count}</b><small>胜</small></span><div class="talent-stage-card"><p class="eyebrow">${node.placeholder ? "未公开天赋" : `天赋奖励 · ${escapeHtml(node.unlockLabel)}`}</p><h3>${escapeHtml(node.name)}</h3><p>${escapeHtml(node.description)}</p><small>${status}</small></div></article>`;
        }).join("");
        return `<div class="talent-road-heading"><div><p class="eyebrow">策展人成长轨迹</p><h3>天赋路线</h3></div><output>已击败 ${defeatCount} 名与会者</output></div><div class="talent-progress-line" style="--talent-road-progress:${progress}">${checkpoints}</div>`;
    };
    currentAvailableDeckSkills = () => {
        return availableDeckSkills(PLAYER_SKILL_DEFINITIONS, unlockedPlayerSkillIdsForDefeats(this.deps.save.defeats));
    };
    getDeckQueue = (): DeckSaveQueue => {
        const available = this.currentAvailableDeckSkills().map((skill) => skill.id);
        if (!this.deckQueue) {
            this.deckQueue = createDeckSaveQueue(resolveSkillDeck(this.deps.save.profile.skillDeck, available), async (deck: SkillDeck) => {
                const next = { ...this.deps.save, profile: { ...this.deps.save.profile, skillDeck: { carried: [...deck.carried], reserve: [...deck.reserve] } }, updatedAt: new Date().toISOString() };
                await this.deps.repository.saveLongTerm(next);
                this.deps.save = next;
                if (this.deps.autosave)
                    this.deps.autosave.updateSave(next);
            });
            if (!this.deps.save.profile.skillDeck)
                void this.deckQueue.update(this.deckQueue.get());
        }
        else {
            const reconciled = resolveSkillDeck(this.deckQueue.get(), available);
            if (JSON.stringify(reconciled) !== JSON.stringify(this.deckQueue.get()))
                void this.deckQueue.update(reconciled);
        }
        return this.deckQueue;
    };
    renderSkillList = (): string => {
        return `<div class="skill-management-tabs" role="tablist" aria-label="技能与天赋"><button type="button" role="tab" id="skill-tab" aria-controls="skill-panel" aria-selected="${this.skillManagementTab === "skills"}" class="skill-management-tab ${this.skillManagementTab === "skills" ? "is-active" : ""}" data-skill-tab="skills">技能</button><button type="button" role="tab" id="talent-tab" aria-controls="talent-panel" aria-selected="${this.skillManagementTab === "talents"}" class="skill-management-tab ${this.skillManagementTab === "talents" ? "is-active" : ""}" data-skill-tab="talents">天赋</button></div>${this.skillManagementTab === "skills" ? `<section id="skill-panel" role="tabpanel" aria-labelledby="skill-tab" class="skill-management-panel"></section>` : `<section id="talent-panel" role="tabpanel" aria-labelledby="talent-tab" class="skill-management-panel talent-panel">${this.talentRoadMarkup()}</section>`}`;
    };
    renderSkillManagement = (statusMessage = ""): void => {
        const content = this.deps.root.querySelector<HTMLDivElement>("#skill-content");
        if (!content)
            return;
        this.disposeDeckEditor?.();
        this.disposeDeckEditor = undefined;
        content.innerHTML = this.renderSkillList();
        if (this.skillManagementTab === "skills") {
            this.disposeDeckEditor = mountDeckEditor(content.querySelector<HTMLElement>("#skill-panel")!, {
                skills: this.currentAvailableDeckSkills(), queue: this.getDeckQueue(), reducedMotion: () => this.deps.save.settings.reducedMotion, message: statusMessage || undefined
            });
        }
        content.onclick = (event) => {
            const tab = (event.target as Element).closest<HTMLButtonElement>("[data-skill-tab]");
            if (!tab)
                return;
            this.skillManagementTab = tab.dataset.skillTab === "talents" ? "talents" : "skills";
            this.renderSkillManagement();
        };
    };
    openSkillManagement = (statusMessage = ""): void => {
        this.skillManagementTab = "skills";
        this.renderSkillManagement(statusMessage);
        const dialog = this.deps.root.querySelector<HTMLDialogElement>("#skills");
        if (dialog && !dialog.open)
            dialog.showModal();
    };
}
