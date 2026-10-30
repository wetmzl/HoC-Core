import { cardRank, cardSuit } from "../core/blackjack/card";
import type { Card } from "../core/blackjack/types";
import { getLegalActions } from "../core/match/reducer";
import type { Action, GameEvent, MatchState } from "../core/match/types";
import { CHARACTER_CATALOG, getCharacterMetadata, type CharacterUnlockCondition } from "../content/characters";
import { RESET_LONG_TERM_CONFIRM_MESSAGE } from "../persistence/long-term-recovery";
import { suitPresentation } from "./cards";
import { STAFF_REVOLVER_URL } from "../resources/cache-policy";

export const TUTORIAL_AUTO_SKIP_MS = 10000;

export const TUTORIAL_DISMISS_MS = 420;

export const ABILITY_NOTICE_TTL_MS = 2500;

export const ABILITY_NOTICE_LEAVE_MS = 280;

export const MAX_ABILITY_NOTICES = 3;

export const DEFEATED_GUEST_BATCH_SIZE = 3;

export const RESET_CONFIRM_MESSAGE = RESET_LONG_TERM_CONFIRM_MESSAGE;

export const RESET_RUNTIME_CONFIRM_MESSAGE = "未完成牌局与当前版本不兼容。确认后将只舍弃这局牌，长期战绩与解锁不会受到影响。";

export function secureSeed(): string {
    const bytes = new Uint32Array(4);
    if (!globalThis.crypto?.getRandomValues)
        throw new Error("当前环境没有可用的安全随机数，无法安全开始对局。");
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character); }

export function uiError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : fallback;
    if (/save|JSON|schema|match state|cursor|future/i.test(message))
        return "存档无效：请检查文件格式与版本。";
    return fallback;
}

export function cardLabel(card: Card): string { return `${cardRank(card)}${suitPresentation(cardSuit(card)).symbol}`; }

export function revealedOpponentCardIds(state: MatchState): ReadonlySet<string> {
    let start = -1;
    state.history.forEach((event, index) => { if (event.type === "ROUND_STARTED")
        start = index; });
    return new Set(state.history.slice(start + 1)
        .filter((entry) => entry.type === "CARD_SUIT_REVEALED" && entry.viewer === "player" && entry.target === "opponent")
        .map((entry) => entry.type === "CARD_SUIT_REVEALED" ? entry.cardId : ""));
}

export function revealedDrawPileSuitCardIds(state: MatchState): ReadonlySet<string> {
    let start = -1;
    state.history.forEach((event, index) => { if (event.type === "ROUND_STARTED")
        start = index; });
    return new Set(state.history.slice(start + 1).flatMap((entry) => (entry.type === "DRAW_PILE_CARD_SUIT_REVEALED" || entry.type === "DRAW_PILE_CARD_REVEALED") && entry.viewer === "player" ? [entry.cardId] : []));
}

export function revealedDrawPileRankCardIds(state: MatchState): ReadonlySet<string> {
    let start = -1;
    state.history.forEach((event, index) => { if (event.type === "ROUND_STARTED")
        start = index; });
    return new Set(state.history.slice(start + 1).flatMap((entry) => entry.type === "DRAW_PILE_CARD_REVEALED" && entry.viewer === "player" ? [entry.cardId] : []));
}

export function gunStatusMarkup(label: string, bullets: number, capacity: number): string {
    const chambers = Array.from({ length: capacity }, (_, index) => `<i class="${index < bullets ? "loaded" : ""}" aria-hidden="true"></i>`).join("");
    return `<div class="gun-status-row" aria-label="${escapeHtml(label)}：${capacity} 个弹巢，已装填 ${bullets} 发"><span class="gun-icon"><img src="${STAFF_REVOLVER_URL}" alt="" aria-hidden="true"></span><span class="gun-name">${escapeHtml(label)}</span><span class="gun-chambers">${chambers}</span></div>`;
}

export const PHASE_LABELS: Readonly<Record<MatchState["round"]["phase"], string>> = {
    dealing: "发牌中", "initial-blackjack-check": "检查黑杰克", turns: "行动阶段", settlement: "结算中",
    "round-reveal": "翻牌结果", "roulette-reaction": "轮盘反应", "roulette-trigger": "准备扣扳机",
    "roulette-result": "扳机结果", "round-end": "等待下一轮"
};

export function phaseLabel(phase: MatchState["round"]["phase"]): string { return PHASE_LABELS[phase]; }

export const ACTION_LABELS: Readonly<Record<Action["type"], string>> = {
    CONFIGURE_INTRINSIC_ABILITY: "配置自动能力", INVOKE_INTRINSIC_ABILITY: "调用自动能力",
    PLAYER_HIT: "策展人 Hit 要牌", PLAYER_STAND: "策展人 Stand 停牌", AI_TURN: "对手行动一次",
    AI_HIT: "对手 Hit 要牌", OPPONENT_HIT: "对手 Hit 要牌", AI_STAND: "对手 Stand 停牌", OPPONENT_STAND: "对手 Stand 停牌",
    PLAY_ABILITY: "使用能力", OPEN_SKILL_DRAW: "抽取技能", REFRESH_SKILL_DRAW: "刷新技能候选", SELECT_SKILL_DRAW: "选择技能", TRIGGER_ROULETTE: "扣下扳机", ACK_ROUND_RESULT: "确认本轮结果",
    ACK_TRIGGER_RESULT: "确认扳机结果", CONTINUE_ROUND: "进入下一轮", ESCAPE_MATCH: "逃离对局", ACK_MATCH_RESULT: "确认最终结果"
};

export const EVENT_LABELS: Readonly<Record<GameEvent["type"], string>> = {
    ABILITY_PLAYED: "使用能力", ABILITY_TRIGGERED: "能力触发", ABILITY_EXPIRED: "能力耗尽", ABILITY_RESOLUTION_FAILED: "能力解析失败",
    STATUS_ADDED: "获得状态", STATUS_REMOVED: "状态移除", PENDING_EVENT_MODIFIED: "修改待结算事件", PENDING_EVENT_CANCELLED: "取消待结算事件",
    HAND_CARD_DISCARDED: "弃掉手牌", HAND_REDEALT: "整手牌重发", ROUND_STARTED: "本轮开始", CARD_DEALT: "发牌", INITIAL_BLACKJACK_CHECK: "检查黑杰克",
    TURN_SKIPPED: "跳过回合",
    PLAYER_HIT: "策展人 Hit 要牌", OPPONENT_HIT: "对手 Hit 要牌", PLAYER_STOOD: "策展人 Stand 停牌", OPPONENT_STOOD: "对手 Stand 停牌",
    BLACKJACK: "黑杰克", BUST: "爆牌", ROUND_RESOLVED: "本轮结算", ROUND_RESULT_ACKNOWLEDGED: "已确认本轮结果",
    BULLET_ADDED: "装填子弹", TRIGGER_PULLED: "已扣下扳机", TRIGGER_SURVIVED: "空枪幸存", DEFEAT_PREVENTED: "抵御致命一击", TRIGGER_RESULT_ACKNOWLEDGED: "已确认扳机结果",
    PARTICIPANT_KILLED: "参与者倒下", SKILL_GAINED: "获得技能", SKILL_CARDS_REMOVED: "技能牌移除", MATCH_FINISHED: "对局结束",
    SKILL_DRAWS_ADDED: "获得抽卡次数", SKILL_DRAW_OPENED: "生成技能候选", SKILL_DRAW_REFRESHED: "刷新技能候选", SKILL_DRAW_RESOLVED: "完成技能抽取",
    MATCH_ESCAPED: "策展人离席", MATCH_RESULT_ACKNOWLEDGED: "已确认最终结果", AI_DECISION: "对手完成决策",
    CARD_REVEALED: "翻开暗牌", CARD_SUIT_REVEALED: "识破暗牌花色", DRAW_PILE_CARD_SUIT_REVEALED: "识破牌堆顶花色", DRAW_PILE_CARD_REVEALED: "识破牌堆顶牌面", ABILITY_RESULT: "能力结果"
};

export function decisionLabel(action: "hit" | "stand" | undefined): string { return action === "hit" ? "Hit 要牌" : action === "stand" ? "Stand 停牌" : "—"; }

export function displayedHandValueMarkup(baseScore: number | "?", modifier: number, busted: boolean, naturalBlackjack = false): string {
    const natural = naturalBlackjack && baseScore === 21 && !busted;
    const baseClass = `hand-score-base${busted ? " is-busted" : natural ? " is-blackjack" : ""}`;
    const status = busted ? "，已爆牌" : natural ? "，天然21点" : "";
    if (modifier === 0)
        return `<output class="hand-score"${status ? ` aria-label="手牌点数${baseScore}${status}"` : ""}><span class="${baseClass}">${baseScore}</span></output>`;
    const sign = modifier > 0 ? "+" : "−";
    const accessibleOperation = modifier > 0 ? "加" : "减";
    const finalScore = typeof baseScore === "number" ? baseScore + modifier : "未知";
    return `<output class="hand-score" aria-label="手牌点数${baseScore}${status}，点数优势${accessibleOperation}${Math.abs(modifier)}，比较点数${finalScore}"><span class="${baseClass}">${baseScore}</span><small class="hand-score-modifier" aria-hidden="true">${sign}${Math.abs(modifier)}</small></output>`;
}

export function legal(state: MatchState, action: Action): boolean { return getLegalActions(state).some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)); }

export function actionButton(label: string, action: Action, state: MatchState, className = "secondary-button"): string { const enabled = legal(state, action); return `<button class="${className}" data-action='${JSON.stringify(action)}' ${enabled ? "" : "disabled"}>${label}</button>`; }

export const TALENT_PLACEHOLDER_MILESTONES = Object.freeze([3, 5, 7, 10]);

export function wireActions(container: ParentNode, handler: (action: Action) => void): void { container.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((element) => element.addEventListener("click", () => handler(JSON.parse(element.dataset.action ?? "{}") as Action))); }

export function unlockConditionLabel(condition: CharacterUnlockCondition | undefined): string {
    if (!condition)
        return "完成条件后";
    if (condition.type === "defeat-any")
        return "击败任意角色";
    if (condition.type === "defeat-count")
        return `击败 ${condition.count} 名不同与会者`;
    if (condition.type === "defeat-faction-count") {
        const faction = CHARACTER_CATALOG.find(character => character.faction === condition.faction && character.badge)?.badge?.label ?? condition.faction;
        return `击败「${faction}」阵营的 ${condition.count} 名不同角色`;
    }
    const tagLabel = (tag: string): string => {
        const tier = /^tier:(d|c|b|a|s|ss)$/.exec(tag)?.[1];
        return tier ? `${tier.toUpperCase()}级` : `带有「${tag}」标签的`;
    };
    if (condition.type === "defeat-any-tag")
        return `击败一名${tagLabel(condition.tag)}角色`;
    if (condition.type === "defeat-character")
        return `击败指定角色 ${getCharacterMetadata(condition.characterId)?.name ?? condition.characterId}`;
    return `击败${tagLabel(condition.tag)}角色的 ${condition.percentage}%`;
}

export const REVOLVER_REFERENCE_ART_HEIGHT = 149.333;

export const DEV_REVOLVER_KEY = "blackjack-dev-revolver-offsets";

export const DEV_CALIBRATION_HASH = "#revolver-calibration";
