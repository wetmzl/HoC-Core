import type { AbilityTtl, SkillCardInstance } from "../abilities/types";

/** The four closed ability domains and player skill-draw archetypes. */
export type SkillTag = "gambler" | "cheater" | "intelligence-officer" | "gunslinger";
export const SKILL_TAG_METADATA: Readonly<Record<SkillTag, { readonly label: string; readonly symbol: string; readonly summary: string }>> = Object.freeze({
  gambler: { label: "赌徒", symbol: "♠", summary: "操作自己的手牌，目标是做出更大的牌型，同时避免自己爆牌。此类技能主要作用于策展人的手牌，核心用途是提高黑杰克牌局的胜率。" },
  cheater: { label: "老千", symbol: "♦", summary: "操纵牌桌规则与全局局势：提高爆牌上限、制造点数优势、调整或干预牌库。使用这些技能时，你是在明显地尝试控制整场赌局。" },
  "intelligence-officer": { label: "情报官", symbol: "♥", summary: "获取原本无法直接得知的信息，例如暗牌、牌库或局势线索。情报本身不直接改变结果，但能帮助你做出更准确的行动选择。" },
  gunslinger: { label: "枪手", symbol: "♣", summary: "操作俄罗斯轮盘相关机制，包括弹仓、子弹与扳机事件，甚至可以直接从轮盘过程中获取优势。" }
});
export const SKILL_TAGS: readonly SkillTag[] = Object.freeze(Object.keys(SKILL_TAG_METADATA) as SkillTag[]);

export type SkillTiming = "player-turn" | "roulette-reaction";
export type SkillCategory = "active" | "passive";

export interface PlayerSkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly triggerNotice: string;
  readonly profileLore: string;
  /** Full in-game rules shown from the compact table card. */
  readonly usage: string;
  readonly category: SkillCategory;
  readonly timing: readonly SkillTiming[];
  /** Successful activations available on one inventory card. Defaults to one. */
  readonly uses: number;
  /** The first entry matches primaryDomain; later entries are secondary draw affinities. */
  readonly skillTags: readonly SkillTag[];
  readonly primaryDomain: SkillTag;
  readonly tags: readonly string[];
  readonly drop: { readonly enabled: boolean; readonly baseWeight: number };
  readonly stackable: boolean;
  readonly ttl?: AbilityTtl;
  /** Optional data-driven unlock source. Undefined means an initial skill. */
  readonly unlock?: { readonly opponentId: string; readonly label: string };
  readonly hidden: boolean;
}

export interface SkillDrawOffer {
  readonly id: string;
  readonly candidateDefinitionIds: readonly string[];
}

export interface PlayerSkillInventory {
  /** Every active and passive card occupies one stable inventory slot. */
  readonly cards: readonly SkillCardInstance[];
  /** Durable unlock snapshot used by deterministic draw generation. */
  readonly unlockedDefinitionIds: readonly string[];
  /** Snapshot of the player's selected archetype preferences for this match. */
  readonly selectedSkillTags: readonly SkillTag[];
  /** Earned draws that have not yet been exchanged for a skill card. */
  readonly drawCount: number;
  readonly drawOffer: SkillDrawOffer | null;
  readonly advice: "hit" | "stand" | null;
}
