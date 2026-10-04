import type { AbilityDisplay, DisplayInstance } from "./display-types";
import type { Card, CardSource, Hand, Rank, ShoeState, Suit } from "../blackjack/types";
import type { GunState } from "../roulette/types";
import type { RngSnapshot } from "../rng/seeded";
import type { SkillTag } from "../skills/types";

export type AbilityActor = "player" | "opponent";
export type DecisionAction = "hit" | "stand";
export type AbilitySourceKind = "player-skill" | "ai-skill" | "talent";
export type AbilityDefinitionSourceKind = AbilitySourceKind;
export type AbilityPrimaryDomain = SkillTag;
export type AbilityTtl =
  | { readonly type: "rounds"; readonly amount: number }
  | { readonly type: "triggers"; readonly amount: number };
export interface AbilityInstanceTtl { readonly type: AbilityTtl["type"]; readonly remaining: number; }
export interface SkillDrawWeightModifier { readonly tag: SkillTag; readonly factor: number; }
export type AbilityTrigger =
  | "on-round-start" | "before-bust-resolution" | "on-match-created" | "on-ability-gained" | "on-ability-played" | "before-turn" | "before-ai-decision" | "before-card-draw" | "after-card-draw" | "after-draw-pile-changed"
  | "after-hand-changed" | "after-stand" | "before-bust-check" | "before-round-resolution" | "before-bullet-load" | "after-bullet-load"
  | "before-trigger-pull" | "after-trigger-result" | "on-round-end";
  /** Emitted after an active ability card has completed successfully. */
export type AbilityBroadcastTrigger = AbilityTrigger | "after-ability-played";
export type ActionWindow = "owner-turn" | "owner-roulette-reaction";
export type StatusDuration = "turn" | "round" | "match" | "until-owner-action" | "until-consumed";
export type Compare = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
export type ScalarValue = number | NumberValue;
export type NumberValue =
  | { readonly type: "constant"; readonly value: number }
  | { readonly type: "parameter"; readonly key: string }
  | { readonly type: "gun-bullets"; readonly target: ActorSelector }
  | { readonly type: "hand-total"; readonly target: ActorSelector }
  | { readonly type: "round-final-score"; readonly target: ActorSelector }
  | { readonly type: "hand-card-count"; readonly target: ActorSelector }
  | { readonly type: "hand-card-color-count"; readonly target: ActorSelector; readonly color: "red" | "black" }
  | { readonly type: "hand-card-suit-count"; readonly target: ActorSelector; readonly suit: Suit }
  | { readonly type: "hand-card-status-suit-count"; readonly target: ActorSelector; readonly statusTarget: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "event-hand-card-count"; readonly target: ActorSelector }
  | { readonly type: "round-hit-count"; readonly target: ActorSelector }
  | { readonly type: "status-stacks"; readonly target: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "add" | "subtract" | "multiply" | "power" | "min" | "max"; readonly left: ScalarValue; readonly right: ScalarValue };
export type ActorSelector = "owner" | "rival" | "event-actor" | "penalty-target";
export type CardSelector = "last-card" | "first-private-card";
export type DerivedCardRankExpression =
  | { readonly type: "static"; readonly rank: Rank }
  | { readonly type: "scalar"; readonly value: ScalarValue }
  | { readonly type: "map-card-rank"; readonly card: CardSelector; readonly map: Readonly<Record<Rank, Rank>> };
export type DerivedCardSuitExpression =
  | { readonly type: "static"; readonly suit: Suit }
  | { readonly type: "uniform-ability-rng" };
export type CardZoneSource = "remaining-draw-pile";
export type RandomPick = "uniform-ability-rng";
export type CardCandidate =
  | { readonly type: "resulting-hand-total-at-most"; readonly value: ScalarValue }
  | { readonly type: "resulting-hand-total-exactly"; readonly value: ScalarValue };
export type DrawReplacementPolicy = { readonly type: "exact-resulting-total"; readonly total: ScalarValue; readonly fallback: "create-derived-card" };

export type Condition =
  | { readonly type: "actor-is"; readonly actor: ActorSelector }
  | { readonly type: "owner-has-card"; readonly abilityId: string }
  | { readonly type: "hand-card-count"; readonly target: ActorSelector; readonly operator: Compare; readonly value: ScalarValue }
  | { readonly type: "event-hand-card-count"; readonly target: ActorSelector; readonly operator: Compare; readonly value: ScalarValue }
  | { readonly type: "hand-total"; readonly target: ActorSelector; readonly operator: Compare; readonly value: ScalarValue }
  | { readonly type: "round-hit-count"; readonly target: ActorSelector; readonly operator: Compare; readonly value: ScalarValue }
  | { readonly type: "hand-all-same-suit"; readonly target: ActorSelector }
  | { readonly type: "hand-all-color"; readonly target: ActorSelector; readonly color: "red" | "black" }
  | { readonly type: "hand-rank-has-suit-partner"; readonly target: ActorSelector; readonly rank: Rank }
  | { readonly type: "hand-card-source-is"; readonly target: ActorSelector; readonly card: CardSelector; readonly source: CardSource }
  | { readonly type: "hand-card-has-tag"; readonly target: ActorSelector; readonly card: CardSelector; readonly tag: string }
  | { readonly type: "card-candidate-exists"; readonly target: ActorSelector; readonly card: CardSelector; readonly source: CardZoneSource; readonly candidate: CardCandidate }
  | { readonly type: "draw-pile-card-exists" }
  | { readonly type: "hand-last-card-splittable"; readonly target: ActorSelector }
  | { readonly type: "hand-is-twenty-one"; readonly target: ActorSelector }
  | { readonly type: "pending-turn-can-skip"; readonly target: ActorSelector }
  | { readonly type: "next-hit-would-bust"; readonly target: ActorSelector }
  | { readonly type: "pending-bust-would-bust"; readonly target: ActorSelector }
  | { readonly type: "status-card-rank-is"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly rank: Rank }
  | { readonly type: "gun-bullets"; readonly target: ActorSelector; readonly operator: Compare; readonly value: ScalarValue }
  | { readonly type: "gun-is-full"; readonly target: ActorSelector; readonly expected: boolean }
  | { readonly type: "round-reason-is"; readonly value: "blackjack" | "bust" | "comparison" | "push" }
  | { readonly type: "round-penalty-target-is"; readonly target: ActorSelector }
  | { readonly type: "event-ability-kind-is"; readonly kind: AbilitySourceKind }
  | { readonly type: "status-present"; readonly target: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "scalar-compare"; readonly left: ScalarValue; readonly operator: Compare; readonly right: ScalarValue }
  | { readonly type: "any"; readonly conditions: readonly Condition[] }
  | { readonly type: "not"; readonly condition: Condition };

export type Effect =
  | { readonly type: "set-pending-ai-action"; readonly target: ActorSelector; readonly action: "hit" | "stand" }
  | { readonly type: "redeal-initial-hand"; readonly target: ActorSelector }
  | { readonly type: "skip-turn"; readonly target: ActorSelector }
  | { readonly type: "add-to-pending-ai-threshold"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-skill-draws"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "publish-action-advice"; readonly target: ActorSelector; readonly policy: "current-optimal-hit-stand" }
  | { readonly type: "reveal-draw-pile-top-suit"; readonly viewer: ActorSelector }
  | { readonly type: "publish-hit-bust-forecast"; readonly target: ActorSelector }
  | { readonly type: "publish-hand-total-comparison"; readonly target: ActorSelector }
  | { readonly type: "replace-hand-card"; readonly target: ActorSelector; readonly card: CardSelector; readonly source: CardZoneSource; readonly candidate: CardCandidate; readonly pick: RandomPick }
  | { readonly type: "swap-last-hand-card-with-draw-pile-top"; readonly target: ActorSelector }
  | { readonly type: "transfer-last-physical-hand-card"; readonly from: ActorSelector; readonly target: ActorSelector }
  | { readonly type: "reveal-hand-card-suit"; readonly target: ActorSelector; readonly card: "first-private-card" | "all-current-cards"; readonly viewer: ActorSelector }
  | { readonly type: "split-last-card-into-derived"; readonly target: ActorSelector }
  | { readonly type: "add-status"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly parameters?: Readonly<Record<string, string | number | boolean>> }
  | { readonly type: "set-status-suit-to-hand-majority"; readonly target: ActorSelector; readonly handTarget: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "set-status-stacks"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly amount: ScalarValue }
  | { readonly type: "remove-status"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly amount?: ScalarValue }
  | { readonly type: "replace-pending-draw"; readonly target: ActorSelector; readonly policy: DrawReplacementPolicy }
  | { readonly type: "remember-last-card"; readonly target: ActorSelector; readonly cardTarget: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "replace-bust-hand-card-with-memory-card"; readonly target: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "add-derived-card-for-exact-total"; readonly target: ActorSelector; readonly total: ScalarValue }
  | { readonly type: "add-derived-card"; readonly target: ActorSelector; readonly rank: DerivedCardRankExpression; readonly suit: DerivedCardSuitExpression }
  | { readonly type: "copy-last-hand-card-as-derived"; readonly target: ActorSelector }
  | { readonly type: "replace-hand-card-with-derived"; readonly target: ActorSelector; readonly card: "last-card"; readonly rank: DerivedCardRankExpression; readonly suit: DerivedCardSuitExpression }
  | { readonly type: "add-hand-card-tag" | "remove-hand-card-tag"; readonly target: ActorSelector; readonly card: CardSelector; readonly tag: string }
  | { readonly type: "rotate-draw-pile-top-to-bottom" }
  | { readonly type: "grant-player-skill-card"; readonly target: ActorSelector; readonly source: "last-successful-player-skill"; readonly fallback: "self" }
  | { readonly type: "add-to-pending-bust-limit"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-to-pending-trigger-misfire-chance"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-to-pending-load"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "set-pending-load"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "multiply-pending-load"; readonly target: ActorSelector; readonly factor: ScalarValue }
  | { readonly type: "add-gun-bullets"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-to-pending-comparison-score"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "cancel-pending-trigger"; readonly target: ActorSelector };

export interface AbilityParameterSpec { readonly type: "number" | "boolean" | "enum"; readonly minimum?: number; readonly maximum?: number; readonly values?: readonly string[]; readonly default?: number | boolean | string; }
export interface AbilityBinding { readonly definitionId: string; readonly enabled: boolean; readonly parameters: Readonly<Record<string, string | number | boolean>>; }
export interface AbilitySource { readonly kind: AbilitySourceKind; readonly definitionId: string; readonly owner: AbilityActor; readonly instanceId: string; }
export interface SkillCardInstance extends AbilitySource { readonly kind: "player-skill"; }
export interface AbilityInstance extends AbilitySource { readonly createdAtSequence: number; readonly parameters: Readonly<Record<string, string | number | boolean>>; readonly ttl?: AbilityInstanceTtl; readonly remainingUses?: number; }
export interface RuleLimit { readonly perEvent?: number; readonly perTurn?: number; readonly perRound?: number; readonly perMatch?: number; }
export interface AbilityRule { readonly id: string; readonly trigger: AbilityBroadcastTrigger; readonly priority?: number; readonly notify?: boolean; readonly triggerNotice?: string; readonly conditions?: readonly Condition[]; readonly effects: readonly Effect[]; readonly limit?: RuleLimit; }
export type AbilityActivation =
  | { readonly type: "action"; readonly windows: readonly ActionWindow[]; readonly consume: "card" | "none"; readonly uses?: number; readonly availability?: readonly Condition[] }
  | { readonly type: "automatic" } | { readonly type: "passive" };
interface AbilityDefinitionBase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly triggerNotice?: string;
  readonly profileLore?: string;
  readonly hidden?: boolean;
  readonly sourceKind: AbilityDefinitionSourceKind;
  readonly primaryDomain: AbilityPrimaryDomain;
  readonly tags: readonly string[];
  readonly parameters?: Readonly<Record<string, AbilityParameterSpec>>;
  readonly activation: AbilityActivation;
  /** Finite lifetime for passive/automatic skills. Talents and active cards do not use TTL. */
  readonly ttl?: AbilityTtl;
  readonly rules: readonly AbilityRule[];
  readonly displays?: readonly AbilityDisplay[];
  /** Shared extension point consumed by skill-draw candidate generation, not the ability interpreter. */
  readonly skillDrawWeightModifiers?: readonly SkillDrawWeightModifier[];
}
export interface PlayerSkillAbilityDefinition extends AbilityDefinitionBase {
  readonly sourceKind: "player-skill";
  readonly drop: { readonly enabled: boolean; readonly baseWeight: number };
  /** Only passive skills consult this flag; active cards may always be duplicated. */
  readonly stackable: boolean;
  readonly unlock?: { readonly opponentId: string; readonly label: string };
  readonly skillTags: readonly SkillTag[];
}
export interface AiSkillAbilityDefinition extends AbilityDefinitionBase { readonly sourceKind: "ai-skill"; }
export interface TalentAbilityDefinition extends AbilityDefinitionBase {
  readonly sourceKind: "talent";
  readonly unlock: { readonly type: "defeat-count"; readonly count: number; readonly label: string };
}
export type AbilityDefinition = PlayerSkillAbilityDefinition | AiSkillAbilityDefinition | TalentAbilityDefinition;
export interface StatusDefinition { readonly id: string; readonly rules: readonly AbilityRule[]; readonly defaultDuration: StatusDuration; readonly blocksAbilityTags?: readonly string[]; readonly blocksActions?: readonly DecisionAction[]; }
export interface AbilityStatus { readonly statusDefinitionId: string; readonly owner: AbilityActor; readonly sourceInstanceId: string; readonly stacks: number; readonly duration: StatusDuration; readonly parameters: Readonly<Record<string, string | number | boolean>>; readonly createdAtSequence: number; }
export interface AbilityRuntimeState {
  readonly displays: readonly DisplayInstance[];
  readonly instances: readonly AbilityInstance[];
  readonly statuses: readonly AbilityStatus[];
  readonly counters: Readonly<Record<string, number>>;
  readonly sequence: number;
  readonly catalogVersion: string;
  readonly rng: RngSnapshot;
  /** Last successfully played Player Skill, used by data-driven mimic effects. */
  readonly lastPlayedPlayerSkillDefinitionId: string | null;
}

export interface PendingDraw { readonly id: string; readonly actor: AbilityActor; readonly card?: Card; readonly replacement?: Card; readonly cancelled?: boolean; }
export interface PendingTurn { readonly id: string; readonly actor: AbilityActor; readonly canSkip: boolean; readonly skipped?: boolean; readonly skipSourceInstanceId?: string; }
export interface PendingAiThreshold { readonly id: string; readonly actor: AbilityActor; readonly bySkill: number; readonly actionOverride?: { readonly action: "hit" | "stand"; readonly sourceInstanceId: string }; }
export interface PendingLoad { readonly id: string; readonly actor: AbilityActor; readonly amount: number; readonly reason: "blackjack" | "bust" | "comparison" | "push"; }
export interface PendingBustCheck { readonly id: string; readonly actor: AbilityActor; readonly limit: number; readonly standAfterReplacement?: boolean; }
export interface PendingTrigger { readonly id: string; readonly actor: AbilityActor; readonly misfireChance?: number; readonly cancelled?: boolean; readonly cancelSourceInstanceId?: string; }
export interface PendingComparison { readonly id: string; readonly scores: Readonly<Record<AbilityActor, number>>; }
export interface AbilityEventContext { readonly trigger: AbilityTrigger | "after-ability-played"; readonly sourceEventId: string; readonly eventActor?: AbilityActor; readonly playedAbilityKind?: AbilitySourceKind; readonly roundHitCounts?: Readonly<Record<AbilityActor, number>>; readonly initialHandCardCounts?: Readonly<Record<AbilityActor, number>>; readonly roundOutcome?: { readonly reason: "blackjack" | "bust" | "comparison" | "push"; readonly penaltyTarget: AbilityActor | null; readonly comparisonScores?: Readonly<Record<AbilityActor, number>> }; readonly pendingTurn?: PendingTurn; readonly pendingAiThreshold?: PendingAiThreshold; readonly pendingDraw?: PendingDraw; readonly pendingLoad?: PendingLoad; readonly pendingBust?: PendingBustCheck; readonly pendingTrigger?: PendingTrigger; }

export interface AbilityWorld { readonly hands: Readonly<Record<AbilityActor, Hand>>; readonly guns: Readonly<Record<AbilityActor, GunState>>; readonly shoe: ShoeState; readonly cards: readonly SkillCardInstance[]; readonly skillDraws: number; readonly statuses: readonly AbilityStatus[]; readonly advice?: "hit" | "stand" | null; }
export interface AbilityEffectResult { readonly world: AbilityWorld; readonly pendingTurn?: PendingTurn; readonly pendingAiThreshold?: PendingAiThreshold; readonly pendingDraw?: PendingDraw; readonly pendingLoad?: PendingLoad; readonly pendingBust?: PendingBustCheck; readonly pendingTrigger?: PendingTrigger; readonly pendingComparison?: PendingComparison; readonly runtime: AbilityRuntimeState; readonly events: readonly AbilityDomainEvent[]; }
export type AbilityDomainEvent =
  | { readonly type: "ABILITY_PLAYED"; readonly instanceId: string; readonly definitionId: string; readonly owner: AbilityActor }
  | { readonly type: "ABILITY_TRIGGERED"; readonly instanceId: string; readonly definitionId: string; readonly ruleId: string; readonly owner: AbilityActor }
  | { readonly type: "ABILITY_EXPIRED"; readonly instanceId: string; readonly definitionId: string; readonly owner: AbilityActor; readonly reason: "rounds" | "triggers" }
  | { readonly type: "ABILITY_RESOLUTION_FAILED"; readonly instanceId: string; readonly definitionId: string; readonly ruleId: string; readonly reason: string }
  | { readonly type: "STATUS_ADDED"; readonly statusDefinitionId: string; readonly owner: AbilityActor; readonly sourceInstanceId: string }
  | { readonly type: "STATUS_REMOVED"; readonly statusDefinitionId: string; readonly owner: AbilityActor; readonly reason: "consumed" | "expired" | "dispelled" }
  | { readonly type: "PENDING_EVENT_MODIFIED"; readonly eventId: string; readonly effectType: string; readonly sourceInstanceId: string }
  | { readonly type: "PENDING_EVENT_CANCELLED"; readonly eventId: string; readonly sourceInstanceId: string }
  | { readonly type: "HAND_REDEALT"; readonly actor: AbilityActor; readonly discardedCardIds: readonly string[] }
  | { readonly type: "CARD_DEALT"; readonly actor: AbilityActor; readonly card: Card; readonly private: boolean }
  | { readonly type: "CARD_SUIT_REVEALED"; readonly viewer: AbilityActor; readonly target: AbilityActor; readonly cardId: string; readonly suit: Suit }
  | { readonly type: "DRAW_PILE_CARD_SUIT_REVEALED"; readonly viewer: AbilityActor; readonly cardId: string; readonly suit: Suit }
  | { readonly type: "DRAW_PILE_CARD_REVEALED"; readonly viewer: AbilityActor; readonly cardId: string; readonly rank: Rank; readonly suit: Suit }
  | { readonly type: "SKILL_GAINED"; readonly skillId: string }
  | { readonly type: "ABILITY_RESULT"; readonly instanceId: string; readonly definitionId: string; readonly owner: AbilityActor; readonly result:
      | { readonly type: "derived-card-added"; readonly actor: AbilityActor; readonly rank: Rank; readonly suit: Suit }
      | { readonly type: "derived-card-replaced"; readonly actor: AbilityActor; readonly oldRank: Rank; readonly rank: Rank; readonly suit: Suit }
      | { readonly type: "status-stacks-updated"; readonly actor: AbilityActor; readonly statusDefinitionId: string; readonly stacks: number; readonly delta: number }
      | { readonly type: "skill-card-granted"; readonly definitionId: string }
      | { readonly type: "hit-bust-forecast"; readonly actor: AbilityActor; readonly wouldBust: boolean }
      | { readonly type: "hand-total-compared"; readonly actor: AbilityActor; readonly relation: "higher" | "equal" | "lower" }
      | { readonly type: "gun-bullets-added"; readonly actor: AbilityActor; readonly amount: number; readonly bullets: number }
      | { readonly type: "draw-pile-rotated" } };
export type AbilityEvent = AbilityDomainEvent;
