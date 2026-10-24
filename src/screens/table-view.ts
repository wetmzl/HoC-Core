import { type CharacterDefinition } from "../content/characters";
import { displayCardMarkers,resolveDisplays } from "../core/abilities/displays";
import { isAbilityBlockedByStatus } from "../core/abilities/engine";
import { ABILITY_REGISTRY,getAbilityDefinition } from "../core/abilities/registry";
import { buildObservation } from "../core/ai/observation";
import { cardRank,cardSuit } from "../core/blackjack/card";
import { isBlackjack } from "../core/blackjack/hand";
import { abilityWorld,getActiveBustLimit,getRoundHitCounts,previewComparisonScores,previewPendingTrigger } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { getPlayerSkillDefinition } from "../core/skills/definitions";
import { SKILL_TAG_METADATA } from "../core/skills/types";
import { cardDisplayMarkup,describeCard,describeCards,diamondCardMarker,suitPresentation } from "../presentation/cards";
import { displayPanelMarkup } from "../presentation/displays";
import { roundResultText } from "../presentation/round-notice";
import { REVOLVER_REFERENCE_ART_HEIGHT,actionButton,displayedHandValueMarkup,escapeHtml,gunStatusMarkup,legal,phaseLabel,revealedDrawPileRankCardIds,revealedDrawPileSuitCardIds,revealedOpponentCardIds } from "../presentation/view-helpers";
import { STAFF_REVOLVER_URL } from "../resources/cache-policy";
import { characterIntelMarkup } from "../presentation/character-intel";
export interface TableViewInput {
  readonly state: MatchState;
  readonly character: CharacterDefinition;
  readonly dialogueSelection: import("../dialogue/types").DialogueSelection;
  readonly dialogueMarkup: string;
  readonly portraitState: string;
  readonly portraitUrl: string;
  readonly portraitAlt: string;
  readonly skillDrawerOpen: boolean;
  readonly debugMarkup: string;
}
export function revolverPlacementStyle(placement: { readonly top: number; readonly left: number }): string {
  const round = (value: number) => Math.round(value * 1e5) / 1e5;
  return `--revolver-top-ratio:${round(placement.top / REVOLVER_REFERENCE_ART_HEIGHT)};--revolver-left-ratio:${round(placement.left / REVOLVER_REFERENCE_ART_HEIGHT)};`;
}
/** Pure projection of domain and presentation data into existing DOM markup. */
export function projectTableView(input: TableViewInput) {
  const state = input.state;
        const { character, dialogueSelection } = input;
        const characterName = escapeHtml(character.name);
        const observation = buildObservation(state, "player");
        const reveal = state.round.phase !== "turns";
        const comparisonPreview = previewComparisonScores(state);
        const hasFinalComparison = state.round.outcome?.comparisonScores !== undefined;
        const playerBaseScore = comparisonPreview.baseScores.player;
        const opponentBaseScore = hasFinalComparison
            ? comparisonPreview.baseScores.opponent
            : reveal ? comparisonPreview.baseScores.opponent : observation.opponent.value ?? "?";
        const playerScoreModifier = comparisonPreview.scores.player - comparisonPreview.baseScores.player;
        const opponentScoreModifier = comparisonPreview.scores.opponent - comparisonPreview.baseScores.opponent;
        const revealedOpponentCards = revealedOpponentCardIds(state);
        const opponentFaceUpIds = new Set(state.opponent.hand.cards.filter((_card, index) => observation.opponent.cards[index] !== null).map((card) => card.id));
        const displays = resolveDisplays(state.abilities, abilityWorld(state), ABILITY_REGISTRY, { roundHitCounts: getRoundHitCounts(state), roundOutcome: state.round.outcome ?? undefined });
        const markersByCardId = Object.fromEntries(Object.entries(displayCardMarkers(displays, abilityWorld(state))).map(([id, markers]) => [id, markers.map((marker) => diamondCardMarker(marker.type, marker.label))]));
        const opponentCards = describeCards(state.opponent.hand.cards, { revealAll: reveal, faceUpCardIds: opponentFaceUpIds, suitVisibleCardIds: revealedOpponentCards, markersByCardId }).map(cardDisplayMarkup).join("");
        const playerCards = describeCards(state.player.hand.cards, { revealAll: true, markersByCardId }).map(cardDisplayMarkup).join("");
        const skills = state.playerSkills.cards.map((card, index) => {
            const skill = getPlayerSkillDefinition(card.definitionId);
            if (!skill)
                return "";
            if (skill.category === "passive") {
                const ttl = state.abilities.instances.find((instance) => instance.instanceId === card.instanceId)?.ttl;
                const ttlLabel = ttl ? ttl.type === "triggers" ? `剩${ttl.remaining}次` : `剩${ttl.remaining}轮` : "被动";
                return `<span class="skill-tile passive" data-skill-instance="${escapeHtml(card.instanceId)}"><span class="skill-card passive-card" aria-label="被动技能${escapeHtml(skill.name)}，${escapeHtml(ttlLabel)}"><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(ttlLabel)}</small></span><button class="skill-info" type="button" data-skill-info="${escapeHtml(skill.id)}" data-skill-info-instance="${escapeHtml(card.instanceId)}" aria-label="查看${escapeHtml(skill.name)}说明">i</button></span>`;
            }
            const action = { type: "PLAY_ABILITY" as const, instanceId: card.instanceId };
            const enabled = legal(state, action);
            const ability = getAbilityDefinition(skill.id);
            const statusBlocked = Boolean(ability && isAbilityBlockedByStatus(abilityWorld(state), card.owner, ability));
            const remainingUses = state.abilities.instances.find((instance) => instance.instanceId === card.instanceId)?.remainingUses ?? skill.uses;
            const useCount = skill.uses > 1 ? ` <span class="skill-use-count">×${remainingUses}</span>` : "";
            const useAria = skill.uses > 1 ? `，剩余${remainingUses}次` : "";
            const interaction = statusBlocked
                ? `data-skill-blocked="true" aria-disabled="true"`
                : `data-action='${JSON.stringify(action)}' ${enabled ? "" : "disabled"}`;
            return `<span class="skill-tile ${enabled ? "" : "is-disabled"}" data-skill-instance="${escapeHtml(card.instanceId)}" style="--skill-index:${index}"><button class="skill-card" data-skill-id="${escapeHtml(skill.id)}" ${interaction} aria-label="${statusBlocked ? "技能被禁用：" : "使用"}${escapeHtml(skill.name)}${useAria}"><b>${escapeHtml(skill.name)}</b><small>主动${useCount}</small></button><button class="skill-info" type="button" data-skill-info="${escapeHtml(skill.id)}" data-skill-info-instance="${escapeHtml(card.instanceId)}" aria-label="查看${escapeHtml(skill.name)}说明">i</button></span>`;
        }).join("");
        const totalSkills = state.playerSkills.cards.length;
        const advice = state.playerSkills.advice ? `<div class="skill-advice" aria-live="polite">猎手直觉：建议 ${state.playerSkills.advice === "hit" ? "Hit 要牌" : "Stand 停牌"}</div>` : "";
        let controls: string;
        if (state.round.phase === "round-reveal") {
            controls = actionButton("确认结果", { type: "ACK_ROUND_RESULT" }, state, "primary-button");
        }
        else if (state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger") {
            controls = actionButton(state.round.outcome?.penaltyTarget === "opponent" ? "静观好戏" : "扣下扳机", { type: "TRIGGER_ROULETTE" }, state, "primary-button");
        }
        else if (state.round.phase === "roulette-result") {
            controls = actionButton(state.status === "finished" ? "查看结局" : "下一轮", { type: "ACK_TRIGGER_RESULT" }, state, "primary-button");
        }
        else if (state.round.phase === "round-end") {
            controls = actionButton("下一轮", { type: "CONTINUE_ROUND" }, state, "primary-button");
        }
        else if (state.round.currentActor === "opponent") {
            controls = `<div class="ai-wait" id="ai-wait" role="status" aria-live="polite" data-step="watching">${characterName} 正在观察牌面……</div>`;
        }
        else {
            const drawAction = { type: "OPEN_SKILL_DRAW" as const };
            controls = `<div class="table-action-controls">${actionButton("Hit 要牌", { type: "PLAYER_HIT" }, state, "primary-button")}${actionButton("Stand 停牌", { type: "PLAYER_STAND" }, state)}<button type="button" class="draw-skill-button" data-action='${JSON.stringify(drawAction)}' ${legal(state, drawAction) ? "" : "disabled"} aria-label="抽取技能，剩余 ${state.playerSkills.drawCount} 次"><span class="draw-skill-icon" aria-hidden="true"><i></i><i></i><i></i></span><span class="draw-skill-badge" aria-hidden="true">${state.playerSkills.drawCount}</span></button></div>`;
        }
        const dialogueMarkup = input.dialogueMarkup;
        const artScale = dialogueSelection.portrait?.scale ?? character.portraitScales.table;
        const revolverPlacement = dialogueSelection.portrait?.revolverPlacement ?? character.revolverPlacement;
        const staffProp = state.round.phase === "roulette-trigger" && state.round.outcome?.penaltyTarget === "opponent"
            ? `<img class="trigger-prop" style="${revolverPlacementStyle(revolverPlacement)}--art-scale:${artScale}" src="${STAFF_REVOLVER_URL}" alt="工作人员用 7mm 左轮对准 ${characterName} 的太阳穴" />` : "";
        const penaltyPreview = state.round.phase === "round-reveal" ? previewPendingTrigger(state) : null;
        const notice = state.round.phase === "round-reveal" ? roundResultText(state, penaltyPreview?.cancelled ?? false) : "";
        const bustLimitActor = state.round.currentActor ?? "player";
        const bustLimit = getActiveBustLimit(state, bustLimitActor);
        const gunStatuses = `<section class="roulette-status" aria-label="轮盘弹巢状态">${gunStatusMarkup(character.name, state.roulette.opponent.bullets, state.roulette.opponent.capacity)}${gunStatusMarkup("策展人", state.roulette.player.bullets, state.roulette.player.capacity)}</section>`;
        const shoeRemaining = Math.max(0, state.shoe.cards.length - state.shoe.cursor);
        const nextShoeCard = state.shoe.cards[state.shoe.cursor];
        const nextShoeSuitVisible = Boolean(nextShoeCard && revealedDrawPileSuitCardIds(state).has(nextShoeCard.id));
        const nextShoeRankVisible = Boolean(nextShoeCard && revealedDrawPileRankCardIds(state).has(nextShoeCard.id));
        const shoeCard = nextShoeCard
            ? cardDisplayMarkup(describeCard(nextShoeCard, { surface: "back", showRank: nextShoeRankVisible, showSuit: nextShoeSuitVisible, variant: "compact" }))
            : `<span class="shoe-status-empty" aria-hidden="true">—</span>`;
        const shoeKnowledge = nextShoeCard ? `下一张牌点数${nextShoeRankVisible ? `为${cardRank(nextShoeCard)}` : "未知"}，花色${nextShoeSuitVisible ? `为${suitPresentation(cardSuit(nextShoeCard)).label}` : "未知"}` : "没有下一张牌";
        const shoeStatus = `<section class="shoe-status" aria-label="牌库：${shoeKnowledge}，剩余 ${shoeRemaining} 张"><span class="shoe-status-label">牌库</span><span class="shoe-status-next"><span class="shoe-status-next-label">next：</span>${shoeCard}</span><button class="shoe-info-button" type="button" data-shoe-info aria-label="查看牌库说明">i</button></section>`;
        const shoeInfoDialog = `<dialog id="shoe-info-dialog" class="modal shoe-info-modal" aria-labelledby="shoe-info-title"><button class="modal-close" type="button" data-shoe-info-close aria-label="关闭牌库说明">×</button><p class="eyebrow">牌桌 // 公共牌堆</p><h2 id="shoe-info-title">牌库</h2><p class="shoe-info-copy">UI中的next指的是下一次hit后发出的牌，你可以用各种手段尝试揭开它的面纱。<strong>牌堆总大小</strong>为52张扑克牌（即不带大小王的一副扑克牌）。开局时洗匀整副牌，此后每轮开始前，在牌堆剩余少于 12 张时，从弃牌堆回收所有牌，并重新洗匀。</p></dialog>`;
        const displayPanel = displayPanelMarkup(displays);
        const skillDrawerMarkup = `<aside class="skill-sidebar ${input.skillDrawerOpen ? "is-open" : ""}" aria-label="技能抽屉"><button class="skill-drawer-toggle" type="button" aria-expanded="${input.skillDrawerOpen}" aria-label="${input.skillDrawerOpen ? "收起" : "展开"}技能抽屉，共 ${totalSkills} 张"><span class="skill-drawer-arrow" aria-hidden="true">${input.skillDrawerOpen ? ">" : "<"}</span><span class="skill-drawer-badge"${input.skillDrawerOpen ? " hidden" : ""}>${totalSkills}</span></button><div class="skill-drawer-viewport"><div class="skill-drawer-content">${skills || "<span class='empty-skills'>暂无技能卡</span>"}</div></div></aside>`;
        const drawOffer = state.playerSkills.drawOffer;
        const drawCards = drawOffer?.candidateDefinitionIds.map((id) => {
            const skill = getPlayerSkillDefinition(id);
            if (!skill)
                return "";
            const action = { type: "SELECT_SKILL_DRAW" as const, definitionId: id };
            return `<span class="skill-draw-tile"><button type="button" class="skill-draw-card" data-action='${JSON.stringify(action)}'><span>${skill.category === "active" ? "主动" : "被动"}</span><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(SKILL_TAG_METADATA[skill.primaryDomain].label)}</small></button><button class="skill-info draw-skill-info" type="button" data-skill-info="${escapeHtml(skill.id)}" aria-label="查看${escapeHtml(skill.name)}说明">i</button></span>`;
        }).join("") ?? "";
        const drawMarkup = drawOffer ? `<section class="skill-draw-backdrop is-entering"><div class="skill-draw-modal" role="dialog" aria-modal="true" aria-labelledby="skill-draw-title"><h2 id="skill-draw-title">选一张你心仪的技能卡</h2><div class="skill-draw-grid">${drawCards}</div><button type="button" class="secondary-button skill-draw-refresh" data-action='${JSON.stringify({ type: "REFRESH_SKILL_DRAW" })}' ${legal(state, { type: "REFRESH_SKILL_DRAW" }) ? "" : "disabled"}>刷新（剩余 ${drawOffer.refreshesRemaining} 次）</button></div></section>` : "";
        const html = `<main class="table-shell table-playing" data-phase="${state.round.phase}"><header class="table-top"><div><span class="eyebrow">第 ${state.roundIndex + 1} 轮 // ${phaseLabel(state.round.phase)}</span><h1>命运牌桌</h1></div><div class="table-actions"><div class="table-action-row"><button class="icon-button fullscreen-button" type="button" data-fullscreen aria-label="进入全屏">⛶</button><button class="icon-button" data-action='${JSON.stringify({ type: "ESCAPE_MATCH" })}' ${legal(state, { type: "ESCAPE_MATCH" }) ? "" : "disabled"} aria-label="离开牌桌">×</button></div></div></header><section class="table-stage" aria-label="人物与牌桌信息">${characterIntelMarkup(character)}<aside class="table-dashboard" tabindex="0" aria-label="牌桌信息栏，点击置顶">${gunStatuses}${shoeStatus}${displayPanel}</aside><section class="opponent-zone"><div class="character-strip"><img class="character-portrait scaled-character-art portrait-${input.portraitState}" style="--character-art-scale:${artScale}" src="${escapeHtml(input.portraitUrl)}" alt="${escapeHtml(input.portraitAlt)}" />${staffProp}<div><div class="dialogue" role="button" tabindex="0" aria-label="隐藏当前对白，下一次对白更新时显示"><div class="dialogue-scroll" tabindex="0" role="region" aria-label="角色台词">“<span id="dialogue-text" data-typing="false">${dialogueMarkup}</span>”</div></div></div></div></section></section><section class="table-bottom" aria-label="牌局操作区"><div class="opponent-hand hand-row"><span class="hand-label">${characterName} ${displayedHandValueMarkup(opponentBaseScore, opponentScoreModifier, reveal && state.opponent.busted, reveal && isBlackjack(state.opponent.hand))}</span><div class="cards" data-hand-scroll="opponent" tabindex="0" role="region" aria-label="对手手牌，可横向滑动">${opponentCards}</div></div><div class="table-notice-row"><output class="bust-limit-indicator" aria-label="当前爆牌上限：${bustLimit}" data-actor="${bustLimitActor}"><span>爆牌上限</span><strong>${bustLimit}</strong></output><section class="round-notice"><div id="presentation" class="presentation" data-default="${escapeHtml(notice)}" role="status" aria-live="polite">${escapeHtml(notice)}</div></section></div><section class="player-zone"><div class="player-layout"><div class="player-main"><div class="hand-row"><span class="hand-label">策展人 ${displayedHandValueMarkup(playerBaseScore, playerScoreModifier, state.player.busted, isBlackjack(state.player.hand))}</span><div class="cards" data-hand-scroll="player" tabindex="0" role="region" aria-label="玩家手牌，可横向滑动">${playerCards}</div></div>${advice}</div></div><div class="controls action-dock">${controls}</div></section></section><dialog id="skill-info-dialog" class="modal skill-info-modal" aria-labelledby="skill-info-title"><button class="modal-close" type="button" data-skill-close aria-label="关闭技能说明">×</button><p class="eyebrow" id="skill-info-kind"></p><details class="profile-ability"><summary><strong id="skill-info-title"></strong><span>：</span><span id="skill-info-description"></span></summary><p id="skill-info-lore"></p></details><details class="skill-rules" id="skill-info-rules"><summary>详细规则</summary><p id="skill-info-usage"></p></details><p class="status-line" id="skill-info-status"></p></dialog><dialog id="display-info-dialog" class="modal display-info-modal" aria-labelledby="display-info-title"><button class="modal-close" type="button" data-display-close aria-label="关闭持续信息说明">×</button><h2 id="display-info-title"></h2><output id="display-info-current"></output><p id="display-info-description"></p></dialog></main>${input.debugMarkup}${skillDrawerMarkup}${drawMarkup}`;

  return Object.freeze({ html, totalSkills, displays, shoeInfoDialog });
}
export type TableViewModel = ReturnType<typeof projectTableView>;
