import { getCharacterMetadata,newlyUnlockedForDefeat } from "../content/characters";
import type { Action,MatchState } from "../core/match/types";
import { getPlayerSkillDefinition } from "../core/skills/definitions";
import { playerSkillsUnlockedForVictory,unlockedPlayerSkillIdsForDefeats } from "../core/skills/skills";
import { escapeHtml,legal,unlockConditionLabel } from "../presentation/view-helpers";

export interface SummaryViewInput {
  readonly state: MatchState;
  readonly character: import("../content/characters").CharacterDefinition;
  readonly save: import("../persistence/schema").LongTermSave;
}
export function projectSummaryView({ state, character, save }: SummaryViewInput) {
        const winner = state.outcome?.winner;
        const escaped = state.outcome?.reason === "escaped";
        const playerWon = winner === "player";
        const image = playerWon ? (character.assets.defeatedSummary ?? character.assets.unconscious) : escaped ? character.assets.conflicted : character.assets.relaxed;
        const imageAlt = playerWon ? `${character.name} 全身无力地瘫坐在椅子上` : character.name;
        const summaryCopy = escaped ? character.matchSummary.escaped : playerWon ? character.matchSummary.playerVictory : character.matchSummary.playerDefeat;
        const alreadyUnlocked = new Set(unlockedPlayerSkillIdsForDefeats(save.defeats));
        const newlyUnlocked = playerWon && !escaped
            ? playerSkillsUnlockedForVictory(state.opponentId, winner, escaped).filter((id) => !alreadyUnlocked.has(id))
            : [];
        const newlyUnlockedCharacters = playerWon && !escaped ? newlyUnlockedForDefeat(save.defeats, state.opponentId) : [];
        const characterUnlockPanel = newlyUnlockedCharacters.length
            ? `<section class="unlock-panel character-unlock-panel" aria-live="polite"><p class="eyebrow">新角色已解锁</p>${newlyUnlockedCharacters.map((id) => {
                const character = getCharacterMetadata(id);
                if (!character)
                    return "";
                return `<div class="unlock-skill"><strong>${escapeHtml(character.name)}</strong><span>${escapeHtml(character.tier)}级与会者 · 已可在候场宾客中邀请</span><small>${escapeHtml(unlockConditionLabel(character.unlock))}</small></div>`;
            }).join("")}</section>`
            : "";
        const unlockPanel = newlyUnlocked.length
            ? `<section class="unlock-panel" aria-live="polite"><p class="eyebrow">新技能已解锁</p>${newlyUnlocked.map((id) => {
                const skill = getPlayerSkillDefinition(id);
                if (!skill)
                    return "";
                return `<div class="unlock-skill"><strong>${escapeHtml(skill.name)}</strong><span>${skill.category === "active" ? "主动" : "被动"} · ${escapeHtml(skill.description)}</span><small>${escapeHtml(skill.unlock?.label ?? "胜利奖励")}</small><button type="button" class="secondary-button" data-reward-deck="${escapeHtml(id)}" data-own-haptic>加入卡组</button><span role="status" data-reward-status></span></div>`;
            }).join("")}</section>`
            : "";
        const summaryButton = (label: string, destination: "history" | "rewind" | "lobby", className: string): string => {
            const action: Action = { type: "ACK_MATCH_RESULT" };
            return `<button class="${className}" data-action='${JSON.stringify(action)}' data-summary-action="${destination}" ${legal(state, action) ? "" : "disabled"}>${label}</button>`;
        };
        const summaryActions = escaped
            ? summaryButton("返回大厅", "lobby", "primary-button")
            : playerWon
                ? `<div class="controls action-dock summary-actions">${summaryButton("查看历史记录", "history", "primary-button")}${summaryButton("返回大厅", "lobby", "secondary-button")}</div>`
                : `<div class="controls action-dock summary-actions">${summaryButton("回溯时空（重开一局）", "rewind", "primary-button")}${summaryButton("返回大厅", "lobby", "secondary-button")}</div>`;
        const html = `<main class="summary-shell"><p class="eyebrow">终局</p><img class="summary-character" src="${image}" alt="${imageAlt}" /><p class="kicker">${escaped ? "策展人提前离席" : playerWon ? "与会者已被击败" : "与会者拿下了这一局"}</p><h1>${escaped ? "已离席" : playerWon ? "策展人胜利" : "策展人落败"}</h1><p class="summary-copy">${escapeHtml(summaryCopy)}</p>${characterUnlockPanel}${unlockPanel}${summaryActions}</main>`;

  return Object.freeze({ html, newlyUnlocked: Object.freeze(newlyUnlocked) });
}
export type SummaryViewModel = ReturnType<typeof projectSummaryView>;
