import type { EncounterRewards, EncounterRewardKind } from "../core/flow/schema";
import { skillSheetMarkup } from "../presentation/skill-sheet";
import { getCharacterMetadata,newlyUnlockedForDefeat } from "../content/characters";
import type { MatchState } from "../core/match/types";
import { getPlayerSkillDefinition } from "../core/skills/definitions";
import { playerSkillsUnlockedForVictory,unlockedPlayerSkillIdsForDefeats } from "../core/skills/skills";
import { escapeHtml,unlockConditionLabel } from "../presentation/view-helpers";

export type SummaryDestination = "history" | "rewind" | "lobby" | "continue";
export interface SummarySettlement {
  readonly recordResult: boolean;
  readonly actions?: readonly { readonly label: string; readonly destination: SummaryDestination; readonly primary?: boolean }[];
  readonly resourceReward?: { readonly rewards: EncounterRewards; readonly claimed: readonly EncounterRewardKind[] };
  readonly rewards?: readonly { readonly id: string; readonly label: string; readonly amount?: string; readonly detail?: string; readonly icon?: EncounterRewardKind; readonly claimed: boolean }[];
}
export interface SummaryViewInput {
  readonly settlement?: SummarySettlement;
  readonly state: MatchState;
  readonly character: import("../content/characters").CharacterDefinition;
  readonly save: import("../persistence/schema").LongTermSave;
}
export function projectSummaryView({ state, character, save, settlement }: SummaryViewInput) {
        const winner = state.outcome?.winner;
        const escaped = state.outcome?.reason === "escaped";
        const playerWon = winner === "player";
        const image = playerWon ? (character.assets.defeatedSummary ?? character.assets.unconscious) : escaped ? character.assets.conflicted : character.assets.relaxed;
        const imageAlt = playerWon ? `${character.name} 全身无力地瘫坐在椅子上` : character.name;
        const summaryCopy = escaped ? character.matchSummary.escaped : playerWon ? character.matchSummary.playerVictory : character.matchSummary.playerDefeat;
        const alreadyUnlocked = new Set(unlockedPlayerSkillIdsForDefeats(save.defeats));
        const newlyUnlocked = (settlement?.recordResult ?? true) && playerWon && !escaped
            ? playerSkillsUnlockedForVictory(state.opponentId, winner, escaped).filter((id) => !alreadyUnlocked.has(id))
            : [];
        const newlyUnlockedCharacters = (settlement?.recordResult ?? true) && playerWon && !escaped ? newlyUnlockedForDefeat(save.defeats, state.opponentId) : [];
        const characterUnlockPanel = newlyUnlockedCharacters.length
            ? `<section class="unlock-panel character-unlock-panel" aria-live="polite"><p class="eyebrow">新角色已解锁</p>${newlyUnlockedCharacters.map((id) => {
                const character = getCharacterMetadata(id);
                if (!character)
                    return "";
                return `<div class="unlock-skill"><strong>${escapeHtml(character.name)}</strong><span>${escapeHtml(character.tier)}级${character.tier === "SS" ? "特殊对手 · 已可单独挑战" : "与会者 · 已可在候场宾客中邀请"}</span><small>${escapeHtml(unlockConditionLabel(character.unlock))}</small></div>`;
            }).join("")}</section>`
            : "";
        const unlockPanel = newlyUnlocked.length
            ? `<section class="unlock-panel" aria-live="polite"><p class="eyebrow">新技能已解锁</p>${newlyUnlocked.map((id) => {
                const skill = getPlayerSkillDefinition(id);
                if (!skill)
                    return "";
                return `<div class="unlock-skill"><small>${skill.category === "active" ? "主动" : "被动"}</small>${skillSheetMarkup(skill)}<small>${escapeHtml(skill.unlock?.label ?? "胜利奖励")}</small><button type="button" class="secondary-button" data-reward-deck="${escapeHtml(id)}" data-own-haptic>加入卡组</button><span role="status" data-reward-status></span></div>`;
            }).join("")}</section>`
            : "";
        const reward = settlement?.resourceReward;
        const icons = {
          skillDraws: '<path d="M5 7H3v13h11v-2"/><rect x="7" y="3" width="13" height="15" rx="2"/><path d="m13.5 7 3 3.5-3 3.5-3-3.5z"/>',
          removeBullets: '<path d="M8 17V8c0-3 4-6 4-6s4 3 4 6v9M7 17h10v4H7zM8 13h8"/>',
          pointAdvantage: '<path d="m4 17 5-6 4 3 7-9M15 5h5v5M4 21h16"/>'
        };
        const items: { kind: EncounterRewardKind; label: string; prefix: string; detail?: string }[] = [
          { kind: "skillDraws", label: "技能抽数", prefix: "×" },
          { kind: "removeBullets", label: "左轮子弹", prefix: "−" },
          { kind: "pointAdvantage", label: "点数优势", prefix: "+", detail: "本次挑战" }
        ];
        const pending = settlement?.rewards?.filter(item => !item.claimed) ?? (reward ? items.filter(item => reward.rewards[item.kind] && !reward.claimed.includes(item.kind)) : []);
        const rewardRows = reward ? items.filter(item => reward.rewards[item.kind]).map(item => {
          const claimed = reward.claimed.includes(item.kind);
          return `<div class="summary-resource-item ${claimed ? "is-claimed" : ""}"><svg class="summary-resource-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[item.kind]}</svg><span>${item.label}${item.detail ? `<small>${item.detail}</small>` : ""}</span><strong>${item.prefix}${reward.rewards[item.kind]}</strong><button class="summary-resource-claim" data-claim-encounter-reward="${item.kind}" aria-label="${claimed ? "已领取" : "领取"}${item.label}" ${claimed ? "disabled" : ""}>${claimed ? "已领取" : "领取"}</button></div>`;
        }).join("") : "";
        const declaredRows = settlement?.rewards?.map(item => `<div class="summary-resource-item ${item.claimed ? "is-claimed" : ""}">${item.icon ? `<svg class="summary-resource-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[item.icon]}</svg>` : ""}<span>${escapeHtml(item.label)}${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</span><strong>${escapeHtml(item.amount ?? "")}</strong><button class="summary-resource-claim" data-claim-encounter-reward="${escapeHtml(item.id)}" aria-label="${item.claimed ? "已领取" : "领取"}${escapeHtml(item.label)}" ${item.claimed ? "disabled" : ""}>${item.claimed ? "已领取" : "领取"}</button></div>`).join("");
        const resourcePanel = declaredRows || reward ? `<section class="summary-resource-reward" aria-label="本次挑战奖励">${declaredRows ?? rewardRows}</section>` : "";
        const actions = settlement?.actions ?? (escaped
          ? [{ label: "返回大厅", destination: "lobby", primary: true }]
          : playerWon ? [{ label: "查看历史记录", destination: "history", primary: true }, { label: "返回大厅", destination: "lobby" }]
          : [{ label: "回溯时空（重开一局）", destination: "rewind", primary: true }, { label: "返回大厅", destination: "lobby" }]);
        const summaryActions = `${resourcePanel}<p role="status" data-encounter-status></p><div class="controls action-dock summary-actions">${actions.map(action => `<button class="${action.primary ? "primary-button" : "secondary-button"}" data-summary-action="${action.destination}" ${pending.length ? "disabled" : ""}>${escapeHtml(action.label)}</button>`).join("")}</div>`;
        const html = `<main class="summary-shell"><p class="eyebrow">终局</p><img class="summary-character" src="${image}" alt="${imageAlt}" /><p class="kicker">${escaped ? "策展人提前离席" : playerWon ? "与会者已被击败" : "与会者拿下了这一局"}</p><h1>${escaped ? "已离席" : playerWon ? "策展人胜利" : "策展人落败"}</h1><p class="summary-copy">${escapeHtml(summaryCopy)}</p>${characterUnlockPanel}${unlockPanel}${summaryActions}</main>`;

  return Object.freeze({ html, newlyUnlocked: Object.freeze(newlyUnlocked) });
}
export type SummaryViewModel = ReturnType<typeof projectSummaryView>;
