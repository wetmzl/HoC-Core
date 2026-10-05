import { haptics, bindHapticLifecycle } from "./presentation/haptic-service";
import { cardRank, cardSuit } from "./core/blackjack/card";
import type { Card } from "./core/blackjack/types";
import { buildObservation } from "./core/ai/observation";
import { abilityWorld, createMatch, getActiveBustLimit, getLegalActions, getRoundHitCounts, previewComparisonScores, previewPendingTrigger } from "./core/match/reducer";
import type { Action, GameEvent, MatchState } from "./core/match/types";
import { getPlayerSkillDefinition, PLAYER_SKILL_DEFINITIONS } from "./core/skills/definitions";
import { SKILL_TAG_METADATA, SKILL_TAGS, type SkillTag } from "./core/skills/types";
import { playerSkillsUnlockedForVictory, unlockedPlayerSkillIdsForDefeats } from "./core/skills/skills";
import { TALENT_DEFINITIONS, unlockedTalentIdsForDefeats } from "./core/talents/definitions";
import { ABILITY_REGISTRY, getAbilityDefinition } from "./core/abilities/registry";
import { isAbilityBlockedByStatus } from "./core/abilities/engine";
import { resolveDisplays, displayCardMarkers } from "./core/abilities/displays";
import { displayPanelMarkup, displayContentMarkup, displayText } from "./presentation/displays";
import { resolveDialogueLine, resolveDialogueState } from "./dialogue/state";
import { CHARACTER_CATALOG, DEFAULT_CHARACTER_ID, defeatedCharacterIdsByFirstDefeat, getCharacterMetadata, isCharacterUnlocked, loadCharacter, newlyUnlockedForDefeat, type CharacterDefinition, type CharacterUnlockCondition } from "./content/characters";
import { bootLoad, resetSave, restoreActiveMatch } from "./persistence/boot";
import { createAutosaveController, type AutosaveController } from "./persistence/autosave";
import { downloadRawSave, downloadSaveImage, downloadSaveJson, importSave } from "./persistence/json";
import { createPersistenceService } from "./persistence/factory";
import { RESET_LONG_TERM_CONFIRM_MESSAGE } from "./persistence/long-term-recovery";
import { bindNativePersistenceLifecycle } from "./persistence/lifecycle";
import { requestPersistentStorage } from "./persistence/storage";
import { SaveValidationError, type CharacterDefeatRecord, type LongTermSave } from "./persistence/schema";
import { getAiTurnDelayMs } from "./presentation/ai-timing";
import { abilityExpiredNotices, abilityTriggerNotice, pendingTriggerAbilityNotices, type AbilityNotice } from "./presentation/ability-notices";
import { presentInteractionHaptic, presentMatchHaptics, presentSkillSelectionHaptic } from "./presentation/haptics";
import { roundResultText, triggerResultText } from "./presentation/round-notice";
import { cardDisplayMarkup, describeCard, describeCards, diamondCardMarker, suitPresentation } from "./presentation/cards";
import { gameAudio } from "./audio/game-audio";
import { presentMatchAudio, presentOpeningMatchAudio, syncMatchAudioState } from "./audio/match-audio";
import { characterResourcePlan, lobbyResourceUrls, resourceLoader } from "./resources/resource-loader";
import { STAFF_REVOLVER_URL } from "./resources/cache-policy";
import { skillArchetypeArtUrls, type SkillArchetypeArt } from "./resources/skill-archetype-art";
import { ADULT_CONTENT_WARNING_ID, completeTutorial, firstTutorialForCue, type TutorialCue, type TutorialDefinition, type TutorialResource } from "./tutorials/tutorials";
import type { PluginRuntimeContext, PluginRuntimeContribution } from "./content/packages/plugin-contracts";
import type { MountedScreen } from "./runtime/contracts";
import type { LobbyLayer } from "./lobby-screen-module";
import { selectSaveCoverImage } from "./runtime/save-cover";
import { alertGameDialog, confirmGameDialog } from "./game-dialog";

let root!: HTMLDivElement;
let repository!: ReturnType<typeof createPersistenceService>;
let mounted = false;
let hapticLifecycleDisposer: (() => Promise<void>) | undefined;
let nativeLifecycleDisposer: (() => Promise<void>) | undefined;
let runtimeEventController: AbortController | undefined;
let requestExitToLauncher: (() => Promise<void>) | undefined;
let save: LongTermSave;
let saveLoaded = false;
let autosave: AutosaveController | null = null;
let currentCharacter!: CharacterDefinition;
let selectedCharacterId = DEFAULT_CHARACTER_ID;
let presentationTimer: number | undefined;
let presentationHideTimer: number | undefined;
let dialogueTimer: number | undefined;
let dialogueShakeTimer: number | undefined;
let dialogueAutoFollow = true;
let aiActionTimer: number | undefined;
let aiPoseTimer: number | undefined;
let aiPoseShakeTimer: number | undefined;
let aiScheduleKey: string | null = null;
let characterLoadInFlight = false;
let characterLoadToken = 0;
let lastAction: Action | null = null;
let lastDomainEvent: GameEvent["type"] | null = null;
let lastDialogueKey: string | null = null;
let skillDrawerOpen = false;
let activeTutorial: { readonly definition: TutorialDefinition; readonly pageIndex: number; readonly autoSkipCancelled: boolean } | null = null;
let tutorialAutoSkipTimer: number | undefined;
let tutorialDismissAnimation: Animation | null = null;
const TUTORIAL_AUTO_SKIP_MS = 10_000;
const TUTORIAL_DISMISS_MS = 420;
const abilityNoticeTimers = new Map<HTMLElement, { readonly expire: number; readonly remove: number }>();
const ABILITY_NOTICE_TTL_MS = 2500;
const ABILITY_NOTICE_LEAVE_MS = 280;
const MAX_ABILITY_NOTICES = 5;
let fullscreenChangeAttached = false;
let abilityNoticePositionAttached = false;
let interactionHapticsAttached = false;
let lobbyLayer: LobbyLayer = "menu";
let guestSelectionIds: string[] = [];
let defeatedGuestObserver: IntersectionObserver | null = null;
let pendingImportedSave: unknown;
let auxiliaryScreenController: AbortController | undefined;
let auxiliaryMountedScreen: MountedScreen | undefined;
let auxiliaryNavigationToken = 0;
let runtimeContributions: readonly PluginRuntimeContribution[] = [];
let skillArchetypeArt: SkillArchetypeArt = {};
let lobbyModulePromise: Promise<typeof import("./lobby-screen-module")> | undefined;
let lobbyModule: typeof import("./lobby-screen-module") | undefined;
let tableModulePromise: Promise<unknown> | undefined;
const DEFEATED_GUEST_BATCH_SIZE = 3;

const RESET_CONFIRM_MESSAGE = RESET_LONG_TERM_CONFIRM_MESSAGE;
const RESET_RUNTIME_CONFIRM_MESSAGE = "未完成牌局与当前版本不兼容。确认后将只舍弃这局牌，长期战绩与解锁不会受到影响。";

function secureSeed(): string {
  const bytes = new Uint32Array(4);
  if (!globalThis.crypto?.getRandomValues) throw new Error("当前环境没有可用的安全随机数，无法安全开始对局。");
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(8, "0")).join("");
}
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character); }
async function requireAdultContentAcknowledgement(): Promise<void> {
  if (save.tutorialProgress.completedIds.includes(ADULT_CONTENT_WARNING_ID)) return;
  root.inert = true;
  const backdrop = document.createElement("div");
  backdrop.className = "adult-content-warning-backdrop";
  backdrop.innerHTML = `<section id="adult-content-warning" class="adult-content-warning-modal" role="dialog" aria-modal="true" aria-labelledby="adult-content-warning-title" aria-describedby="adult-content-warning-copy adult-content-warning-disclaimer"><p class="eyebrow">House of Chances</p><h1 id="adult-content-warning-title">成人内容警告</h1><p id="adult-content-warning-copy">本作包含赌博及其他不适宜年轻玩家游玩的主题，仅面向成年玩家。</p><p id="adult-content-warning-disclaimer">游戏支持玩家自行导入社区模组。社区模组由各自作者提供，内容可能与基础游戏不同，请在导入前确认其内容说明。</p><button type="button" class="primary-button" data-acknowledge-adult-content>我已成年并继续</button><p class="adult-content-warning-status" role="status" aria-live="polite"></p></section>`;
  document.body.append(backdrop);
  const button = backdrop.querySelector<HTMLButtonElement>("[data-acknowledge-adult-content]");
  button?.focus();
  await new Promise<void>((resolve) => {
    button?.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      const status = backdrop.querySelector<HTMLElement>(".adult-content-warning-status");
      const progress = completeTutorial(save.tutorialProgress, ADULT_CONTENT_WARNING_ID);
      const nextSave = { ...save, tutorialProgress: { completedIds: [...progress.completedIds] }, updatedAt: new Date().toISOString() };
      void repository.saveLongTerm(nextSave).then(() => {
        save = nextSave;
        backdrop.remove();
        root.inert = false;
        resolve();
      }).catch(() => {
        button.disabled = false;
        if (status) status.textContent = "确认状态保存失败，请重试。";
        button.focus();
      });
    });
  });
}
function tutorialResourceMarkup(resource: TutorialResource): string {
  if (resource.type !== "image") return "";
  return `<figure class="tutorial-resource"><img src="${escapeHtml(resource.src)}" alt="${escapeHtml(resource.alt)}">${resource.caption ? `<figcaption>${escapeHtml(resource.caption)}</figcaption>` : ""}</figure>`;
}
function clearTutorialAutoSkip(): void {
  window.clearTimeout(tutorialAutoSkipTimer);
  tutorialAutoSkipTimer = undefined;
  tutorialDismissAnimation?.cancel();
  tutorialDismissAnimation = null;
}
function clearTutorialSurface(): void {
  clearTutorialAutoSkip();
  document.querySelector("#tutorial-popover")?.remove();
}
function discardActiveTutorial(): void {
  activeTutorial = null;
  clearTutorialSurface();
}
function cancelTutorialAutoSkip(surface: HTMLElement): void {
  if (!activeTutorial || activeTutorial.autoSkipCancelled) return;
  activeTutorial = { ...activeTutorial, autoSkipCancelled: true };
  clearTutorialAutoSkip();
  surface.classList.remove("is-auto-dismissing");
  surface.classList.add("is-auto-skip-cancelled");
}
function startTutorialAutoSkip(surface: HTMLElement): void {
  if (!activeTutorial || activeTutorial.autoSkipCancelled) return;
  tutorialAutoSkipTimer = window.setTimeout(() => {
    tutorialAutoSkipTimer = undefined;
    if (!activeTutorial || activeTutorial.autoSkipCancelled || !surface.isConnected) return;
    surface.classList.add("is-auto-dismissing");
    const animation = surface.animate([
      { opacity: 1, transform: "translateY(0) scale(1)" },
      { opacity: 0, transform: "translateY(-6px) scale(.985)" }
    ], { duration: save.settings.reducedMotion ? 1 : TUTORIAL_DISMISS_MS, easing: "ease", fill: "forwards" });
    tutorialDismissAnimation = animation;
    void animation.finished.then(() => {
      if (tutorialDismissAnimation !== animation || !surface.isConnected || activeTutorial?.autoSkipCancelled) return;
      tutorialDismissAnimation = null;
      finishActiveTutorial();
    }).catch(() => undefined);
  }, TUTORIAL_AUTO_SKIP_MS);
}
function finishActiveTutorial(): void {
  if (!activeTutorial) return;
  const progress = completeTutorial(save.tutorialProgress, activeTutorial.definition.id);
  activeTutorial = null;
  clearTutorialSurface();
  if (progress === save.tutorialProgress) return;
  save = { ...save, tutorialProgress: { completedIds: [...progress.completedIds] }, updatedAt: new Date().toISOString() };
  if (autosave) {
    autosave.updateSave(save);
    void autosave.flush().catch(() => enqueueNotification("教程进度保存失败，请稍后重试。"));
  } else void repository.saveLongTerm(save).catch(() => enqueueNotification("教程进度保存失败，请稍后重试。"));
}
function renderTutorialSurface(): void {
  clearTutorialSurface();
  if (!activeTutorial) return;
  const { definition, pageIndex, autoSkipCancelled } = activeTutorial;
  const page = definition.pages[pageIndex];
  if (!page) return;
  const surface = document.createElement("aside");
  surface.id = "tutorial-popover";
  surface.className = `tutorial-popover${autoSkipCancelled ? " is-auto-skip-cancelled" : ""}`;
  surface.dataset.tutorialId = definition.id;
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-modal", "false");
  surface.setAttribute("aria-labelledby", "tutorial-title");
  const lastPage = pageIndex === definition.pages.length - 1;
  const resources = page.resources?.map(tutorialResourceMarkup).join("") ?? "";
  surface.innerHTML = `<div class="tutorial-heading"><span>机制介绍：page ${pageIndex + 1}/${definition.pages.length}</span><h2 id="tutorial-title">${escapeHtml(definition.title)}</h2></div><p>${escapeHtml(page.body)}</p>${resources ? `<div class="tutorial-resources">${resources}</div>` : ""}<div class="tutorial-actions"><button type="button" class="tutorial-skip" data-tutorial-skip>跳过</button><button type="button" class="tutorial-next" data-tutorial-next>${lastPage ? "好的" : "下一步"}</button></div><span class="tutorial-auto-progress" aria-hidden="true"></span>`;
  document.body.append(surface);
  surface.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-tutorial-skip]")) cancelTutorialAutoSkip(surface);
  }, { capture: true });
  surface.querySelector<HTMLButtonElement>("[data-tutorial-skip]")?.addEventListener("click", finishActiveTutorial);
  surface.querySelector<HTMLButtonElement>("[data-tutorial-next]")?.addEventListener("click", () => {
    if (lastPage) { finishActiveTutorial(); return; }
    activeTutorial = { definition, pageIndex: pageIndex + 1, autoSkipCancelled: activeTutorial?.autoSkipCancelled ?? autoSkipCancelled };
    renderTutorialSurface();
  });
  startTutorialAutoSkip(surface);
}
function offerTutorial(cue: TutorialCue): void {
  if (activeTutorial) return;
  const definition = firstTutorialForCue(cue, save.tutorialProgress, save.skipTutorial);
  if (!definition) return;
  activeTutorial = { definition, pageIndex: 0, autoSkipCancelled: false };
  renderTutorialSurface();
}
function uiError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  if (/save|JSON|schema|match state|cursor|future/i.test(message)) return "存档无效：请检查文件格式与版本。";
  return fallback;
}
function cardLabel(card: Card): string { return `${cardRank(card)}${suitPresentation(cardSuit(card)).symbol}`; }
function revealedOpponentCardIds(state: MatchState): ReadonlySet<string> {
  let start = -1;
  state.history.forEach((event, index) => { if (event.type === "ROUND_STARTED") start = index; });
  return new Set(state.history.slice(start + 1)
    .filter((entry) => entry.type === "CARD_SUIT_REVEALED" && entry.viewer === "player" && entry.target === "opponent")
    .map((entry) => entry.type === "CARD_SUIT_REVEALED" ? entry.cardId : ""));
}
function revealedDrawPileSuitCardIds(state: MatchState): ReadonlySet<string> {
  let start = -1;
  state.history.forEach((event, index) => { if (event.type === "ROUND_STARTED") start = index; });
  return new Set(state.history.slice(start + 1).flatMap((entry) =>
    (entry.type === "DRAW_PILE_CARD_SUIT_REVEALED" || entry.type === "DRAW_PILE_CARD_REVEALED") && entry.viewer === "player" ? [entry.cardId] : []));
}
function revealedDrawPileRankCardIds(state: MatchState): ReadonlySet<string> {
  let start = -1;
  state.history.forEach((event, index) => { if (event.type === "ROUND_STARTED") start = index; });
  return new Set(state.history.slice(start + 1).flatMap((entry) =>
    entry.type === "DRAW_PILE_CARD_REVEALED" && entry.viewer === "player" ? [entry.cardId] : []));
}
function gunStatusMarkup(label: string, bullets: number, capacity: number): string {
  const chambers = Array.from({ length: capacity }, (_, index) => `<i class="${index < bullets ? "loaded" : ""}" aria-hidden="true"></i>`).join("");
  return `<div class="gun-status-row" aria-label="${escapeHtml(label)}：${capacity} 个弹巢，已装填 ${bullets} 发"><span class="gun-icon"><img src="${STAFF_REVOLVER_URL}" alt="" aria-hidden="true"></span><span class="gun-name">${escapeHtml(label)}</span><span class="gun-chambers">${chambers}</span></div>`;
}
function abilityNoticeContainer(): HTMLDivElement {
  const existing = document.querySelector<HTMLDivElement>("#ability-notices");
  if (existing) return existing;
  const container = document.createElement("div");
  container.id = "ability-notices";
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-atomic", "false");
  document.body.append(container);
  return container;
}
function syncAbilityNoticePosition(): void {
  const container = document.querySelector<HTMLDivElement>("#ability-notices");
  if (!container) return;
  const anchor = root.querySelector<HTMLElement>(".display-panel.is-expanded .display-toggle") ?? root.querySelector<HTMLElement>(".display-panel") ?? root.querySelector<HTMLElement>(".shoe-status") ?? root.querySelector<HTMLElement>(".roulette-status");
  if (!anchor) return;
  const anchorRect = anchor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const containerWidth = container.getBoundingClientRect().width;
  const sideInset = 10;
  const rawRight = viewportWidth - anchorRect.right;
  const maxRight = Math.max(sideInset, viewportWidth - sideInset - containerWidth);
  const right = Math.min(Math.max(rawRight, sideInset), maxRight);
  container.style.top = `${Math.max(sideInset, anchorRect.bottom + 8)}px`;
  container.style.right = `${right}px`;
  container.style.left = "auto";
}
function attachAbilityNoticePositionListener(): void {
  if (abilityNoticePositionAttached) return;
  window.addEventListener("resize", syncAbilityNoticePosition);
  abilityNoticePositionAttached = true;
}
function detachAbilityNoticePositionListener(): void {
  if (!abilityNoticePositionAttached) return;
  window.removeEventListener("resize", syncAbilityNoticePosition);
  abilityNoticePositionAttached = false;
}
function removeAbilityNotice(node: HTMLElement): void {
  const timers = abilityNoticeTimers.get(node);
  if (timers) { window.clearTimeout(timers.expire); window.clearTimeout(timers.remove); abilityNoticeTimers.delete(node); }
  node.remove();
}
function expireAbilityNotice(node: HTMLElement): void {
  if (!node.isConnected) { removeAbilityNotice(node); return; }
  node.classList.add("leaving");
  const remove = window.setTimeout(() => removeAbilityNotice(node), ABILITY_NOTICE_LEAVE_MS);
  const timers = abilityNoticeTimers.get(node);
  if (timers) abilityNoticeTimers.set(node, { ...timers, remove });
}
function enqueueAbilityNotices(notices: readonly AbilityNotice[]): void {
  if (notices.length === 0) return;
  const container = abilityNoticeContainer();
  syncAbilityNoticePosition();
  for (const notice of notices) {
    const node = document.createElement("div");
    node.className = `ability-notice ability-notice-${notice.tone}`;
    node.dataset.owner = notice.owner;
    node.dataset.tone = notice.tone;
    node.setAttribute("role", "status");
    node.textContent = notice.text;
    node.addEventListener("animationend", (event) => {
      if (event.animationName === "ability-notice-leave") removeAbilityNotice(node);
    });
    container.prepend(node);
    const expire = window.setTimeout(() => expireAbilityNotice(node), ABILITY_NOTICE_TTL_MS);
    abilityNoticeTimers.set(node, { expire, remove: 0 });
    while (container.childElementCount > MAX_ABILITY_NOTICES) {
      const oldest = container.lastElementChild;
      if (oldest instanceof HTMLElement) removeAbilityNotice(oldest);
      else break;
    }
  }
}
function enqueueNotification(text: string): void {
  enqueueAbilityNotices([{ owner: "system", tone: "notification", text }]);
}
function clearAbilityNoticeQueue(): void {
  for (const node of [...abilityNoticeTimers.keys()]) removeAbilityNotice(node);
  document.querySelectorAll("#ability-notices .ability-notice").forEach((node) => node.remove());
}
function syncFullscreenButton(): void {
  syncAbilityNoticePosition();
  const button = root.querySelector<HTMLButtonElement>("[data-fullscreen]");
  if (!button) return;
  const active = Boolean(document.fullscreenElement);
  button.textContent = active ? "⛶" : "⛶";
  button.setAttribute("aria-label", active ? "退出全屏" : "进入全屏");
  button.title = active ? "退出全屏" : "进入全屏";
}
function detachFullscreenListener(): void {
  if (!fullscreenChangeAttached) return;
  document.removeEventListener("fullscreenchange", syncFullscreenButton); fullscreenChangeAttached = false;
  detachAbilityNoticePositionListener();
}
function attachFullscreenListener(): void {
  if (fullscreenChangeAttached) return;
  document.addEventListener("fullscreenchange", syncFullscreenButton); fullscreenChangeAttached = true;
  attachAbilityNoticePositionListener();
}
function toggleFullscreen(): void {
  if (document.fullscreenElement) { void document.exitFullscreen().catch(() => enqueueNotification("无法退出全屏。")); return; }
  if (!document.documentElement.requestFullscreen) { enqueueNotification("当前环境不支持全屏。"); return; }
  void document.documentElement.requestFullscreen().catch(() => enqueueNotification("全屏请求未获允许。"));
}
const PHASE_LABELS: Readonly<Record<MatchState["round"]["phase"], string>> = {
  dealing: "发牌中", "initial-blackjack-check": "检查黑杰克", turns: "行动阶段", settlement: "结算中",
  "round-reveal": "翻牌结果", "roulette-reaction": "轮盘反应", "roulette-trigger": "准备扣扳机",
  "roulette-result": "扳机结果", "round-end": "等待下一轮"
};
function phaseLabel(phase: MatchState["round"]["phase"]): string { return PHASE_LABELS[phase]; }
const ACTION_LABELS: Readonly<Record<Action["type"], string>> = {
  PLAYER_HIT: "策展人 Hit 要牌", PLAYER_STAND: "策展人 Stand 停牌", AI_TURN: "对手行动一次",
  AI_HIT: "对手 Hit 要牌", OPPONENT_HIT: "对手 Hit 要牌", AI_STAND: "对手 Stand 停牌", OPPONENT_STAND: "对手 Stand 停牌",
  PLAY_ABILITY: "使用能力", OPEN_SKILL_DRAW: "抽取技能", SELECT_SKILL_DRAW: "选择技能", TRIGGER_ROULETTE: "扣下扳机", ACK_ROUND_RESULT: "确认本轮结果",
  ACK_TRIGGER_RESULT: "确认扳机结果", CONTINUE_ROUND: "进入下一轮", ESCAPE_MATCH: "逃离对局", ACK_MATCH_RESULT: "确认最终结果"
};
const EVENT_LABELS: Readonly<Record<GameEvent["type"], string>> = {
  ABILITY_PLAYED: "使用能力", ABILITY_TRIGGERED: "能力触发", ABILITY_EXPIRED: "能力耗尽", ABILITY_RESOLUTION_FAILED: "能力解析失败",
  STATUS_ADDED: "获得状态", STATUS_REMOVED: "状态移除", PENDING_EVENT_MODIFIED: "修改待结算事件", PENDING_EVENT_CANCELLED: "取消待结算事件",
  HAND_REDEALT: "整手牌重发", ROUND_STARTED: "本轮开始", CARD_DEALT: "发牌", INITIAL_BLACKJACK_CHECK: "检查黑杰克",
  TURN_SKIPPED: "跳过回合",
  PLAYER_HIT: "策展人 Hit 要牌", OPPONENT_HIT: "对手 Hit 要牌", PLAYER_STOOD: "策展人 Stand 停牌", OPPONENT_STOOD: "对手 Stand 停牌",
  BLACKJACK: "黑杰克", BUST: "爆牌", ROUND_RESOLVED: "本轮结算", ROUND_RESULT_ACKNOWLEDGED: "已确认本轮结果",
  BULLET_ADDED: "装填子弹", TRIGGER_PULLED: "已扣下扳机", TRIGGER_SURVIVED: "空枪幸存", TRIGGER_RESULT_ACKNOWLEDGED: "已确认扳机结果",
  PARTICIPANT_KILLED: "参与者倒下", SKILL_GAINED: "获得技能", MATCH_FINISHED: "对局结束",
  SKILL_DRAWS_ADDED: "获得抽卡次数", SKILL_DRAW_OPENED: "生成技能候选", SKILL_DRAW_RESOLVED: "完成技能抽取",
  MATCH_ESCAPED: "策展人离席", MATCH_RESULT_ACKNOWLEDGED: "已确认最终结果", AI_DECISION: "对手完成决策",
  CARD_SUIT_REVEALED: "识破暗牌花色", DRAW_PILE_CARD_SUIT_REVEALED: "识破牌堆顶花色", DRAW_PILE_CARD_REVEALED: "识破牌堆顶牌面", ABILITY_RESULT: "能力结果"
};
function decisionLabel(action: "hit" | "stand" | undefined): string { return action === "hit" ? "Hit 要牌" : action === "stand" ? "Stand 停牌" : "—"; }
function displayedHandValueMarkup(baseScore: number | "?", modifier: number): string {
  if (modifier === 0) return `<output class="hand-score"><span class="hand-score-base">${baseScore}</span></output>`;
  const sign = modifier > 0 ? "+" : "−";
  const accessibleOperation = modifier > 0 ? "加" : "减";
  const finalScore = typeof baseScore === "number" ? baseScore + modifier : "未知";
  return `<output class="hand-score" aria-label="${baseScore}${accessibleOperation}${Math.abs(modifier)}，当前点数${finalScore}"><span class="hand-score-base">${baseScore}</span><small class="hand-score-modifier" aria-hidden="true">${sign}${Math.abs(modifier)}</small></output>`;
}
function legal(state: MatchState, action: Action): boolean { return getLegalActions(state).some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)); }
function actionButton(label: string, action: Action, state: MatchState, className = "secondary-button"): string { const enabled = legal(state, action); return `<button class="${className}" data-action='${JSON.stringify(action)}' ${enabled ? "" : "disabled"}>${label}</button>`; }

let skillManagementTab: "skills" | "talents" = "skills";
let skillSaveRequest = 0;
let skillManagementSelectedTags: SkillTag[] | null = null;
const TALENT_PLACEHOLDER_MILESTONES = Object.freeze([3, 5, 7, 10]);

function skillCatalogCardMarkup(skill: (typeof PLAYER_SKILL_DEFINITIONS)[number], unlocked: ReadonlySet<string>): string {
  const available = unlocked.has(skill.id);
  const source = skill.unlock ? `解锁来源：${skill.unlock.label}` : "初始技能";
  const tags = skill.skillTags.map((tag) => `<span class="skill-tag-label">${SKILL_TAG_METADATA[tag].label}</span>`).join("");
  return `<div class="loadout-skill ${available ? "" : "locked"}"><div><details class="profile-ability"><summary><strong>${escapeHtml(skill.name)}</strong><span>：${escapeHtml(skill.description)}</span></summary><p>${escapeHtml(skill.profileLore)}</p></details><div class="skill-list-meta"><span>${skill.category === "passive" ? "被动" : "主动"}</span>${tags}</div><small>${escapeHtml(source)} · ${available ? "已解锁，可在牌局中掉落" : "尚未解锁"}</small></div></div>`;
}

function skillCatalogMarkup(): string {
  const unlocked = new Set(unlockedPlayerSkillIdsForDefeats(save.defeats));
  return SKILL_TAGS.map((tag) => {
    const metadata = SKILL_TAG_METADATA[tag];
    const skills = PLAYER_SKILL_DEFINITIONS.filter((skill) => skill.skillTags[0] === tag);
    return `<details class="skill-catalog-group" data-primary-skill-tag="${tag}"><summary><span class="skill-catalog-group-title"><span aria-hidden="true">${metadata.symbol}</span>${metadata.label}</span><small>${skills.length} 项技能</small></summary><div class="skill-catalog-group-list">${skills.map((skill) => skillCatalogCardMarkup(skill, unlocked)).join("")}</div></details>`;
  }).join("");
}

function talentRoadMarkup(): string {
  const defeatCount = defeatedCharacterIdsByFirstDefeat(save.defeats).length;
  const unlockedTalentIds = new Set(unlockedTalentIdsForDefeats(save.defeats));
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
    ...TALENT_PLACEHOLDER_MILESTONES
      .filter((count) => !occupiedMilestones.has(count))
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
}

function renderSkillList(statusMessage = ""): string {
  const selected = new Set(skillManagementSelectedTags ?? save.profile.selectedSkillTags);
  const selectedCount = selected.size;
  const tagCards = SKILL_TAGS.map((tag) => {
    const metadata = SKILL_TAG_METADATA[tag];
    const pressed = selected.has(tag);
    const art = skillArchetypeArt[tag];
    const image = pressed ? art?.selected : art?.default;
    return `<div class="skill-tag-frame"><button type="button" class="skill-tag-card ${pressed ? "is-selected" : ""} ${image ? "" : "is-default-art"}" data-skill-tag="${tag}" aria-label="${pressed ? `取消选择${metadata.label}流派` : `选择${metadata.label}流派`}" aria-pressed="${pressed ? "true" : "false"}">${image ? `<img src="${escapeHtml(image)}" alt="" aria-hidden="true" decoding="async">` : `<span class="skill-tag-poker" aria-hidden="true"><span>${metadata.symbol}</span><b>${metadata.symbol}</b><span>${metadata.symbol}</span></span>`}<span class="skill-tag-card-shade" aria-hidden="true"></span><span class="skill-tag-card-copy"><span class="skill-tag-symbol" aria-hidden="true">${metadata.symbol}</span><strong>${metadata.label}</strong><small>${pressed ? "已选择" : "选择流派"}</small></span><span class="skill-tag-check" aria-hidden="true">✓</span></button><button type="button" class="skill-tag-info-button" data-skill-tag-info="${tag}" aria-controls="skill-tag-info-dialog" aria-haspopup="dialog" aria-label="查看${metadata.label}流派说明"><span aria-hidden="true">i</span></button></div>`;
  }).join("");
  return `<div class="skill-management-tabs" role="tablist" aria-label="技能与天赋"><button type="button" role="tab" id="skill-tab" aria-controls="skill-panel" aria-selected="${skillManagementTab === "skills"}" class="skill-management-tab ${skillManagementTab === "skills" ? "is-active" : ""}" data-skill-tab="skills">技能</button><button type="button" role="tab" id="talent-tab" aria-controls="talent-panel" aria-selected="${skillManagementTab === "talents"}" class="skill-management-tab ${skillManagementTab === "talents" ? "is-active" : ""}" data-skill-tab="talents">天赋</button></div>${skillManagementTab === "skills" ? `<section id="skill-panel" role="tabpanel" aria-labelledby="skill-tab" class="skill-management-panel"><div class="skill-tag-heading"><h3>对应流派技能出现概率 ×4</h3><output aria-live="polite">已选 ${selectedCount}/2</output></div><div class="skill-tag-grid">${tagCards}</div><p id="skill-management-status" class="status-line" role="status" aria-live="polite">${escapeHtml(statusMessage)}</p><div class="skill-panel-footer"><p>局内候选来自全部已解锁技能；天赋不进入技能牌库。</p><button type="button" class="secondary-button skill-catalog-button" data-open-skill-catalog aria-controls="skill-catalog">技能大全</button></div></section>` : `<section id="talent-panel" role="tabpanel" aria-labelledby="talent-tab" class="skill-management-panel talent-panel">${talentRoadMarkup()}</section>`}`;
}

function showSkillTagInfo(tag: SkillTag): void {
  if (!SKILL_TAGS.includes(tag)) return;
  const dialog = root.querySelector<HTMLDialogElement>("#skill-tag-info-dialog");
  const title = root.querySelector<HTMLElement>("#skill-tag-info-title");
  const copy = root.querySelector<HTMLElement>("#skill-tag-info-copy");
  if (!dialog || !title || !copy) return;
  title.textContent = `${SKILL_TAG_METADATA[tag].label}流派`;
  copy.textContent = SKILL_TAG_METADATA[tag].summary;
  if (!dialog.open) dialog.showModal();
}

function renderSkillManagement(statusMessage = ""): void {
  const dialog = root.querySelector<HTMLDialogElement>("#skills");
  const content = root.querySelector<HTMLDivElement>("#skill-content");
  if (!dialog || !content) return;
  content.innerHTML = renderSkillList(statusMessage);
  content.onclick = (event) => {
    const target = event.target as Element;
    const tab = target.closest<HTMLButtonElement>("[data-skill-tab]");
    if (tab) {
      skillManagementTab = tab.dataset.skillTab === "talents" ? "talents" : "skills";
      renderSkillManagement();
      return;
    }
    const infoButton = target.closest<HTMLButtonElement>("[data-skill-tag-info]");
    if (infoButton) {
      showSkillTagInfo(infoButton.dataset.skillTagInfo as SkillTag);
      return;
    }
    const tagButton = target.closest<HTMLButtonElement>("[data-skill-tag]");
    if (tagButton) void toggleSkillTag(tagButton.dataset.skillTag as SkillTag);
    const catalogButton = target.closest<HTMLButtonElement>("[data-open-skill-catalog]");
    if (catalogButton) openSkillCatalog();
  };
}

function openSkillCatalog(): void {
  const dialog = root.querySelector<HTMLDialogElement>("#skill-catalog");
  const content = root.querySelector<HTMLDivElement>("#skill-catalog-content");
  if (!dialog || !content) return;
  content.innerHTML = skillCatalogMarkup();
  if (!dialog.open) dialog.showModal();
}

async function toggleSkillTag(tag: SkillTag): Promise<void> {
  if (!SKILL_TAGS.includes(tag)) return;
  const selected = [...save.profile.selectedSkillTags];
  const index = selected.indexOf(tag);
  if (index >= 0) selected.splice(index, 1);
  else if (selected.length >= 2) { renderSkillManagement("最多选择两个流派"); return; }
  else selected.push(tag);
  const nextSave = { ...save, profile: { ...save.profile, selectedSkillTags: selected }, updatedAt: new Date().toISOString() };
  save = nextSave;
  skillManagementSelectedTags = selected;
  const signal = runtimeEventController?.signal;
  if (signal && !signal.aborted) {
    const selection = { tag, selected: index < 0 };
    for (const contribution of runtimeContributions) {
      try {
        void Promise.resolve(contribution.presentSkillSelection?.(selection, signal)).catch((error) => console.error("插件技能选择表现失败", error));
      } catch (error) { console.error("插件技能选择表现失败", error); }
    }
  }
  presentSkillSelectionHaptic(!save.settings.reducedMotion);
  const request = ++skillSaveRequest;
  renderSkillManagement("正在保存…");
  try {
    await repository.saveLongTerm(nextSave);
    if (request === skillSaveRequest) renderSkillManagement("选择已保存");
  } catch {
    if (request === skillSaveRequest) renderSkillManagement("保存失败，请重试");
  }
}

function openSkillManagement(): void {
  skillManagementTab = "skills";
  skillManagementSelectedTags = [...save.profile.selectedSkillTags];
  renderSkillManagement();
  const dialog = root.querySelector<HTMLDialogElement>("#skills");
  if (dialog && !dialog.open) dialog.showModal();
}

function isAiTurn(state: MatchState): boolean {
  return state.status === "active"
    && state.scene === "match"
    && state.view === "table"
    && state.round.phase === "turns"
    && state.round.currentActor === "opponent"
    && legal(state, { type: "AI_TURN" });
}

function clearAiSchedule(): void {
  window.clearTimeout(aiActionTimer);
  window.clearTimeout(aiPoseTimer);
  window.clearTimeout(aiPoseShakeTimer);
  aiActionTimer = undefined;
  aiPoseTimer = undefined;
  aiPoseShakeTimer = undefined;
  aiScheduleKey = null;
}

function scheduleAiTurn(state: MatchState): void {
  if (!isAiTurn(state)) { clearAiSchedule(); return; }
  const key = `${state.id}:${state.roundIndex}:${state.history.length}`;
  if (aiScheduleKey === key) return;
  clearAiSchedule();
  aiScheduleKey = key;
  const delay = getAiTurnDelayMs(state);
  aiPoseTimer = window.setTimeout(() => {
    if (aiScheduleKey !== key) return;
    const live = autosave?.getState();
    if (!live || !isAiTurn(live)) { clearAiSchedule(); return; }
    const portrait = root.querySelector<HTMLImageElement>(".character-portrait");
    if (portrait) {
      portrait.src = currentCharacter.assets.conflicted;
      portrait.alt = `${currentCharacter.name} 正在思考中……`;
      portrait.classList.add("character-shake");
      aiPoseShakeTimer = window.setTimeout(() => portrait.classList.remove("character-shake"), 360);
    }
    const waiting = root.querySelector<HTMLElement>("#ai-wait");
    if (waiting) {
      waiting.textContent = `${currentCharacter.name} 正在思考中……`;
      waiting.dataset.step = "shifted";
    }
  }, Math.round(delay / 2));
  aiActionTimer = window.setTimeout(() => {
    if (aiScheduleKey !== key) return;
    const live = autosave?.getState();
    clearAiSchedule();
    if (live && isAiTurn(live)) dispatch({ type: "AI_TURN" });
  }, delay);
}

function currentDialogue(state: MatchState): string {
  return resolveDialogueLine(state, currentCharacter.dialogue) ?? "牌桌正在等你下注。";
}
function dialogueKey(state: MatchState): string { return resolveDialogueState(state).key; }
function tablePortrait(state: MatchState, character: CharacterDefinition): string {
  if (state.round.phase === "roulette-result" && state.outcome?.reason === "opponent-killed") return character.assets.unconscious;
  if (state.round.phase === "roulette-trigger" && state.round.outcome?.penaltyTarget === "opponent") return character.assets.threatened;
  if (state.round.phase === "round-reveal" && state.round.outcome?.winner === "opponent") return character.assets.mocking;
  return character.assets.relaxed;
}
function portraitState(state: MatchState): string {
  if (state.round.phase === "roulette-result" && state.outcome?.reason === "opponent-killed") return "unconscious";
  if (state.round.phase === "roulette-trigger" && state.round.outcome?.penaltyTarget === "opponent") return "trigger";
  if (state.round.phase === "round-reveal" && state.round.outcome?.winner === "opponent") return "mocking";
  return "relaxed";
}
function portraitAlt(state: MatchState, character: CharacterDefinition): string {
  const stateName = portraitState(state);
  if (stateName === "trigger") return `${character.name} 被工作人员用左轮抵住太阳穴，神情紧张`;
  if (stateName === "mocking") return `${character.name} 正在嘲讽`;
  if (stateName === "conflicted") return `${character.name} 正在判断牌势`;
  if (stateName === "unconscious") return `${character.name} 双眼上翻，微微后仰`;
  return `${character.name} 放松地看着牌桌`;
}
function present(text: string, tone = "normal", durationMs = 1000): void {
  const node = document.querySelector<HTMLDivElement>("#presentation"); if (!node) return;
  node.textContent = text; node.dataset.tone = tone; node.classList.remove("show"); window.clearTimeout(presentationTimer); window.clearTimeout(presentationHideTimer);
  if (!save.settings.reducedMotion) document.body.classList.add("shake");
  presentationTimer = window.setTimeout(() => { node.classList.add("show"); document.body.classList.remove("shake"); }, save.settings.reducedMotion ? 0 : 40);
  presentationHideTimer = window.setTimeout(() => { node.textContent = node.dataset.default ?? ""; node.dataset.tone = "normal"; node.classList.remove("show"); document.body.classList.remove("shake"); }, durationMs);
}
function startTypewriter(text: string, initialLength = 0): void {
  window.clearInterval(dialogueTimer);
  window.clearTimeout(dialogueShakeTimer);
  const node = root.querySelector<HTMLElement>("#dialogue-text");
  const portrait = root.querySelector<HTMLElement>(".character-strip img");
  if (!node) return;
  const scroller = root.querySelector<HTMLElement>(".dialogue-scroll");
  const followLatest = () => { if (scroller && dialogueAutoFollow) scroller.scrollTop = scroller.scrollHeight; };
  node.textContent = text.slice(0, initialLength);
  node.dataset.typing = save.settings.reducedMotion ? "false" : "true";
  if (save.settings.reducedMotion) { node.textContent = text; return; }
  if (initialLength === 0) {
    portrait?.classList.add("character-shake");
    dialogueShakeTimer = window.setTimeout(() => portrait?.classList.remove("character-shake"), 360);
  }
  let index = initialLength;
  dialogueTimer = window.setInterval(() => {
    index += 1;
    node.textContent = text.slice(0, index);
    followLatest();
    if (index >= text.length) { window.clearInterval(dialogueTimer); node.dataset.typing = "false"; }
  }, 24);
}
function presentDelta(before: MatchState, after: MatchState): void {
  const events = after.history.slice(before.history.length);
  const triggerWindowOpened = events.some((event) => event.type === "ROUND_RESULT_ACKNOWLEDGED")
    && (after.round.phase === "roulette-reaction" || after.round.phase === "roulette-trigger");
  const triggerPreview = triggerWindowOpened ? previewPendingTrigger(after) : null;
  const abilityNotices = after.scene === "match" && after.view === "table"
    ? [
        ...abilityTriggerNotice(events, currentCharacter.name, after),
        ...(triggerPreview ? pendingTriggerAbilityNotices(triggerPreview, currentCharacter.name) : []),
        ...abilityExpiredNotices(events)
      ]
    : [];
  if (abilityNotices.length > 0) enqueueAbilityNotices(abilityNotices);
  const trigger = events.find((candidate) => candidate.type === "TRIGGER_PULLED");
  if (trigger) present(triggerResultText(trigger), trigger.fired ? "danger" : "gold");
  if (legal(after, { type: "OPEN_SKILL_DRAW" })) offerTutorial("skill-draw-available");
}
function wireActions(container: ParentNode, handler: (action: Action) => void): void { container.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((element) => element.addEventListener("click", () => handler(JSON.parse(element.dataset.action ?? "{}") as Action))); }
function requestDispatch(action: Action): void { dispatch(action); }
function interactionHapticsHandler(event: Event): void {
  const button = event.composedPath().find((entry): entry is HTMLButtonElement => entry instanceof HTMLButtonElement);
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
  presentInteractionHaptic(!document.body.classList.contains("reduced-motion"));
}
function attachInteractionHaptics(): void {
  if (interactionHapticsAttached) return;
  document.addEventListener("click", interactionHapticsHandler, { capture: true });
  interactionHapticsAttached = true;
}
function detachInteractionHaptics(): void {
  if (!interactionHapticsAttached) return;
  document.removeEventListener("click", interactionHapticsHandler, { capture: true });
  interactionHapticsAttached = false;
}

function randomUnit(): number {
  const bytes = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(bytes)[0] / 0x100000000;
  return Math.random();
}

function eligibleGuestIds(): string[] {
  const defeated = new Set(defeatedCharacterIdsByFirstDefeat(save.defeats));
  return CHARACTER_CATALOG
    .filter((character) => isCharacterUnlocked(character, save.defeats) && !defeated.has(character.id))
    .map((character) => character.id);
}

function selectGuestIds(): string[] {
  const available = eligibleGuestIds().map((id) => getCharacterMetadata(id)).filter((character): character is NonNullable<typeof character> => Boolean(character));
  const shuffled = [...available];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(randomUnit() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  const next = shuffled.slice(0, 3).map((character) => character.id);
  if (available.length > 3 && guestSelectionIds.length > 0) {
    const current = new Set(guestSelectionIds);
    if (next.every((id) => current.has(id))) {
      const replacement = shuffled.find((character) => !current.has(character.id));
      if (replacement) next[Math.floor(randomUnit() * next.length)] = replacement.id;
    }
  } else if (next.length > 1 && next.join(",") === guestSelectionIds.join(",")) {
    [next[0], next[1]] = [next[1], next[0]];
  }
  return next;
}

function defeatedCharactersNewestFirst(): (typeof CHARACTER_CATALOG)[number][] {
  return [...defeatedCharacterIdsByFirstDefeat(save.defeats)]
    .reverse()
    .map((id) => getCharacterMetadata(id))
    .filter((character): character is NonNullable<typeof character> => Boolean(character));
}

function wireInviteButtons(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>("[data-invite-character]:not([data-invite-wired])").forEach((button) => {
    button.dataset.inviteWired = "true";
    button.addEventListener("click", () => void openProfile(button.dataset.inviteCharacter ?? ""));
  });
}

function loadMoreDefeatedGuests(): void {
  const list = root.querySelector<HTMLElement>("#defeated-character-list");
  const control = root.querySelector<HTMLButtonElement>("[data-load-more-defeated]");
  if (!list || !control) return;
  const defeatedCharacters = defeatedCharactersNewestFirst();
  const visibleCount = list.querySelectorAll(":scope > .character-card").length;
  const nextCharacters = defeatedCharacters.slice(visibleCount, visibleCount + DEFEATED_GUEST_BATCH_SIZE);
  list.insertAdjacentHTML("beforeend", nextCharacters.map((character) => lobbyModule?.characterCardMarkup(character, true) ?? "").join(""));
  wireInviteButtons(list);
  const remaining = defeatedCharacters.length - visibleCount - nextCharacters.length;
  if (remaining <= 0) {
    defeatedGuestObserver?.disconnect();
    defeatedGuestObserver = null;
    control.remove();
    return;
  }
  control.setAttribute("aria-label", `加载更多已击败宾客，剩余 ${remaining} 名`);
  const count = control.querySelector("small");
  if (count) count.textContent = `剩余 ${remaining} 名`;
}

function wireDefeatedGuestLoader(): void {
  const control = root.querySelector<HTMLButtonElement>("[data-load-more-defeated]");
  if (!control) return;
  control.addEventListener("click", loadMoreDefeatedGuests);
  if (!("IntersectionObserver" in window)) return;
  defeatedGuestObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMoreDefeatedGuests();
  }, { rootMargin: "0px 0px 160px" });
  defeatedGuestObserver.observe(control);
}

let pluginMatchController: AbortController | undefined;

function stopPluginMatch(): void {
  pluginMatchController?.abort();
  pluginMatchController = undefined;
}

async function renderLobby(layer: LobbyLayer = "menu"): Promise<void> {
  stopPluginMatch();
  const token = ++auxiliaryNavigationToken;
  try {
    lobbyModulePromise ??= import("./lobby-screen-module").catch((error) => {
      lobbyModulePromise = undefined;
      throw error;
    });
    lobbyModule = await lobbyModulePromise;
  } catch (error) {
    if (token === auxiliaryNavigationToken) renderError(error);
    return;
  }
  if (token !== auxiliaryNavigationToken || !lobbyModule) return;
  auxiliaryScreenController?.abort();
  auxiliaryScreenController = undefined;
  const previousAuxiliaryScreen = auxiliaryMountedScreen;
  auxiliaryMountedScreen = undefined;
  void previousAuxiliaryScreen?.dispose();
  discardActiveTutorial();
  clearAiSchedule(); window.clearInterval(dialogueTimer); window.clearTimeout(dialogueShakeTimer);
  gameAudio.stopHeartbeat();
  gameAudio.setBgmScene("lobby");
  clearAbilityNoticeQueue();
  detachFullscreenListener();
  lastDialogueKey = null;
  autosave = null;
  lobbyLayer = layer;
  void resourceLoader.enqueue(lobbyResourceUrls(
    CHARACTER_CATALOG.filter((character) => isCharacterUnlocked(character, save.defeats))
  ), "background");
  void resourceLoader.enqueue(skillArchetypeArtUrls(skillArchetypeArt), "deferred");
  defeatedGuestObserver?.disconnect();
  defeatedGuestObserver = null;
  if (layer === "characters") {
    const eligible = new Set(eligibleGuestIds());
    const expectedCount = Math.min(3, eligible.size);
    if (guestSelectionIds.length !== expectedCount || guestSelectionIds.some((id) => !eligible.has(id))) guestSelectionIds = selectGuestIds();
  }
  const guestCharacters = guestSelectionIds.map((id) => getCharacterMetadata(id)).filter((character): character is NonNullable<typeof character> => Boolean(character));
  const defeatedCharacters = defeatedCharactersNewestFirst();
  const visibleDefeatedCharacters = defeatedCharacters.slice(0, DEFEATED_GUEST_BATCH_SIZE);
  const defeatedGuestsRemaining = defeatedCharacters.length - visibleDefeatedCharacters.length;
  root.innerHTML = lobbyModule.renderLobbyMarkup({ save, layer, guests: guestCharacters, defeated: defeatedCharacters, visibleDefeated: visibleDefeatedCharacters, defeatedRemaining: defeatedGuestsRemaining });
  root.querySelector<HTMLButtonElement>("[data-enter-duel]")?.addEventListener("click", () => { guestSelectionIds = []; void renderLobby("characters"); });
  root.querySelector<HTMLButtonElement>("[data-lobby-home]")?.addEventListener("click", () => { void renderLobby("menu"); });
  root.querySelector<HTMLButtonElement>("[data-refresh-guests]")?.addEventListener("click", () => { guestSelectionIds = selectGuestIds(); void renderLobby("characters"); });
  root.querySelectorAll<HTMLButtonElement>("[data-open]:not([data-open=skills])").forEach((button) => button.addEventListener("click", () => document.querySelector<HTMLDialogElement>(`#${button.dataset.open}`)?.showModal()));
  root.querySelector<HTMLButtonElement>("[data-open=skills]")?.addEventListener("click", openSkillManagement);
  root.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
  wireInviteButtons(root);
  wireDefeatedGuestLoader();
  root.querySelector<HTMLButtonElement>("[data-open-history]")?.addEventListener("click", () => { void showHistoryScreen(); });
  root.querySelector<HTMLButtonElement>("[data-exit-launcher]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    void requestGameRuntimeExit().catch((error) => {
      button.disabled = false;
      void alertGameDialog("返回启动器失败", uiError(error, "返回启动器失败。"));
    });
  });
  root.querySelectorAll<HTMLInputElement>("[data-setting]").forEach((input) => input.addEventListener("change", updateSettings));
  root.querySelector<HTMLButtonElement>("[data-export]")?.addEventListener("click", () => void exportSave());
  root.querySelector<HTMLButtonElement>("[data-import]")?.addEventListener("click", () => void requestImport());
  root.querySelector<HTMLInputElement>("#save-file")?.addEventListener("change", importFile);
  root.querySelector<HTMLButtonElement>("[data-export-import]")?.addEventListener("click", () => void exportFailedImport());
  root.querySelector<HTMLButtonElement>("[data-reset]")?.addEventListener("click", () => {
    void confirmResetCurrentData().then((confirmed) => { if (confirmed) return resetCurrentData(); }).catch(renderError);
  });
}

function pluginContext(): PluginRuntimeContext {
  return {
    root,
    audio: { setBgmScene: (scene) => gameAudio.setBgmScene(scene) },
    resources: resourceLoader,
    getSave: () => save,
    navigateToHistory: showHistoryScreen,
    navigateToExtension: showExtensionScreen
  };
}

async function showHistoryScreen(): Promise<void> {
  stopPluginMatch();
  const token = ++auxiliaryNavigationToken;
  try {
    const module = await import("./history-screen");
    if (token !== auxiliaryNavigationToken || !mounted) return;
    auxiliaryScreenController?.abort();
    await auxiliaryMountedScreen?.dispose();
    auxiliaryMountedScreen = undefined;
    const controller = new AbortController();
    auxiliaryScreenController = controller;
    discardActiveTutorial();
    clearAiSchedule();
    window.clearInterval(dialogueTimer);
    window.clearTimeout(dialogueShakeTimer);
    autosave = null;
    gameAudio.setBgmScene("lobby");
    const screen = await module.mountHistoryScreen({
      ...pluginContext(),
      replaceSave: (next) => { save = next; },
      saveLongTerm: (next) => repository.saveLongTerm(next),
      navigateToLobby: () => renderLobby("menu"),
      contributions: runtimeContributions
    }, controller.signal);
    if (token !== auxiliaryNavigationToken || !mounted) {
      controller.abort();
      await screen.dispose();
      return;
    }
    auxiliaryMountedScreen = screen;
  } catch {
    if (token === auxiliaryNavigationToken && mounted) {
      enqueueNotification("历史记录加载失败，请重试。");
    }
  }
}

async function showExtensionScreen(route: string): Promise<void> {
  stopPluginMatch();
  const mount = runtimeContributions.map((contribution) => contribution.routes?.[route]).find(Boolean);
  if (!mount) return;
  const token = ++auxiliaryNavigationToken;
  try {
    auxiliaryScreenController?.abort();
    await auxiliaryMountedScreen?.dispose();
    auxiliaryMountedScreen = undefined;
    const controller = new AbortController();
    auxiliaryScreenController = controller;
    const screen = await mount(pluginContext(), controller.signal);
    if (token !== auxiliaryNavigationToken || !mounted) {
      controller.abort();
      await screen.dispose();
      return;
    }
    auxiliaryMountedScreen = screen;
  } catch {
    if (token === auxiliaryNavigationToken && mounted) enqueueNotification("扩展页面暂时不可用，请重试。");
  }
}

async function resetCurrentData(): Promise<void> {
  await repository.deleteLongTerm();
  save = resetSave();
  autosave = null;
  clearAiSchedule();
  gameAudio.stopHeartbeat();
  document.body.classList.remove("reduced-motion");
  gameAudio.configure(save.settings.soundEnabled); haptics.configure(!save.settings.reducedMotion);
  await repository.saveLongTerm(save);
  await renderLobby(lobbyLayer);
}
function confirmResetCurrentData(): Promise<boolean> { return confirmGameDialog("删除长期存档", RESET_CONFIRM_MESSAGE, "删除"); }

async function openProfile(id: string): Promise<void> {
  const metadata = getCharacterMetadata(id);
  if (!metadata) return;
  try {
    const character = await loadCharacter(metadata.id);
    selectedCharacterId = character.id;
    const content = root.querySelector<HTMLDivElement>("#profile-content");
    if (content) {
      const abilities = character.aiSkills
        .filter((binding) => binding.enabled)
        .map((binding) => getAbilityDefinition(binding.definitionId))
        .filter((definition): definition is NonNullable<ReturnType<typeof getAbilityDefinition>> => Boolean(definition));
      const abilityMarkup = abilities.length === 0 ? "" : `<section class="profile-abilities" aria-label="角色技能"><h3>技能</h3>${abilities.map((ability) => `<details class="profile-ability"><summary><strong>${escapeHtml(ability.name)}</strong><span>：${escapeHtml(ability.description)}</span></summary><p>${escapeHtml(ability.profileLore ?? ability.description)}</p></details>`).join("")}</section>`;
      const defeated = defeatedCharacterIdsByFirstDefeat(save.defeats).includes(character.id);
      const unlocked = isCharacterUnlocked(character, save.defeats);
      const actionMarkup = defeated
        ? `<p class="status-line">她曾在这里落败，仍可再次邀请。</p><button class="primary-button profile-start" data-profile-start="${escapeHtml(character.id)}">开始对局 <span>→</span></button>`
        : unlocked
          ? `<button class="primary-button profile-start" data-profile-start="${escapeHtml(character.id)}">开始对局 <span>→</span></button>`
          : `<p class="status-line">尚未解锁：${escapeHtml(unlockConditionLabel(character.unlock))}</p>`;
      content.innerHTML = `<img src="${escapeHtml(character.previewImage)}" alt="${escapeHtml(character.name)}" loading="lazy" decoding="async" /><p class="eyebrow">角色档案 // ${escapeHtml(character.tier)}级</p><h2>${escapeHtml(character.name)}</h2>${abilityMarkup}<p class="profile-description">${escapeHtml(character.profile.description)}</p>${actionMarkup}`;
    }
    content?.querySelector<HTMLButtonElement>("[data-profile-start]")?.addEventListener("click", () => { document.querySelector<HTMLDialogElement>("#profile")?.close(); void startMatch(character.id); });
    document.querySelector<HTMLDialogElement>("#profile")?.showModal();
  } catch (error) { renderError(error); }
}
function unlockConditionLabel(condition: CharacterUnlockCondition | undefined): string {
  if (!condition) return "完成条件后";
  if (condition.type === "defeat-any") return "击败任意角色";
  if (condition.type === "defeat-count") return `击败 ${condition.count} 名不同与会者`;
  const tagLabel = (tag: string): string => {
    const tier = /^tier:(d|c|b|a|s|ss)$/.exec(tag)?.[1];
    return tier ? `${tier.toUpperCase()}级` : `带有「${tag}」标签的`;
  };
  if (condition.type === "defeat-any-tag") return `击败一名${tagLabel(condition.tag)}角色`;
  if (condition.type === "defeat-character") return `击败指定角色 ${getCharacterMetadata(condition.characterId)?.name ?? condition.characterId}`;
  return `击败${tagLabel(condition.tag)}角色的 ${condition.percentage}%`;
}
async function updateSettings(event: Event): Promise<void> { const input = event.target as HTMLInputElement; const setting = input.dataset.setting === "reducedMotion" ? "reducedMotion" : "soundEnabled"; save = { ...save, settings: { ...save.settings, [setting]: input.checked }, updatedAt: new Date().toISOString() }; document.body.classList.toggle("reduced-motion", save.settings.reducedMotion); haptics.configure(!save.settings.reducedMotion); if (setting === "soundEnabled") { gameAudio.unlock(); gameAudio.configure(input.checked); } const status = root.querySelector<HTMLParagraphElement>("#lobby-status"); if (status) status.textContent = "设置已保存。"; await repository.saveLongTerm(save); }
function latestDefeatedCharacterId(currentSave: LongTermSave): string {
  return currentSave.defeats.reduce<CharacterDefeatRecord | undefined>((latest, record) => !latest || Date.parse(record.timestamp) > Date.parse(latest.timestamp) ? record : latest, undefined)?.opponentId
    ?? DEFAULT_CHARACTER_ID;
}
async function saveCoverImage(currentSave: LongTermSave): Promise<string> {
  const ids = [...new Set([latestDefeatedCharacterId(currentSave), DEFAULT_CHARACTER_ID])];
  const baseCandidates = [...ids.map((id) => getCharacterMetadata(id)?.previewImage).filter((url): url is string => Boolean(url)), "/assets/package-cover-fallback.png"];
  return selectSaveCoverImage({
    loadFeatureCandidates: async () => (await Promise.all(runtimeContributions.map((contribution) => contribution.saveCoverCandidates?.(currentSave) ?? []))).flat(),
    baseCandidates,
    isAvailable: async (url) => Boolean((await resourceLoader.enqueue([url], "visible"))[0])
  });
}
function exportStatus(method: "file-system-access" | "blob-download" | "native-share"): string {
  if (method === "file-system-access") return "存档已写入。";
  if (method === "native-share") return "已打开系统分享面板。";
  return "已开始下载存档。";
}
async function exportSave(): Promise<void> {
  const status = root.querySelector<HTMLParagraphElement>("#lobby-status");
  try {
    const currentSave = autosave?.getSave() ?? save;
    const format = root.querySelector<HTMLSelectElement>("[data-export-format]")?.value ?? "image";
    const method = format === "json"
      ? await downloadSaveJson(currentSave)
      : await downloadSaveImage(currentSave, await saveCoverImage(currentSave));
    if (status) status.textContent = exportStatus(method);
  } catch (error) { if (status) status.textContent = uiError(error, "导出失败。"); }
}
async function applyImportedSave(next: LongTermSave): Promise<void> { await repository.saveLongTerm(next); save = next; document.body.classList.toggle("reduced-motion", save.settings.reducedMotion); gameAudio.configure(save.settings.soundEnabled); haptics.configure(!save.settings.reducedMotion); pendingImportedSave = undefined; await renderLobby(lobbyLayer); }
function showUnsupportedImportPrompt(error: SaveValidationError): void {
  pendingImportedSave = error.input;
  const dialog = root.querySelector<HTMLDialogElement>("#save-import-error");
  const copy = dialog?.querySelector<HTMLParagraphElement>("#save-import-error-copy");
  const status = root.querySelector<HTMLParagraphElement>("#lobby-status");
  if (copy) copy.textContent = "这份文件无法识别或不符合支持的存档格式，无法转换。原件仍可导出留底，当前存档未被修改。";
  if (status) status.textContent = "导入失败：请导出原件留底或暂不处理。";
  dialog?.showModal();
}
function handleImportFailure(error: unknown): void {
  if (error instanceof SaveValidationError && error.kind === "long-term") { showUnsupportedImportPrompt(error); return; }
  const status = root.querySelector<HTMLParagraphElement>("#lobby-status");
  if (status) status.textContent = uiError(error, "导入失败。");
}
async function exportFailedImport(): Promise<void> {
  const status = root.querySelector<HTMLElement>("[data-import-error-status]");
  try {
    const method = await downloadRawSave(pendingImportedSave);
    if (status) status.textContent = exportStatus(method);
  } catch (error) { if (status) status.textContent = uiError(error, "原始存档导出失败。"); }
}
function importFile(event: Event): void { const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return; void importSave(file).then(applyImportedSave).catch(handleImportFailure).finally(() => { input.value = ""; }); }
function requestImport(): void { root.querySelector<HTMLInputElement>("#save-file")?.click(); }
async function startMatch(characterId = selectedCharacterId): Promise<void> {
  tableModulePromise ??= import("./table-screen-module");
  await tableModulePromise;
  if (characterLoadInFlight) return;
  skillDrawerOpen = false;
  clearAbilityNoticeQueue();
  detachFullscreenListener();
  gameAudio.setBgmScene("match");
  gameAudio.unlock();
  gameAudio.preloadMatch();
  gameAudio.play("shuffle");
  const requestToken = ++characterLoadToken;
  characterLoadInFlight = true;
  root.querySelectorAll<HTMLButtonElement>("[data-invite-character], [data-profile-start]").forEach((button) => { button.disabled = true; });
  try {
    const metadata = getCharacterMetadata(characterId);
    if (!metadata) throw new Error("所选对手不可用。");
    const defeated = defeatedCharacterIdsByFirstDefeat(save.defeats).includes(metadata.id);
    if (!defeated && !isCharacterUnlocked(metadata, save.defeats)) throw new Error("该角色尚未解锁。");
    const character = await loadCharacter(metadata.id);
    if (requestToken !== characterLoadToken) return;
    root.innerHTML = `<main class="loading-shell"><span class="mark">✦</span><p>正在布置牌桌……</p></main>`;
    currentCharacter = character;
    selectedCharacterId = character.id;
    lastAction = null;
    lastDomainEvent = null;
    const match = createMatch(secureSeed(), {
      opponentId: character.id,
      aiProfile: character.ai,
      unlockedPlayerSkillIds: unlockedPlayerSkillIdsForDefeats(save.defeats),
      selectedSkillTags: save.profile.selectedSkillTags,
      talentIds: unlockedTalentIdsForDefeats(save.defeats),
      opponentAiSkills: character.aiSkills
    });
    await resumeMatch(match, character);
    enqueueAbilityNotices(abilityTriggerNotice(match.history, character.name, match));
    presentOpeningMatchAudio(gameAudio, match);
  } catch (error) {
    if (error instanceof Error && /尚未解锁|已经败北/.test(error.message)) {
      const status = root.querySelector<HTMLParagraphElement>("#lobby-status");
      if (status) status.textContent = error.message;
    } else renderError(error);
  } finally { if (requestToken === characterLoadToken) characterLoadInFlight = false; }
}
function initiallyVisibleCharacterArt(character: CharacterDefinition, state: MatchState): string {
  if (state.view !== "match-summary") return tablePortrait(state, character);
  if (state.outcome?.winner === "player") return character.assets.defeatedSummary ?? character.assets.unconscious;
  if (state.outcome?.reason === "escaped") return character.assets.conflicted;
  return character.assets.relaxed;
}
async function prepareMatchResources(character: CharacterDefinition, state: MatchState): Promise<void> {
  const plan = characterResourcePlan(character, {
    visibleArt: [initiallyVisibleCharacterArt(character, state)],
    includeTableBase: state.view === "table"
  });
  const visible = resourceLoader.enqueue(plan.visible, "visible");
  void resourceLoader.enqueue(plan.display, "display");
  void resourceLoader.enqueue(plan.background, "background");
  await visible;
}
async function resumeMatch(match: MatchState, loadedCharacter?: CharacterDefinition): Promise<void> {
  stopPluginMatch();
  pluginMatchController = new AbortController();
  tableModulePromise ??= import("./table-screen-module");
  await tableModulePromise;
  clearAiSchedule();
  gameAudio.setBgmScene("match");
  currentCharacter = loadedCharacter ?? await loadCharacter(match.opponentId);
  gameAudio.preloadMatch();
  await prepareMatchResources(currentCharacter, match);
  selectedCharacterId = currentCharacter.id;
  autosave = createAutosaveController(repository, save, match);
  const state = autosave.getState();
  if (state.view === "match-summary") renderSummary(state);
  else {
    renderMatch(state);
    const triggerPreview = state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger"
      ? previewPendingTrigger(state)
      : null;
    if (triggerPreview) enqueueAbilityNotices(pendingTriggerAbilityNotices(triggerPreview, currentCharacter.name));
    syncMatchAudioState(gameAudio, state);
    if (legal(state, { type: "OPEN_SKILL_DRAW" })) offerTutorial("skill-draw-available");
    scheduleAiTurn(state);
  }
}
function presentPluginMatchEvents(before: MatchState, after: MatchState): void {
  const signal = pluginMatchController?.signal;
  if (!signal || signal.aborted) return;
  const context = { opponentId: after.opponentId, events: after.history.slice(before.history.length) };
  for (const contribution of runtimeContributions) {
    try {
      void Promise.resolve(contribution.presentMatchEvents?.(context, signal)).catch((error) => console.error("插件牌局表现失败", error));
    } catch (error) { console.error("插件牌局表现失败", error); }
  }
}

function dispatch(action: Action): void { if (!autosave) return; const before = autosave.getState(); const after = autosave.dispatch(action); if (after === before) return; lastAction = action; lastDomainEvent = after.history.at(-1)?.type ?? null; if (after.scene === "match" && after.view === "match-summary") renderSummary(after); else if (after.scene === "match") renderMatch(after); presentDelta(before, after); presentMatchAudio(gameAudio, before, after); presentPluginMatchEvents(before, after); presentMatchHaptics(before, after, !save.settings.reducedMotion); scheduleAiTurn(after); }

/** revolverPlacement 的基准立绘实体高度：数值表示立绘实体高 149.333px 时的 CSS 像素。 */
const REVOLVER_REFERENCE_ART_HEIGHT = 149.333;
/** 把参考值换算成占立绘高度的纯数字比例：CSS 只允许「长度 × 数字」，不能「长度 × 长度」。 */
function revolverPlacementRatios(placement: { readonly top: number; readonly left: number }): { readonly top: number; readonly left: number } {
  const round = (value: number): number => Math.round(value * 1e5) / 1e5;
  return { top: round(placement.top / REVOLVER_REFERENCE_ART_HEIGHT), left: round(placement.left / REVOLVER_REFERENCE_ART_HEIGHT) };
}
function revolverPlacementStyle(placement: { readonly top: number; readonly left: number }): string {
  const ratios = revolverPlacementRatios(placement);
  return `--revolver-top-ratio:${ratios.top};--revolver-left-ratio:${ratios.left};`;
}

/* ---------------------------------------------------------------------------
 * dev-only 左轮标定器：仅 `npm run dev` 生效（生产构建里 import.meta.env.DEV
 * 为 false，整段会被摇树移除）。进入“准备扣扳机”阶段后按方向键移动左轮，
 * 面板实时显示可直接回写 revolverPlacement 的数值，按 C 复制结果。
 * ------------------------------------------------------------------------- */
const DEV_REVOLVER_KEY = "blackjack-dev-revolver-offsets";
const DEV_CALIBRATION_HASH = "#revolver-calibration";
interface DevRevolverOffset { readonly top: number; readonly left: number }
interface DevRevolverEntry extends DevRevolverOffset { readonly baseTop: number; readonly baseLeft: number }
let devRevolverOffsets: Record<string, DevRevolverEntry> = import.meta.env.DEV ? readDevRevolverOffsets() : {};
let devRevolverKeysAttached = false;
let devRevolverKeyHandler: ((event: KeyboardEvent) => void) | undefined;

function readDevRevolverOffsets(): Record<string, DevRevolverEntry> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DEV_REVOLVER_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, DevRevolverEntry> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { top?: unknown; left?: unknown; baseTop?: unknown; baseLeft?: unknown } | null;
      if (entry && typeof entry.top === "number" && typeof entry.left === "number" && typeof entry.baseTop === "number" && typeof entry.baseLeft === "number") {
        result[id] = { top: entry.top, left: entry.left, baseTop: entry.baseTop, baseLeft: entry.baseLeft };
      }
    }
    return result;
  } catch { return {}; }
}
/** 偏移只在基准值未变时有效：JSON 一旦更新（base + offset 已落盘），旧偏移自动作废，避免重复叠加。 */
function devRevolverOffset(character: CharacterDefinition): DevRevolverOffset {
  const entry = devRevolverOffsets[character.id];
  if (!entry || entry.baseTop !== character.revolverPlacement.top || entry.baseLeft !== character.revolverPlacement.left) return { top: 0, left: 0 };
  return { top: entry.top, left: entry.left };
}
function saveDevRevolverOffsets(): void { try { window.localStorage.setItem(DEV_REVOLVER_KEY, JSON.stringify(devRevolverOffsets)); } catch { /* 隐私模式或配额不足时忽略 */ } }
function devPlacement(character: CharacterDefinition): DevRevolverOffset {
  if (!import.meta.env.DEV) return character.revolverPlacement;
  const offset = devRevolverOffset(character);
  return { top: character.revolverPlacement.top + offset.top, left: character.revolverPlacement.left + offset.left };
}
function nudgeDevRevolver(character: CharacterDefinition, top: number, left: number): void {
  const current = devRevolverOffset(character);
  const round = (value: number): number => Math.round(value * 10) / 10;
  devRevolverOffsets = {
    ...devRevolverOffsets,
    [character.id]: {
      top: round(current.top + top),
      left: round(current.left + left),
      baseTop: character.revolverPlacement.top,
      baseLeft: character.revolverPlacement.left
    }
  };
  saveDevRevolverOffsets();
}
function resetDevRevolver(id: string): void {
  const next: Record<string, DevRevolverEntry> = { ...devRevolverOffsets };
  delete next[id];
  devRevolverOffsets = next;
  saveDevRevolverOffsets();
}
function devRevolverReport(character: CharacterDefinition): string {
  const placement = devPlacement(character);
  const lines = [`// dev 左轮标定：${character.name}(${character.id})`, `"revolverPlacement": { "top": ${placement.top}, "left": ${placement.left} },`, devRevolverArtReference(character), "", "// 各角色偏移（相对当前 JSON 基准值）"];
  for (const [id, offset] of Object.entries(devRevolverOffsets)) lines.push(`${id}: top ${offset.top >= 0 ? "+" : ""}${offset.top}, left ${offset.left >= 0 ? "+" : ""}${offset.left}（基准 ${offset.baseTop}/${offset.baseLeft}）`);
  return lines.join("\n");
}
function devRevolverArtReference(character: CharacterDefinition): string {
  const portrait = root.querySelector<HTMLImageElement>("img.character-portrait");
  if (!portrait || !portrait.naturalWidth) return "";
  const scale = Math.min(portrait.offsetWidth / portrait.naturalWidth, portrait.offsetHeight / portrait.naturalHeight);
  const artHeight = portrait.naturalHeight * scale;
  if (!(artHeight > 0)) return "";
  const placement = devPlacement(character);
  const factor = artHeight / REVOLVER_REFERENCE_ART_HEIGHT;
  const round = (value: number): number => Math.round(value * 10) / 10;
  return `立绘实体 ${Math.round(portrait.naturalWidth * scale)}×${Math.round(artHeight)}px · 实际偏移 top ${round(placement.top * factor)} / left ${round(placement.left * factor)}px · 写入 JSON 的参考值 top ${placement.top} / left ${placement.left}`;
}
function applyDevRevolver(character: CharacterDefinition, prop: HTMLImageElement): void {
  const placement = devPlacement(character);
  const ratios = revolverPlacementRatios(placement);
  prop.style.setProperty("--revolver-top-ratio", String(ratios.top));
  prop.style.setProperty("--revolver-left-ratio", String(ratios.left));
  const offset = devRevolverOffset(character);
  const readout = root.querySelector<HTMLElement>("[data-dev-revolver-readout]");
  if (readout) readout.textContent = `top ${placement.top} / left ${placement.left}（基准 ${character.revolverPlacement.top}/${character.revolverPlacement.left}，偏移 ${offset.top}/${offset.left}）`;
  const artNote = root.querySelector<HTMLElement>("[data-dev-revolver-art]");
  if (artNote) artNote.textContent = devRevolverArtReference(character);
}
function attachDevRevolverTool(character: CharacterDefinition): void {
  if (!import.meta.env.DEV) return;
  if (!devRevolverKeysAttached) {
    devRevolverKeysAttached = true;
    devRevolverKeyHandler = (event) => {
      if (!import.meta.env.DEV) return;
      const prop = root.querySelector<HTMLImageElement>("img.trigger-prop");
      if (!prop) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const step = event.shiftKey ? 5 : 1;
      const delta = event.key === "ArrowUp" ? { top: -step, left: 0 }
        : event.key === "ArrowDown" ? { top: step, left: 0 }
          : event.key === "ArrowLeft" ? { top: 0, left: -step }
            : event.key === "ArrowRight" ? { top: 0, left: step }
              : null;
      if (delta) {
        event.preventDefault();
        nudgeDevRevolver(currentCharacter, delta.top, delta.left);
        applyDevRevolver(currentCharacter, prop);
        return;
      }
      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        resetDevRevolver(currentCharacter.id);
        applyDevRevolver(currentCharacter, prop);
        return;
      }
      if (event.key === "c" || event.key === "C") void navigator.clipboard?.writeText(devRevolverReport(currentCharacter));
    };
    window.addEventListener("keydown", devRevolverKeyHandler);
  }
  const prop = root.querySelector<HTMLImageElement>("img.trigger-prop");
  const main = root.querySelector("main");
  if (!prop || !main) return;
  const panel = document.createElement("aside");
  panel.id = "dev-revolver";
  panel.style.cssText = "position:fixed;top:8px;left:8px;z-index:9999;display:grid;gap:6px;padding:8px 10px;border:1px solid #65d6e3;border-radius:10px;background:#0b1622f2;color:#d8f4f8;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:min(94vw,460px);pointer-events:none";
  panel.innerHTML = `<strong>左轮标定（dev）</strong><span data-dev-revolver-readout></span><span data-dev-revolver-art style="opacity:.85"></span><span style="opacity:.75">方向键 1px · Shift+方向 5px · R 重置本角色 · C 复制结果</span><button type="button" data-dev-revolver-copy style="justify-self:start;pointer-events:auto">复制当前数值</button>`;
  panel.querySelector<HTMLButtonElement>("[data-dev-revolver-copy]")?.addEventListener("click", () => { void navigator.clipboard?.writeText(devRevolverReport(character)); });
  main.append(panel);
  applyDevRevolver(character, prop);
}

/* dev-only 标定页：`npm run dev` 下访问 `#revolver-calibration`（或 `#revolver-calibration/<id>`）
   即可复用真实牌桌 DOM/CSS 逐个校准左轮落点，无需先打到对手受罚阶段。 */
function devCalibrationCharacterId(): string | null {
  if (!import.meta.env.DEV) return null;
  const hash = window.location.hash;
  if (!hash.startsWith(DEV_CALIBRATION_HASH)) return null;
  const id = hash.slice(DEV_CALIBRATION_HASH.length).replace(/^\/+/, "");
  return getCharacterMetadata(id) ? id : DEFAULT_CHARACTER_ID;
}
async function renderDevRevolverCalibration(): Promise<void> {
  const id = devCalibrationCharacterId();
  if (!id) return;
  const character = await loadCharacter(id);
  currentCharacter = character;
  const placement = devPlacement(character);
  const options = CHARACTER_CATALOG.map((meta) => `<option value="${escapeHtml(meta.id)}"${meta.id === id ? " selected" : ""}>${escapeHtml(meta.name)}</option>`).join("");
  root.innerHTML = `<main class="table-shell" data-phase="roulette-trigger"><header class="table-top"><div><span class="eyebrow">标定模式 // dev</span><h1>左轮标定</h1></div><div class="table-actions"><label class="eyebrow">与会者 <select data-dev-calibration-select>${options}</select></label></div></header><section class="opponent-zone"><div class="character-strip"><img class="character-portrait scaled-character-art portrait-trigger" style="--character-art-scale:${character.portraitScales.table}" src="${character.assets.threatened}" alt="${escapeHtml(character.name)} 紧张态立绘" /><img class="trigger-prop" style="${revolverPlacementStyle(placement)}--art-scale:${character.portraitScales.table}" src="${STAFF_REVOLVER_URL}" alt="工作人员用 7mm 左轮对准 ${escapeHtml(character.name)} 的太阳穴" /><div><span class="eyebrow">${escapeHtml(character.name)}</span><p class="dialogue">方向键把枪口对到太阳穴，下拉切换与会者</p></div></div></section></main>`;
  root.querySelector<HTMLSelectElement>("[data-dev-calibration-select]")?.addEventListener("change", (event) => {
    const next = (event.target as HTMLSelectElement).value;
    window.history.replaceState(null, "", `${DEV_CALIBRATION_HASH}/${next}`);
    void renderDevRevolverCalibration();
  });
  attachDevRevolverTool(character);
}

function renderMatch(state: MatchState): void {
  const character = currentCharacter;
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
    if (!skill) return "";
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
  } else if (state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger") {
    controls = actionButton(state.round.outcome?.penaltyTarget === "opponent" ? "静观好戏" : "扣下扳机", { type: "TRIGGER_ROULETTE" }, state, "primary-button");
  } else if (state.round.phase === "roulette-result") {
    controls = actionButton(state.status === "finished" ? "查看结局" : "下一轮", { type: "ACK_TRIGGER_RESULT" }, state, "primary-button");
  } else if (state.round.phase === "round-end") {
    controls = actionButton("下一轮", { type: "CONTINUE_ROUND" }, state, "primary-button");
  } else if (state.round.currentActor === "opponent") {
    controls = `<div class="ai-wait" id="ai-wait" role="status" aria-live="polite" data-step="watching">${character.name} 正在观察牌面……</div>`;
  } else {
    const drawAction = { type: "OPEN_SKILL_DRAW" as const };
    controls = `<div class="table-action-controls">${actionButton("Hit 要牌", { type: "PLAYER_HIT" }, state, "primary-button")}${actionButton("Stand 停牌", { type: "PLAYER_STAND" }, state)}<button type="button" class="draw-skill-button" data-action='${JSON.stringify(drawAction)}' ${legal(state, drawAction) ? "" : "disabled"} aria-label="抽取技能，剩余 ${state.playerSkills.drawCount} 次"><span class="draw-skill-icon" aria-hidden="true"><i></i><i></i><i></i></span><span class="draw-skill-badge" aria-hidden="true">${state.playerSkills.drawCount}</span></button></div>`;
  }
  const dialogue = currentDialogue(state);
  const key = dialogueKey(state);
  const shouldType = key !== lastDialogueKey;
  const previousDialogue = root.querySelector<HTMLElement>("#dialogue-text");
  const previousScrollTop = root.querySelector<HTMLElement>(".dialogue-scroll")?.scrollTop ?? 0;
  const resumeTyping = !shouldType && previousDialogue?.dataset.typing === "true";
  const initialLength = resumeTyping ? previousDialogue.textContent?.length ?? 0 : 0;
  const dialogueMarkup = shouldType ? "" : escapeHtml(resumeTyping ? dialogue.slice(0, initialLength) : dialogue);
  window.clearInterval(dialogueTimer);
  if (shouldType) dialogueAutoFollow = true;
  const revolverPlacement = character.revolverPlacement;
  const staffProp = state.round.phase === "roulette-trigger" && state.round.outcome?.penaltyTarget === "opponent"
    ? `<img class="trigger-prop" style="${revolverPlacementStyle(revolverPlacement)}--art-scale:${character.portraitScales.table}" src="${STAFF_REVOLVER_URL}" alt="工作人员用 7mm 左轮对准 ${character.name} 的太阳穴" />` : "";
  const penaltyPreview = state.round.phase === "round-reveal" ? previewPendingTrigger(state) : null;
  const notice = state.round.phase === "round-reveal" ? roundResultText(state, character.name, penaltyPreview?.cancelled ?? false) : "";
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
  const previousDisplayPanel = root.querySelector<HTMLElement>(".display-panel");
  const sameDisplayMatch = previousDisplayPanel?.dataset.matchSeed === state.seed;
  const displayPanel = displayPanelMarkup(displays, sameDisplayMatch && previousDisplayPanel.classList.contains("is-expanded"));
  const displayScrollTop = sameDisplayMatch ? previousDisplayPanel.querySelector(".display-scroll")?.scrollTop ?? 0 : 0;
  const skillDrawerMarkup = `<aside class="skill-sidebar ${skillDrawerOpen ? "is-open" : ""}" aria-label="技能抽屉"><button class="skill-drawer-toggle" type="button" aria-expanded="${skillDrawerOpen}" aria-label="${skillDrawerOpen ? "收起" : "展开"}技能抽屉，共 ${totalSkills} 张"><span class="skill-drawer-arrow" aria-hidden="true">${skillDrawerOpen ? ">" : "<"}</span><span class="skill-drawer-badge"${skillDrawerOpen ? " hidden" : ""}>${totalSkills}</span></button><div class="skill-drawer-content">${skills || "<span class='empty-skills'>暂无技能卡</span>"}</div></aside>`;
  const drawOffer = state.playerSkills.drawOffer;
  const drawCards = drawOffer?.candidateDefinitionIds.map((id) => {
    const skill = getPlayerSkillDefinition(id);
    if (!skill) return "";
    const action = { type: "SELECT_SKILL_DRAW" as const, definitionId: id };
    return `<span class="skill-draw-tile"><button type="button" class="skill-draw-card" data-action='${JSON.stringify(action)}'><span>${skill.category === "active" ? "主动" : "被动"}</span><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(SKILL_TAG_METADATA[skill.primaryDomain].label)}</small></button><button class="skill-info draw-skill-info" type="button" data-skill-info="${escapeHtml(skill.id)}" aria-label="查看${escapeHtml(skill.name)}说明">i</button></span>`;
  }).join("") ?? "";
  const drawMarkup = drawOffer ? `<section class="skill-draw-backdrop is-entering"><div class="skill-draw-modal" role="dialog" aria-modal="true" aria-labelledby="skill-draw-title"><h2 id="skill-draw-title">选一张你心仪的技能卡</h2><div class="skill-draw-grid">${drawCards}</div></div></section>` : "";
  root.innerHTML = `<main class="table-shell table-playing" data-phase="${state.round.phase}"><header class="table-top"><div><span class="eyebrow">第 ${state.roundIndex + 1} 轮 // ${phaseLabel(state.round.phase)}</span><h1>命运牌桌</h1></div><div class="table-actions"><div class="table-action-row"><button class="icon-button fullscreen-button" type="button" data-fullscreen aria-label="进入全屏">⛶</button><button class="icon-button" data-action='${JSON.stringify({ type: "ESCAPE_MATCH" })}' ${legal(state, { type: "ESCAPE_MATCH" }) ? "" : "disabled"} aria-label="离开牌桌">×</button></div>${gunStatuses}${shoeStatus}${displayPanel}</div></header><section class="opponent-zone"><div class="character-strip"><img class="character-portrait scaled-character-art portrait-${portraitState(state)}" style="--character-art-scale:${character.portraitScales.table}" src="${tablePortrait(state, character)}" alt="${portraitAlt(state, character)}" />${staffProp}<div><span class="eyebrow">${character.name} // ${character.tier}级</span><div class="dialogue"><div class="dialogue-scroll" tabindex="0" role="region" aria-label="角色台词">“<span id="dialogue-text" data-typing="false">${dialogueMarkup}</span>”</div></div></div></div></section><section class="table-bottom" aria-label="牌局操作区"><div class="opponent-hand hand-row"><span class="hand-label">${character.name} ${displayedHandValueMarkup(opponentBaseScore, opponentScoreModifier)}</span><div class="cards">${opponentCards}</div></div><div class="table-notice-row"><output class="bust-limit-indicator" aria-label="当前爆牌上限：${bustLimit}" data-actor="${bustLimitActor}"><span>爆牌上限</span><strong>${bustLimit}</strong></output><section class="round-notice"><div id="presentation" class="presentation" data-default="${escapeHtml(notice)}" role="status" aria-live="polite">${escapeHtml(notice)}</div></section></div><section class="player-zone"><div class="player-layout"><div class="player-main"><div class="hand-row"><span class="hand-label">策展人 ${displayedHandValueMarkup(playerBaseScore, playerScoreModifier)}</span><div class="cards">${playerCards}</div></div>${advice}</div></div><div class="controls action-dock">${controls}</div></section></section><dialog id="skill-info-dialog" class="modal skill-info-modal" aria-labelledby="skill-info-title"><button class="modal-close" type="button" data-skill-close aria-label="关闭技能说明">×</button><p class="eyebrow" id="skill-info-kind"></p><details class="profile-ability"><summary><strong id="skill-info-title"></strong><span>：</span><span id="skill-info-description"></span></summary><p id="skill-info-lore"></p></details><p id="skill-info-usage"></p><p class="status-line" id="skill-info-status"></p></dialog><dialog id="display-info-dialog" class="modal display-info-modal" aria-labelledby="display-info-title"><button class="modal-close" type="button" data-display-close aria-label="关闭持续信息说明">×</button><h2 id="display-info-title"></h2><output id="display-info-current"></output><p id="display-info-description"></p></dialog></main>${devHud(state)}${skillDrawerMarkup}${drawMarkup}`;
  root.querySelector("main")?.insertAdjacentHTML("beforeend", shoeInfoDialog);
  wireActions(root, requestDispatch); root.querySelector<HTMLButtonElement>("[data-copy-debug]")?.addEventListener("click", () => { const text = root.querySelector<HTMLTextAreaElement>("#debug-json")?.value ?? ""; void navigator.clipboard?.writeText(text); });
  root.querySelectorAll<HTMLButtonElement>("[data-skill-blocked]").forEach((button) => button.addEventListener("click", () => enqueueNotification("技能被禁用")));
  attachFullscreenListener(); syncFullscreenButton(); syncAbilityNoticePosition();
  root.querySelector<HTMLButtonElement>("[data-fullscreen]")?.addEventListener("click", toggleFullscreen);
  const skillDrawer = root.querySelector<HTMLElement>(".skill-sidebar");
  const skillDrawerToggle = root.querySelector<HTMLButtonElement>(".skill-drawer-toggle");
  skillDrawerToggle?.addEventListener("click", () => {
    skillDrawerOpen = !skillDrawerOpen;
    skillDrawer?.classList.toggle("is-open", skillDrawerOpen);
    const arrow = skillDrawerToggle.querySelector<HTMLElement>(".skill-drawer-arrow");
    const badge = skillDrawerToggle.querySelector<HTMLElement>(".skill-drawer-badge");
    if (arrow) arrow.textContent = skillDrawerOpen ? ">" : "<";
    if (badge) badge.hidden = skillDrawerOpen;
    skillDrawerToggle.setAttribute("aria-expanded", String(skillDrawerOpen));
    skillDrawerToggle.setAttribute("aria-label", `${skillDrawerOpen ? "收起" : "展开"}技能抽屉，共 ${totalSkills} 张`);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-skill-info]").forEach((button) => button.addEventListener("click", () => {
    const skill = getPlayerSkillDefinition(button.dataset.skillInfo ?? "");
    const dialog = root.querySelector<HTMLDialogElement>("#skill-info-dialog");
    if (!skill || !dialog) return;
    const kind = root.querySelector("#skill-info-kind");
    const title = root.querySelector("#skill-info-title");
    const description = root.querySelector("#skill-info-description");
    const lore = root.querySelector("#skill-info-lore");
    const usage = root.querySelector("#skill-info-usage");
    const status = root.querySelector("#skill-info-status");
    if (kind) kind.textContent = skill.category === "active" ? "主动技能" : "被动技能";
    if (title) title.textContent = skill.name;
    if (description) description.textContent = skill.description;
    if (lore) lore.textContent = skill.profileLore;
    if (usage) usage.textContent = skill.usage;
    if (status) {
      const selectedInstance = state.abilities.instances.find((instance) => instance.instanceId === button.dataset.skillInfoInstance)
        ?? state.abilities.instances.find((instance) => instance.definitionId === skill.id && instance.owner === "player");
      const instanceTtl = selectedInstance?.ttl;
      const ttl = instanceTtl ?? (skill.ttl ? { type: skill.ttl.type, remaining: skill.ttl.amount } : undefined);
      const ttlText = ttl ? ttl.type === "triggers" ? `，剩余 ${ttl.remaining} 次触发` : `，剩余 ${ttl.remaining} 轮` : "";
      const remainingUses = selectedInstance?.remainingUses ?? skill.uses;
      status.textContent = skill.category === "active"
        ? skill.uses > 1 ? `主动技能牌：剩余 ${remainingUses} 次发动；归零后消耗此实例` : "主动技能牌：使用后消耗此实例"
        : `被动技能牌：占用牌库位置并持续生效${ttlText}`;
    }
    const details = dialog.querySelector<HTMLDetailsElement>(".profile-ability");
    if (details) details.open = false;
    dialog.showModal();
  }));
  root.querySelector<HTMLButtonElement>("[data-skill-close]")?.addEventListener("click", () => root.querySelector<HTMLDialogElement>("#skill-info-dialog")?.close());
  root.querySelector<HTMLButtonElement>("[data-shoe-info]")?.addEventListener("click", () => root.querySelector<HTMLDialogElement>("#shoe-info-dialog")?.showModal());
  root.querySelector<HTMLButtonElement>("[data-shoe-info-close]")?.addEventListener("click", () => root.querySelector<HTMLDialogElement>("#shoe-info-dialog")?.close());
  const nextDisplayPanel = root.querySelector<HTMLElement>(".display-panel");
  if (nextDisplayPanel) {
    nextDisplayPanel.dataset.matchSeed = state.seed;

    const scroller = nextDisplayPanel.querySelector<HTMLElement>(".display-scroll");
    if (scroller) {
      scroller.scrollTop = displayScrollTop;
      nextDisplayPanel.style.setProperty("--display-expanded-height", `${scroller.offsetHeight}px`);
    }
    const toggle = nextDisplayPanel.querySelector<HTMLButtonElement>("[data-display-toggle]");
    toggle?.addEventListener("click", () => {
      const expanded = nextDisplayPanel.classList.toggle("is-expanded");
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", expanded ? "收起额外状态栏" : `展开另外 ${displays.length - 3} 项状态栏`);
      toggle.querySelector(".display-toggle-arrow")!.textContent = expanded ? "⌃" : "⌄";
      if (scroller) {
        if (!expanded) scroller.scrollTop = 0;
        nextDisplayPanel.style.setProperty("--display-expanded-height", `${scroller.offsetHeight}px`);
      }
      syncAbilityNoticePosition();
    });
    syncAbilityNoticePosition();
  }
  root.querySelectorAll<HTMLButtonElement>("[data-display-key]").forEach((button) => button.addEventListener("click", () => {
    const display = displays.find((entry) => entry.key === button.dataset.displayKey);
    const dialog = root.querySelector<HTMLDialogElement>("#display-info-dialog");
    if (!display || !dialog) return;
    dialog.querySelector("#display-info-title")!.textContent = display.name;
    const current = dialog.querySelector("#display-info-current")!;
    current.innerHTML = displayContentMarkup(display);
    current.setAttribute("aria-label", displayText(display));
    dialog.querySelector("#display-info-description")!.textContent = display.description;
    dialog.showModal();
  }));
  root.querySelector<HTMLButtonElement>("[data-display-close]")?.addEventListener("click", () => root.querySelector<HTMLDialogElement>("#display-info-dialog")?.close());
  const dialogueScroll = root.querySelector<HTMLElement>(".dialogue-scroll");
  if (dialogueScroll) {
    dialogueScroll.scrollTop = shouldType ? 0 : resumeTyping && dialogueAutoFollow ? dialogueScroll.scrollHeight : previousScrollTop;
    dialogueScroll.addEventListener("scroll", () => {
      if (!dialogueScroll.isConnected) return;
      dialogueAutoFollow = dialogueScroll.scrollHeight - dialogueScroll.clientHeight - dialogueScroll.scrollTop <= 4;
    });
  }
  if (shouldType || resumeTyping) {
    lastDialogueKey = key;
    startTypewriter(dialogue, initialLength);
  }
}
function devHud(state: MatchState): string {
  if (!new URLSearchParams(window.location.search).has("debug")) return "";
  const ai = state.lastAiDecision;
  const text = JSON.stringify({ gameVersion: save.gameVersion, seed: state.seed, round: state.roundIndex, phase: state.round.phase, currentActor: state.round.currentActor, relevantMatchState: state, recentActionsOrEvents: state.history.slice(-8), lastAction, lastDomainEvent, aiDecision: ai }, null, 2);
  const profile = state.aiProfile;
  return `<details class="dev-hud" open><summary>开发者面板</summary><dl><dt>种子</dt><dd>${state.seed}</dd><dt>轮次 / 阶段</dt><dd>${state.roundIndex} / ${phaseLabel(state.round.phase)}</dd><dt>当前行动者</dt><dd>${state.round.currentActor === "player" ? "玩家" : state.round.currentActor === "opponent" ? currentCharacter.name : "—"}</dd><dt>牌库剩余</dt><dd>${state.shoe.cards.length - state.shoe.cursor}</dd><dt>玩家真实手牌</dt><dd>${state.player.hand.cards.map(cardLabel).join(" ")}</dd><dt>对手真实手牌</dt><dd>${state.opponent.hand.cards.map(cardLabel).join(" ")}</dd><dt>玩家 / 对手子弹</dt><dd>${state.roulette.player.bullets} / ${state.roulette.opponent.bullets}</dd><dt>AI 参数 P / A / B / C</dt><dd>${profile.P} / ${profile.A} / ${profile.B} / ${profile.C}</dd><dt>Rmatch / Rplay</dt><dd>${state.aiNoise.match.toFixed(3)} / ${state.aiNoise.play.toFixed(3)}</dd><dt>技能阈值 bySkill</dt><dd>${ai?.bySkill ?? "—"}</dd><dt>上次手牌值 / 阈值 T</dt><dd>${ai ? `${ai.handValue} / ${ai.threshold.toFixed(3)}` : "—"}</dd><dt>上次子弹差 Bp - Ba</dt><dd>${ai?.bulletDifference ?? "—"}</dd><dt>对手上次决策</dt><dd>${decisionLabel(ai?.action)}</dd><dt>上次行动</dt><dd>${lastAction ? ACTION_LABELS[lastAction.type] : "—"}</dd><dt>上次领域事件</dt><dd>${lastDomainEvent ? EVENT_LABELS[lastDomainEvent] : "—"}</dd></dl><button class="quiet-button" data-copy-debug>复制调试状态</button><textarea id="debug-json" readonly hidden>${escapeHtml(text)}</textarea></details>`;
}
function renderSummary(state: MatchState): void {
  const winner = state.outcome?.winner;
  const escaped = state.outcome?.reason === "escaped";
  discardActiveTutorial();
  clearAiSchedule(); window.clearInterval(dialogueTimer); window.clearTimeout(dialogueShakeTimer); gameAudio.stopHeartbeat(); clearAbilityNoticeQueue(); detachFullscreenListener(); lastDialogueKey = null;
  const playerWon = winner === "player";
  const image = playerWon ? (currentCharacter.assets.defeatedSummary ?? currentCharacter.assets.unconscious) : escaped ? currentCharacter.assets.conflicted : currentCharacter.assets.relaxed;
  const imageAlt = playerWon ? `${currentCharacter.name} 全身无力地瘫坐在椅子上` : currentCharacter.name;
  const summaryCopy = escaped ? currentCharacter.matchSummary.escaped : playerWon ? currentCharacter.matchSummary.playerVictory : currentCharacter.matchSummary.playerDefeat;
  const alreadyUnlocked = new Set(unlockedPlayerSkillIdsForDefeats(save.defeats));
  const newlyUnlocked = playerWon && !escaped
    ? playerSkillsUnlockedForVictory(state.opponentId, winner, escaped).filter((id) => !alreadyUnlocked.has(id))
    : [];
  const newlyUnlockedCharacters = playerWon && !escaped ? newlyUnlockedForDefeat(save.defeats, state.opponentId) : [];
  const characterUnlockPanel = newlyUnlockedCharacters.length
    ? `<section class="unlock-panel character-unlock-panel" aria-live="polite"><p class="eyebrow">新角色已解锁</p>${newlyUnlockedCharacters.map((id) => { const character = getCharacterMetadata(id); if (!character) return ""; return `<div class="unlock-skill"><strong>${escapeHtml(character.name)}</strong><span>${escapeHtml(character.tier)}级与会者 · 已可在候场宾客中邀请</span><small>${escapeHtml(unlockConditionLabel(character.unlock))}</small></div>`; }).join("")}</section>`
    : "";
  const unlockPanel = newlyUnlocked.length
    ? `<section class="unlock-panel" aria-live="polite"><p class="eyebrow">新技能已解锁</p>${newlyUnlocked.map((id) => { const skill = getPlayerSkillDefinition(id); if (!skill) return ""; return `<div class="unlock-skill"><strong>${escapeHtml(skill.name)}</strong><span>${skill.category === "active" ? "主动" : "被动"} · ${escapeHtml(skill.description)}</span><small>${escapeHtml(skill.unlock?.label ?? "胜利奖励")}</small></div>`; }).join("")}</section>`
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
  root.innerHTML = `<main class="summary-shell"><p class="eyebrow">终局</p><img class="summary-character" src="${image}" alt="${imageAlt}" /><p class="kicker">${escaped ? "策展人提前离席" : playerWon ? "与会者已被击败" : "与会者拿下了这一局"}</p><h1>${escaped ? "已离席" : playerWon ? "策展人胜利" : "策展人落败"}</h1><p class="summary-copy">${escapeHtml(summaryCopy)}</p>${characterUnlockPanel}${unlockPanel}${summaryActions}</main>`;
  let summaryActionInFlight = false;
  root.querySelectorAll<HTMLButtonElement>("[data-summary-action]").forEach((button) => button.addEventListener("click", () => {
    if (summaryActionInFlight) return;
    summaryActionInFlight = true;
    root.querySelectorAll<HTMLButtonElement>("[data-summary-action]").forEach((candidate) => { candidate.disabled = true; });
    const destination = button.dataset.summaryAction;
    requestDispatch({ type: "ACK_MATCH_RESULT" });
    void completeMatch(destination === "history" || destination === "rewind" ? destination : "lobby");
  }));
}
async function completeMatch(destination: "history" | "rewind" | "lobby"): Promise<void> {
  if (!autosave) return;
  stopPluginMatch();
  await autosave.flush();
  save = autosave.getSave();
  const match = autosave.getState();
  const winner = match.outcome?.winner ?? null;
  const escaped = match.outcome?.reason === "escaped";
  const opponentId = match.opponentId;
  autosave = null;
  if (destination === "history" && winner === "player" && !escaped) await showHistoryScreen();
  else if (destination === "rewind" && winner !== "player" && !escaped) await startMatch(opponentId);
  else await renderLobby();
}
function renderError(error: unknown): void {
  discardActiveTutorial();
  clearAiSchedule();
  clearAbilityNoticeQueue();
  detachFullscreenListener();
  const incompatibleLongTerm = error instanceof SaveValidationError && error.kind === "long-term";
  const incompatibleRuntime = error instanceof SaveValidationError && error.kind === "runtime";
  const invalidLongTermInput = incompatibleLongTerm ? error.input : undefined;
  const action = incompatibleLongTerm
    ? `<div class="error-actions"><button class="danger-button" data-reset-invalid-save>删除长期存档并重新开始</button><button class="secondary-button" data-export-invalid-save ${invalidLongTermInput === undefined ? "disabled" : ""}>导出原始存档</button><button class="secondary-button" data-retry>重新检查</button></div><p class="status-line" data-error-status></p>`
    : incompatibleRuntime
      ? `<button class="primary-button" data-reset-invalid-runtime>舍弃未完成牌局</button><button class="secondary-button" data-retry>重新检查</button>`
    : `<button class="primary-button" data-retry>重试</button>`;
  const message = incompatibleLongTerm
    ? "这份长期存档不符合当前版本支持的格式，无法转换。你仍可导出原件留底，或手动删除并确认清除战绩与解锁。"
    : incompatibleRuntime
      ? "未完成牌局与当前版本不兼容。舍弃它不会影响长期战绩与解锁。"
      : uiError(error, "游戏无法启动。");
  const heading = incompatibleLongTerm ? "需要清理<br><em>长期存档</em>" : incompatibleRuntime ? "无法恢复<br><em>未完成牌局</em>" : "出现了<br><em>意外回合</em>";
  root.innerHTML = `<main class="error-shell"><p class="kicker">牌桌暂时离线</p><h1>${heading}</h1><p>${escapeHtml(message)}</p>${action}</main>`;
  root.querySelector("[data-retry]")?.addEventListener("click", () => void boot());
  root.querySelector("[data-reset-invalid-save]")?.addEventListener("click", () => {
    void confirmResetCurrentData().then((confirmed) => {
      if (confirmed) return repository.deleteLongTerm().then(() => boot());
    }).catch(renderError);
  });
  root.querySelector("[data-export-invalid-save]")?.addEventListener("click", () => {
    const status = root.querySelector<HTMLElement>("[data-error-status]");
    void downloadRawSave(invalidLongTermInput).then((method) => {
      if (status) status.textContent = exportStatus(method);
    }).catch((exportError: unknown) => { if (status) status.textContent = uiError(exportError, "原始存档导出失败。"); });
  });
  root.querySelector("[data-reset-invalid-runtime]")?.addEventListener("click", () => {
    void confirmGameDialog("无法恢复未完成牌局", RESET_RUNTIME_CONFIRM_MESSAGE, "舍弃这局牌").then((confirmed) => {
      if (confirmed) return repository.deleteRuntime().then(() => boot());
    }).catch(renderError);
  });
}
async function boot(): Promise<void> {
  clearAiSchedule();
  root.innerHTML = `<main class="loading-shell"><span class="mark">✦</span><p>正在洗牌……</p></main>`;
  try {
    save = await bootLoad(repository);
    saveLoaded = true;
    let activeMatch: MatchState | null;
    try { activeMatch = await restoreActiveMatch(repository); }
    catch (error) {
      if (!(error instanceof SaveValidationError) || error.kind !== "runtime" || !await confirmGameDialog("无法恢复未完成牌局", RESET_RUNTIME_CONFIRM_MESSAGE, "舍弃这局牌")) throw error;
      await repository.deleteRuntime();
      activeMatch = null;
    }
    document.body.classList.toggle("reduced-motion", save.settings.reducedMotion);
    gameAudio.configure(save.settings.soundEnabled); haptics.configure(!save.settings.reducedMotion);
    gameAudio.preloadLobby();
    const unlockAudio = () => { gameAudio.unlock(); const state = autosave?.getState(); if (state) syncMatchAudioState(gameAudio, state); };
    const signal = runtimeEventController?.signal;
    document.addEventListener("pointerdown", unlockAudio, { capture: true, once: true, signal });
    document.addEventListener("keydown", unlockAudio, { capture: true, once: true, signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) gameAudio.pauseBgm(); else gameAudio.restoreBgm(); }, { signal });
    void requestPersistentStorage();
    await requireAdultContentAcknowledgement();
    if (import.meta.env.DEV && devCalibrationCharacterId()) await renderDevRevolverCalibration();
    else if (activeMatch) await resumeMatch(activeMatch); else await renderLobby();
  } catch (error) { renderError(error); }
}

export interface GameRuntimeHandle {
  dispose(): Promise<void>;
}

export interface MountGameRuntimeOptions {
  readonly root: HTMLDivElement;
  readonly contributions?: readonly PluginRuntimeContribution[];
  readonly onExitRequest?: () => Promise<void>;
}

export async function requestGameRuntimeExit(): Promise<void> {
  if (!requestExitToLauncher) throw new Error("启动器没有提供退出处理器。");
  await requestExitToLauncher();
}

async function disposeGameRuntime(): Promise<void> {
  stopPluginMatch();
  if (!mounted) return;
  await autosave?.flush();
  if (saveLoaded) await repository.closeGameRuntime(autosave?.getSave() ?? save);
  else await repository.deleteRuntime();
  await repository.flush();

  clearAiSchedule();
  window.clearTimeout(presentationTimer);
  window.clearTimeout(presentationHideTimer);
  window.clearInterval(dialogueTimer);
  window.clearTimeout(dialogueShakeTimer);
  presentationTimer = undefined;
  presentationHideTimer = undefined;
  dialogueTimer = undefined;
  dialogueShakeTimer = undefined;
  discardActiveTutorial();
  clearAbilityNoticeQueue();
  detachFullscreenListener();
  detachInteractionHaptics();
  defeatedGuestObserver?.disconnect();
  defeatedGuestObserver = null;
  auxiliaryNavigationToken += 1;
  auxiliaryScreenController?.abort();
  auxiliaryScreenController = undefined;
  await auxiliaryMountedScreen?.dispose();
  auxiliaryMountedScreen = undefined;
  runtimeEventController?.abort();
  runtimeEventController = undefined;
  if (devRevolverKeyHandler) window.removeEventListener("keydown", devRevolverKeyHandler);
  devRevolverKeyHandler = undefined;
  devRevolverKeysAttached = false;
  await hapticLifecycleDisposer?.();
  hapticLifecycleDisposer = undefined;
  await nativeLifecycleDisposer?.();
  nativeLifecycleDisposer = undefined;
  resourceLoader.dispose();
  await gameAudio.dispose();
  document.querySelector(".adult-content-warning-backdrop")?.remove();
  document.body.classList.remove("reduced-motion", "shake");
  root.inert = false;
  root.replaceChildren();
  autosave = null;
  runtimeContributions = [];
  skillArchetypeArt = {};
  lobbyModulePromise = undefined;
  lobbyModule = undefined;
  tableModulePromise = undefined;
  saveLoaded = false;
  requestExitToLauncher = undefined;
  mounted = false;
}

export async function mountGameRuntime(options: MountGameRuntimeOptions): Promise<GameRuntimeHandle> {
  if (mounted) throw new Error("游戏运行时已经存在。");
  root = options.root;
  runtimeContributions = options.contributions ?? [];
  skillArchetypeArt = runtimeContributions.reduce<SkillArchetypeArt>((art, contribution) => ({ ...art, ...contribution.skillArchetypeArt }), {});
  repository = createPersistenceService();
  requestExitToLauncher = options.onExitRequest;
  runtimeEventController = new AbortController();
  hapticLifecycleDisposer = await bindHapticLifecycle();
  attachInteractionHaptics();
  nativeLifecycleDisposer = await bindNativePersistenceLifecycle(async () => {
    await autosave?.flush();
    await repository.flush();
  });
  mounted = true;
  await boot();
  return { dispose: disposeGameRuntime };
}
