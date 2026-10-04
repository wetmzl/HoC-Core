import { getAbilityDefinition, getStatusDefinition, STATUS_DEFINITIONS } from "../core/abilities/registry";
import { getActiveBustLimit, type PendingTriggerPreview } from "../core/match/reducer";
import type { MatchState, GameEvent } from "../core/match/types";
import type { AbilityRule, Effect } from "../core/abilities/types";

export type AbilityNoticeTone = "player" | "ai" | "notification";

export interface AbilityNotice {
  readonly owner: "player" | "opponent" | "system";
  readonly tone: AbilityNoticeTone;
  readonly text: string;
}

function actorName(owner: "player" | "opponent", opponentName: string): string {
  return owner === "player" ? "策展人" : opponentName;
}

function modifiesPendingTriggerMisfire(rule: AbilityRule | undefined): boolean {
  return rule?.trigger === "before-trigger-pull"
    && rule.effects.some((effect) => effect.type === "add-to-pending-trigger-misfire-chance");
}

function suitLabel(suit: "hearts" | "diamonds" | "clubs" | "spades"): string {
  if (suit === "hearts") return "红桃";
  if (suit === "diamonds") return "方块";
  if (suit === "clubs") return "梅花";
  return "黑桃";
}

function effectResultNotice(
  effect: Effect,
  event: Extract<GameEvent, { type: "ABILITY_TRIGGERED" }>,
  events: readonly GameEvent[],
  after?: MatchState
): string | null {
  if (effect.type === "add-to-pending-trigger-misfire-chance") {
    const trigger = [...events].reverse().find((candidate): candidate is Extract<GameEvent, { type: "TRIGGER_PULLED" }> => candidate.type === "TRIGGER_PULLED" && candidate.actor === event.owner);
    if (trigger) return `本轮哑火概率为${Math.round(trigger.misfireChance * 100)}%`;
  }
  if (effect.type === "publish-action-advice" && after?.playerSkills.advice) {
    return `建议${after.playerSkills.advice === "hit" ? " Hit 要牌" : " Stand 停牌"}`;
  }
  if (effect.type === "reveal-hand-card-suit") {
    const target = event.owner === "player" ? "opponent" : "player";
    const revealed = events.filter((candidate): candidate is Extract<GameEvent, { type: "CARD_SUIT_REVEALED" }> => candidate.type === "CARD_SUIT_REVEALED" && candidate.viewer === event.owner && candidate.target === target);
    if (revealed.length > 0) {
      const labels = [...new Map(revealed.map((candidate) => [candidate.cardId, suitLabel(candidate.suit)])).values()];
      return effect.card === "all-current-cards"
        ? `对手当前所有手牌花色为${labels.join("、")}`
        : `对手暗牌花色为${labels[0]}`;
    }
  }
  if (effect.type === "reveal-draw-pile-top-suit") {
    const revealed = [...events].reverse().find((candidate): candidate is Extract<GameEvent, { type: "DRAW_PILE_CARD_SUIT_REVEALED" }> => candidate.type === "DRAW_PILE_CARD_SUIT_REVEALED" && candidate.viewer === event.owner);
    if (revealed) return `牌堆顶下一张牌的花色是${suitLabel(revealed.suit)}`;
  }
  if (effect.type === "set-status-suit-to-hand-majority" && after) {
    const suit = after.abilities.statuses.find((status) => status.sourceInstanceId === event.instanceId && status.statusDefinitionId === effect.statusDefinitionId)?.parameters.suit;
    if (suit === "hearts" || suit === "diamonds" || suit === "clubs" || suit === "spades") return `指定花色为${suitLabel(suit)}`;
  }
  if (effect.type === "cancel-pending-trigger") return "本次免于扣扳机";
  if (effect.type === "add-to-pending-bust-limit" && after) {
    const bust = [...events].reverse().find((candidate): candidate is Extract<GameEvent, { type: "BUST" }> => candidate.type === "BUST");
    const hit = [...events].reverse().find((candidate): candidate is Extract<GameEvent, { type: "PLAYER_HIT" | "OPPONENT_HIT" }> => candidate.type === "PLAYER_HIT" || candidate.type === "OPPONENT_HIT");
    const actor = bust?.actor ?? (hit?.type === "PLAYER_HIT" ? "player" : hit?.type === "OPPONENT_HIT" ? "opponent" : undefined);
    if (actor) {
      const limit = after[actor].bustLimit;
      if (limit !== undefined) return `本轮爆牌上限为${limit}点`;
    }
  }
  if (effect.type === "set-status-stacks" && after) {
    const status = after.abilities.statuses.find((candidate) => candidate.owner === event.owner && candidate.statusDefinitionId === effect.statusDefinitionId);
    if (status) return `当前值为${status.stacks}`;
  }
  return null;
}

function ruleNotice(
  event: Extract<GameEvent, { type: "ABILITY_TRIGGERED" }>,
  rule: AbilityRule | undefined,
  definition: NonNullable<ReturnType<typeof getAbilityDefinition>>,
  events: readonly GameEvent[],
  after?: MatchState
): string {
  if (events.some((candidate) => candidate.type === "PENDING_EVENT_CANCELLED" && candidate.sourceInstanceId === event.instanceId)) return "本次免于扣扳机";
  const results = events.filter((candidate): candidate is Extract<GameEvent, { type: "ABILITY_RESULT" }> => candidate.type === "ABILITY_RESULT" && candidate.instanceId === event.instanceId).map((candidate) => candidate.result);
  const forecast = results.find((candidate): candidate is Extract<typeof candidate, { type: "hit-bust-forecast" }> => candidate.type === "hit-bust-forecast");
  if (forecast) return forecast.wouldBust ? "现在 Hit 会导致爆牌。" : "现在 Hit 不会导致爆牌。";
  const comparison = results.find((candidate): candidate is Extract<typeof candidate, { type: "hand-total-compared" }> => candidate.type === "hand-total-compared");
  if (comparison) return comparison.relation === "equal" ? "双方当前基础点数相同。" : comparison.relation === "higher" ? "你的当前基础点数更高。" : "对手的当前基础点数更高。";
  const gunLoad = results.find((candidate): candidate is Extract<typeof candidate, { type: "gun-bullets-added" }> => candidate.type === "gun-bullets-added");
  if (gunLoad) return `为自己装填${gunLoad.amount}发子弹，当前弹巢共有${gunLoad.bullets}发；若本轮败北，将免于扣动扳机。`;
  const derived = results.find((candidate): candidate is Extract<typeof candidate, { type: "derived-card-added" }> => candidate.type === "derived-card-added");
  const replaced = results.find((candidate): candidate is Extract<typeof candidate, { type: "derived-card-replaced" }> => candidate.type === "derived-card-replaced");
  const statusResult = results.find((candidate): candidate is Extract<typeof candidate, { type: "status-stacks-updated" }> => candidate.type === "status-stacks-updated");
  if (derived && statusResult && statusResult.delta > 0) return `获得一张${suitLabel(derived.suit)}${derived.rank}衍生牌，多余的${statusResult.delta}点转化为点数优势。`;
  if (derived) return `获得一张${derived.rank}点衍生牌。`;
  if (replaced) return `最后一张手牌${replaced.oldRank}被替换为${replaced.rank}。`;
  const granted = results.find((candidate): candidate is Extract<typeof candidate, { type: "skill-card-granted" }> => candidate.type === "skill-card-granted");
  if (granted) return `获得一张「${getAbilityDefinition(granted.definitionId)?.name ?? granted.definitionId}」。`;
  if (results.some((candidate) => candidate.type === "draw-pile-rotated")) return "牌堆顶的一张牌已被移至牌堆底。";
  if (statusResult && rule?.triggerNotice) return rule.triggerNotice;
  if (statusResult) {
    const status = getStatusDefinition(statusResult.statusDefinitionId);
    const hasBustRule = status?.rules.some((candidate) => candidate.effects.some((effect) => effect.type === "add-to-pending-bust-limit"));
    const hasComparisonRule = status?.rules.some((candidate) => candidate.effects.some((effect) => effect.type === "add-to-pending-comparison-score"));
    if (hasBustRule) return `本轮公共爆牌上限提高至${after ? getActiveBustLimit(after, statusResult.actor) : 21 + statusResult.stacks}点。`;
    if (hasComparisonRule) return `获得${statusResult.delta}点点数优势。`;
  }
  const dynamic = rule?.effects
    .map((effect) => effectResultNotice(effect, event, events, after))
    .find((notice): notice is string => Boolean(notice));
  const fallback = dynamic ?? rule?.triggerNotice ?? definition.triggerNotice ?? definition.description;
  return fallback.trim().replace(/^技能(?:效果)?[：:]\s*/, "");
}

/** Present each visible ability trigger independently; talents are not table toasts. */
export function abilityTriggerNotice(events: readonly GameEvent[], opponentName: string, after?: MatchState): AbilityNotice[] {
  const notices: AbilityNotice[] = [];
  const resolvedTrigger = events.some((event) => event.type === "TRIGGER_PULLED");
  for (const event of events) {
    if (event.type !== "ABILITY_TRIGGERED") continue;
    const definition = getAbilityDefinition(event.definitionId);
    if (!definition || (definition.sourceKind !== "player-skill" && definition.sourceKind !== "ai-skill")) continue;
    const rule = definition.rules.find((candidate) => candidate.id === event.ruleId)
      ?? STATUS_DEFINITIONS.flatMap((status) => status.rules).find((candidate) => candidate.id === event.ruleId);
    if (rule?.notify === false) continue;
    // Pending trigger modifiers are announced when the heartbeat window opens.
    if (resolvedTrigger && modifiesPendingTriggerMisfire(rule)) continue;
    const name = actorName(event.owner, opponentName);
    notices.push({
      owner: event.owner,
      tone: event.owner === "player" ? "player" : "ai",
      text: `${name}发动「${definition.name}」：${ruleNotice(event, rule, definition, events, after)}`
    });
  }
  return notices;
}

/** Formats deterministic before-trigger previews for the heartbeat window. */
export function pendingTriggerAbilityNotices(preview: PendingTriggerPreview, opponentName: string): AbilityNotice[] {
  const notices: AbilityNotice[] = [];
  for (const event of preview.events) {
    if (event.type !== "ABILITY_TRIGGERED") continue;
    const definition = getAbilityDefinition(event.definitionId);
    if (!definition || (definition.sourceKind !== "player-skill" && definition.sourceKind !== "ai-skill")) continue;
    const rule = definition.rules.find((candidate) => candidate.id === event.ruleId)
      ?? STATUS_DEFINITIONS.flatMap((status) => status.rules).find((candidate) => candidate.id === event.ruleId);
    if (rule?.notify === false || !modifiesPendingTriggerMisfire(rule)) continue;
    notices.push({
      owner: event.owner,
      tone: event.owner === "player" ? "player" : "ai",
      text: `${actorName(event.owner, opponentName)}发动「${definition.name}」：本轮哑火概率为${Math.round(preview.misfireChance * 100)}%`
    });
  }
  return notices;
}

export function abilityExpiredNotices(events: readonly GameEvent[]): AbilityNotice[] {
  return events
    .filter((event): event is Extract<GameEvent, { type: "ABILITY_EXPIRED" }> => event.type === "ABILITY_EXPIRED")
    .map((event) => ({
      owner: "system",
      tone: "notification",
      text: `${getAbilityDefinition(event.definitionId)?.name ?? "被动技能"}的效果已耗尽`
    }));
}
