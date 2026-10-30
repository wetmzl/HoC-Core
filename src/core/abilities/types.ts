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
  | "before-round-deal" | "on-round-start" | "before-bust-resolution" | "on-match-created" | "on-ability-gained" | "on-ability-played" | "before-turn" | "before-ai-decision" | "before-card-draw" | "after-card-draw" | "after-draw-pile-changed"
  | "after-card-acquired" | "after-hit-resolved" | "after-hand-changed" | "after-stand" | "before-bust-check" | "before-round-resolution" | "before-bullet-load" | "after-bullet-load"
  | "before-trigger-pull" | "after-trigger-result" | "before-defeat" | "after-defeat-prevented" | "on-round-end";
  /** Emitted after an active ability card has completed successfully. */
export type AbilityBroadcastTrigger = AbilityTrigger | "after-ability-played";
export type ActionWindow = "owner-turn" | "owner-roulette-reaction";
export type StatusDuration = "turn" | "round" | "match" | "until-owner-action" | "until-consumed";
export type Compare = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
export type ScalarValue = number | NumberValue;
export interface SkillCardFilter {
  readonly definitionIds?: readonly string[];
  readonly instanceIds?: readonly string[];
  readonly primaryDomains?: readonly SkillTag[];
  readonly skillTags?: readonly SkillTag[];
  readonly tags?: readonly string[];
  readonly activation?: "action" | "passive" | "automatic";
}
export type ValueExpression =
  | { readonly type: "literal"; readonly value: string | number | boolean }
  | { readonly type: "numeric"; readonly value: ScalarValue }
  | { readonly type: "status-value"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly key: string }
  | { readonly type: "card-attribute"; readonly target: ActorSelector; readonly card: CardSelector; readonly attribute: "rank" | "suit" | "source" | "id" }
  | { readonly type: "hand-dominant-suit"; readonly target: ActorSelector; readonly tieBreak: readonly Suit[] };
export interface CardTransform { readonly count: number; readonly total: ScalarValue; readonly suits: "same-color" | "same-suit" | "independent" | "source-suit"; }
export type CardAcquisitionChoice =
  | { readonly source: "draw-pile"; readonly candidate?: CardCandidate; readonly evaluationLimit?: ScalarValue; readonly pick: "first" | "lowest-value" | "uniform-ability-rng" }
  | { readonly source: "derived"; readonly candidate: CardCandidate; readonly evaluationLimit?: ScalarValue; readonly pick: "first" | "uniform-ability-rng" }
  | { readonly source: "derived"; readonly rank: DerivedCardRankExpression; readonly suit: DerivedCardSuitExpression };
export type SkillDefinitionSelector = { readonly type: "self" } | { readonly type: "last-successful-player-skill" } | { readonly type: "definition"; readonly definitionId: string; readonly level?: number };
export type NumberValue =
  | { readonly type: "bust-limit"; readonly target: ActorSelector }
  | { readonly type: "hand-card-match-count"; readonly target: ActorSelector; readonly attribute: "rank" | "suit" | "source" | "id"; readonly equals: ValueExpression }
  | { readonly type: "skill-card-count"; readonly target: ActorSelector; readonly filter?: SkillCardFilter }
  | { readonly type: "public-hand-card-suit-count"; readonly target: ActorSelector; readonly suit: Suit }
  | { readonly type: "effect-result"; readonly key: string }
  | { readonly type: "constant"; readonly value: number }
  | { readonly type: "parameter"; readonly key: string }
  | { readonly type: "gun-bullets"; readonly target: ActorSelector }
  | { readonly type: "hand-total"; readonly target: ActorSelector }
  | { readonly type: "hand-card-value"; readonly target: ActorSelector; readonly card: CardSelector; readonly aceValue?: "one" | "eleven" | "effective" }
  | { readonly type: "acquired-card-value"; readonly aceValue?: "one" | "eleven" | "effective" }
  | { readonly type: "round-point-advantage"; readonly target: ActorSelector; readonly round: "current" | "previous" }
  | { readonly type: "round-final-score"; readonly target: ActorSelector }
  | { readonly type: "hand-card-count"; readonly target: ActorSelector }
  | { readonly type: "hand-card-color-count"; readonly target: ActorSelector; readonly color: "red" | "black" }
  | { readonly type: "hand-card-suit-count"; readonly target: ActorSelector; readonly suit: Suit }
  | { readonly type: "event-hand-card-count"; readonly target: ActorSelector }
  | { readonly type: "round-hit-count"; readonly target: ActorSelector }
  | { readonly type: "status-number"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly key: string }
  | { readonly type: "rank-record-count"; readonly target: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "hand-rank-record-count"; readonly target: ActorSelector; readonly statusTarget: ActorSelector; readonly statusDefinitionId: string; readonly matched: boolean }
  | { readonly type: "status-stacks"; readonly target: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "add" | "subtract" | "multiply" | "power" | "min" | "max" | "divide" | "modulo"; readonly left: ScalarValue; readonly right: ScalarValue }
  | { readonly type: "floor" | "ceil" | "round" | "abs"; readonly value: ScalarValue };
export type ActorSelector = "owner" | "rival" | "event-actor" | "penalty-target" | "status-owner";
export type CardSelector = "last-card" | "first-private-card" | "first-public-card";
export type DerivedCardRankExpression =
  | { readonly type: "value"; readonly value: ValueExpression }
  | { readonly type: "static"; readonly rank: Rank }
  | { readonly type: "scalar"; readonly value: ScalarValue }
  | { readonly type: "map-card-rank"; readonly card: CardSelector; readonly map: Readonly<Record<Rank, Rank>> };
export type DerivedCardSuitExpression =
  | { readonly type: "value"; readonly value: ValueExpression }
  | { readonly type: "copy-card-suit"; readonly card: CardSelector }
  | { readonly type: "static"; readonly suit: Suit }
  | { readonly type: "uniform-ability-rng" };
export type CardZoneSource = "remaining-draw-pile";
export type RandomPick = "uniform-ability-rng";
export type CardCandidate =
  | { readonly type: "resulting-hand-total-at-most"; readonly value: ScalarValue }
  | { readonly type: "resulting-hand-total-exactly"; readonly value: ScalarValue };
export type DrawReplacementPolicy = { readonly type: "exact-resulting-total"; readonly total: ScalarValue; readonly fallback: "create-derived-card" };

export type Condition =
  | { readonly type: "value-compare"; readonly left: ValueExpression; readonly operator: "eq" | "neq"; readonly right: ValueExpression }
  | { readonly type: "hand-card-transformable"; readonly target: ActorSelector; readonly card: CardSelector; readonly output: CardTransform }
  | { readonly type: "pending-defeat-can-prevent"; readonly target: ActorSelector }
  | { readonly type: "trigger-result-is"; readonly value: "fired" | "empty-chamber" | "misfire" }
  | { readonly type: "acquired-card-source-is"; readonly source: CardSource }
  | { readonly type: "round-had-bust" }
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
  | { readonly type: "hand-is-twenty-one"; readonly target: ActorSelector }
  | { readonly type: "pending-turn-can-skip"; readonly target: ActorSelector }
  | { readonly type: "next-hit-would-bust"; readonly target: ActorSelector }
  | { readonly type: "last-hit-card-transfer-is-safe"; readonly from: ActorSelector; readonly target: ActorSelector }
  | { readonly type: "pending-bust-would-bust"; readonly target: ActorSelector }
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
  | { readonly type: "assign-status-values"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly values: Readonly<Record<string, ValueExpression>>; readonly mode?: "merge" | "replace"; readonly stacks?: ScalarValue }
  | { readonly type: "transform-hand-card"; readonly target: ActorSelector; readonly card: CardSelector; readonly output: CardTransform }
  | { readonly type: "acquire-card"; readonly target: ActorSelector; readonly choices: readonly CardAcquisitionChoice[]; readonly reveal?: boolean; readonly reportResult?: boolean }
  | { readonly type: "grant-skill-card"; readonly target: ActorSelector; readonly choices: readonly SkillDefinitionSelector[]; readonly initialize?: boolean }
  | { readonly type: "remove-skill-cards"; readonly target: ActorSelector; readonly filter?: SkillCardFilter; readonly resultKey?: string }
  | { readonly type: "transfer-hand-card"; readonly from: ActorSelector; readonly target: ActorSelector; readonly card: CardSelector | "last-hit-card" }
  | { readonly type: "reveal-hand-cards-matching-public-suits"; readonly target: ActorSelector; readonly suitsFrom: ActorSelector }
  | { readonly type: "prevent-pending-defeat"; readonly target: ActorSelector }
  | { readonly type: "force-stand"; readonly target: ActorSelector }
  | { readonly type: "record-random-rank"; readonly target: ActorSelector; readonly statusDefinitionId: string }
  | { readonly type: "record-hand-card-rank"; readonly target: ActorSelector; readonly handTarget: ActorSelector; readonly card: CardSelector; readonly statusDefinitionId: string }
  | { readonly type: "count-new-matching-cards"; readonly target: ActorSelector; readonly recordTarget: ActorSelector; readonly recordStatusDefinitionId: string; readonly statusDefinitionId: string }
  | { readonly type: "set-pending-ai-action"; readonly target: ActorSelector; readonly action: "hit" | "stand" }
  | { readonly type: "redeal-initial-hand"; readonly target: ActorSelector }
  | { readonly type: "skip-turn"; readonly target: ActorSelector }
  | { readonly type: "add-to-pending-ai-threshold"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-opening-skill-cards" | "add-skill-draw-refreshes"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-skill-draws"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "reveal-draw-pile-top-suit"; readonly viewer: ActorSelector }
  | { readonly type: "publish-hit-bust-forecast"; readonly target: ActorSelector }
  | { readonly type: "publish-hand-total-comparison"; readonly target: ActorSelector }
  | { readonly type: "replace-hand-card"; readonly target: ActorSelector; readonly card: CardSelector; readonly source: CardZoneSource; readonly candidate: CardCandidate; readonly pick: RandomPick }
  | { readonly type: "swap-last-hand-card-with-draw-pile-top"; readonly target: ActorSelector }
  | { readonly type: "discard-hand-card"; readonly target: ActorSelector; readonly card: CardSelector }
  | { readonly type: "move-hand-card-to-draw-pile"; readonly target: ActorSelector; readonly card: CardSelector; readonly position: "top" | "bottom" }
  | { readonly type: "transfer-last-hit-card-instead-of-draw"; readonly from: ActorSelector; readonly target: ActorSelector }
  | { readonly type: "reveal-hand-card-suit"; readonly target: ActorSelector; readonly card: "first-private-card" | "all-current-cards"; readonly viewer: ActorSelector }
  | { readonly type: "add-status"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly parameters?: Readonly<Record<string, string | number | boolean>> }
  | { readonly type: "set-status-stacks"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly amount: ScalarValue }
  | { readonly type: "remove-status"; readonly target: ActorSelector; readonly statusDefinitionId: string; readonly amount?: ScalarValue }
  | { readonly type: "replace-pending-draw"; readonly target: ActorSelector; readonly policy: DrawReplacementPolicy }
  | { readonly type: "replace-hand-card-with-derived"; readonly target: ActorSelector; readonly card: CardSelector; readonly rank: DerivedCardRankExpression; readonly suit: DerivedCardSuitExpression; readonly reportResult?: boolean }
  | { readonly type: "add-hand-card-tag" | "remove-hand-card-tag"; readonly target: ActorSelector; readonly card: CardSelector; readonly tag: string }
  | { readonly type: "rotate-draw-pile-top-to-bottom" }
  | { readonly type: "add-to-pending-bust-limit"; readonly target: ActorSelector; readonly amount: ScalarValue; readonly allowDecrease?: boolean }
  | { readonly type: "add-to-pending-trigger-misfire-chance"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-to-pending-load"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "set-pending-load"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "multiply-pending-load"; readonly target: ActorSelector; readonly factor: ScalarValue }
  | { readonly type: "remove-gun-bullets"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-gun-bullets"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "add-to-pending-comparison-score"; readonly target: ActorSelector; readonly amount: ScalarValue }
  | { readonly type: "cancel-pending-trigger"; readonly target: ActorSelector };

export interface AbilityParameterSpec { readonly type: "number" | "boolean" | "enum"; readonly minimum?: number; readonly maximum?: number; readonly values?: readonly string[]; readonly default?: number | boolean | string; }
export interface AbilityBinding { readonly level?: number; readonly definitionId: string; readonly enabled: boolean; readonly parameters: Readonly<Record<string, string | number | boolean>>; }
export interface AbilitySource { readonly level?: number; readonly kind: AbilitySourceKind; readonly definitionId: string; readonly owner: AbilityActor; readonly instanceId: string; }
export interface SkillCardInstance extends AbilitySource { readonly kind: "player-skill"; }
export interface AbilityInstance extends AbilitySource { readonly intrinsic?: boolean; readonly createdAtSequence: number; readonly parameters: Readonly<Record<string, string | number | boolean>>; readonly ttl?: AbilityInstanceTtl; readonly remainingUses?: number; }
export interface RuleLimit { readonly perEvent?: number; readonly perTurn?: number; readonly perRound?: number; readonly perMatch?: number; }
export interface AbilityRule { readonly id: string; readonly trigger: AbilityBroadcastTrigger; readonly priority?: number; readonly notify?: boolean; readonly chance?: number; readonly triggerNotice?: string; readonly notice?: { readonly value: ValueExpression; readonly prefix?: string; readonly suffix?: string; readonly format?: "text" | "suit-name" }; readonly conditions?: readonly Condition[]; readonly effects: readonly Effect[]; readonly limit?: RuleLimit; }
export type AbilityActivation =
  | { readonly type: "action"; readonly windows: readonly ActionWindow[]; readonly consume: "card" | "none"; readonly uses?: number; readonly availability?: readonly Condition[] }
  | { readonly type: "automatic" } | { readonly type: "passive" };
interface AbilityDefinitionBase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly metadataLabels?: readonly string[];
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
  /** Base fields describe Lv1; higher levels replace only explicitly declared fields. */
  readonly levels?: readonly AbilityLevel[];
}
export type AbilityLevel = { readonly level: number } & Partial<Pick<AbilityDefinitionBase, "description" | "usage" | "metadataLabels" | "profileLore" | "triggerNotice" | "parameters" | "activation" | "ttl" | "rules" | "displays">>;
export interface PlayerSkillAbilityDefinition extends AbilityDefinitionBase {
  readonly sourceKind: "player-skill";
  /** Definition-wide acquisition budget, retained after consumption or expiry. */
  readonly acquisitionLimit?: { readonly perMatch: number };
  /** Player-side draw extension; AI Skills cannot declare weight modifiers. */
  readonly skillDrawWeightModifiers?: readonly SkillDrawWeightModifier[];
  readonly drop: { readonly enabled: boolean; readonly baseWeight: number };
  /** Only passive skills consult this flag; active cards may always be duplicated. */
  readonly stackable: boolean;
  readonly unlock?: { readonly opponentId: string; readonly label: string };
  readonly skillTags: readonly SkillTag[];
}
export interface AiSkillAbilityDefinition extends AbilityDefinitionBase { readonly sourceKind: "ai-skill"; }
export interface TalentAbilityDefinition extends AbilityDefinitionBase {
  readonly sourceKind: "talent";
  readonly skillDrawWeightModifiers?: readonly SkillDrawWeightModifier[];
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
  readonly lastPlayedPlayerSkillLevel?: number;
}

export interface PendingDraw { readonly id: string; readonly actor: AbilityActor; readonly card?: Card; readonly replacement?: Card; readonly cancelled?: boolean; readonly standAfterDraw?: boolean; }
export interface PendingTurn { readonly id: string; readonly actor: AbilityActor; readonly canSkip: boolean; readonly skipped?: boolean; readonly skipSourceInstanceId?: string; }
export interface PendingAiThreshold { readonly id: string; readonly actor: AbilityActor; readonly bySkill: number; readonly actionOverride?: { readonly action: "hit" | "stand"; readonly sourceInstanceId: string }; }
export interface PendingLoad { readonly id: string; readonly actor: AbilityActor; readonly amount: number; readonly reason: "blackjack" | "bust" | "comparison" | "push"; }
export interface PendingBustCheck { readonly id: string; readonly actor: AbilityActor; readonly limit: number; readonly standAfterReplacement?: boolean; }
export interface PendingTrigger { readonly id: string; readonly actor: AbilityActor; readonly misfireChance?: number; readonly cancelled?: boolean; readonly cancelSourceInstanceId?: string; }
export interface PendingDefeat { readonly id: string; readonly actor: AbilityActor; readonly prevented?: boolean; readonly preventSourceInstanceId?: string; }
export interface AbilityTriggerResult { readonly actor: AbilityActor; readonly result: "fired" | "empty-chamber" | "misfire"; readonly fired: boolean; }
export interface PendingComparison { readonly id: string; readonly scores: Readonly<Record<AbilityActor, number>>; readonly baseScores?: Readonly<Record<AbilityActor, number>>; }
export interface AbilityEventContext { readonly triggerResult?: AbilityTriggerResult; readonly statusOwner?: AbilityActor; readonly pendingDefeat?: PendingDefeat; readonly pendingComparison?: PendingComparison; readonly lastHitCardIds?: Readonly<Partial<Record<AbilityActor, string>>>; readonly roundHadBust?: boolean; readonly acquiredCards?: readonly Card[]; readonly trigger: AbilityTrigger | "after-ability-played"; readonly sourceEventId: string; readonly eventActor?: AbilityActor; readonly playedAbilityKind?: AbilitySourceKind; readonly roundHitCounts?: Readonly<Record<AbilityActor, number>>; readonly initialHandCardCounts?: Readonly<Record<AbilityActor, number>>; readonly roundOutcome?: { readonly reason: "blackjack" | "bust" | "comparison" | "push"; readonly penaltyTarget: AbilityActor | null; readonly comparisonScores?: Readonly<Record<AbilityActor, number>>; readonly pointAdvantages?: Readonly<Record<AbilityActor, number>> }; readonly pendingTurn?: PendingTurn; readonly pendingAiThreshold?: PendingAiThreshold; readonly pendingDraw?: PendingDraw; readonly pendingLoad?: PendingLoad; readonly pendingBust?: PendingBustCheck; readonly pendingTrigger?: PendingTrigger; }

export interface AbilityWorld {
  readonly skillAcquisitionCounts?: Readonly<Record<string, number>>;
  readonly currentRoundPointAdvantages?: Readonly<Record<AbilityActor, number>>;
  readonly previousRoundPointAdvantages?: Readonly<Record<AbilityActor, number>>;
  /** Globally face-up card identities for this round; separate from private owner knowledge. */
  readonly publicCardIds?: readonly string[]; readonly hands: Readonly<Record<AbilityActor, Hand>>; readonly guns: Readonly<Record<AbilityActor, GunState>>; readonly shoe: ShoeState; readonly cards: readonly SkillCardInstance[]; readonly skillDraws: number; readonly openingSkillCardCount?: number; readonly skillDrawRefreshes?: number; readonly statuses: readonly AbilityStatus[];
  /** Match-supplied turn state; required only for immediate forced standing. */
  readonly stood?: Readonly<Record<AbilityActor, boolean>>;
}
export interface AbilityEffectResult { readonly gainedAbilities?: readonly AbilityInstance[]; readonly pendingDefeat?: PendingDefeat; readonly acquiredCards?: readonly { readonly actor: AbilityActor; readonly card: Card }[]; readonly world: AbilityWorld; readonly pendingTurn?: PendingTurn; readonly pendingAiThreshold?: PendingAiThreshold; readonly pendingDraw?: PendingDraw; readonly pendingLoad?: PendingLoad; readonly pendingBust?: PendingBustCheck; readonly pendingTrigger?: PendingTrigger; readonly pendingComparison?: PendingComparison; readonly runtime: AbilityRuntimeState; readonly events: readonly AbilityDomainEvent[]; }
export type AbilityDomainEvent =
  | { readonly type: "SKILL_CARDS_REMOVED"; readonly actor: AbilityActor; readonly sourceInstanceId: string; readonly cards: readonly SkillCardInstance[] }
  | { readonly type: "CARD_REVEALED"; readonly target: AbilityActor; readonly cardId: string }
  | { readonly type: "ABILITY_PLAYED"; readonly level?: number; readonly instanceId: string; readonly definitionId: string; readonly owner: AbilityActor }
  | { readonly type: "ABILITY_TRIGGERED"; readonly level?: number; readonly instanceId: string; readonly definitionId: string; readonly ruleId: string; readonly owner: AbilityActor }
  | { readonly type: "ABILITY_EXPIRED"; readonly level?: number; readonly instanceId: string; readonly definitionId: string; readonly owner: AbilityActor; readonly reason: "rounds" | "triggers" }
  | { readonly type: "ABILITY_RESOLUTION_FAILED"; readonly instanceId: string; readonly definitionId: string; readonly ruleId: string; readonly reason: string }
  | { readonly type: "STATUS_ADDED"; readonly statusDefinitionId: string; readonly owner: AbilityActor; readonly sourceInstanceId: string }
  | { readonly type: "STATUS_REMOVED"; readonly statusDefinitionId: string; readonly owner: AbilityActor; readonly reason: "consumed" | "expired" | "dispelled" }
  | { readonly type: "PENDING_EVENT_MODIFIED"; readonly eventId: string; readonly effectType: string; readonly sourceInstanceId: string }
  | { readonly type: "PENDING_EVENT_CANCELLED"; readonly eventId: string; readonly sourceInstanceId: string }
  | { readonly type: "HAND_CARD_DISCARDED"; readonly actor: AbilityActor; readonly cardId: string }
  | { readonly type: "HAND_REDEALT"; readonly actor: AbilityActor; readonly discardedCardIds: readonly string[] }
  | { readonly type: "CARD_DEALT"; readonly actor: AbilityActor; readonly card: Card; readonly private: boolean }
  | { readonly type: "CARD_SUIT_REVEALED"; readonly viewer: AbilityActor; readonly target: AbilityActor; readonly cardId: string; readonly suit: Suit }
  | { readonly type: "DRAW_PILE_CARD_SUIT_REVEALED"; readonly viewer: AbilityActor; readonly cardId: string; readonly suit: Suit }
  | { readonly type: "DRAW_PILE_CARD_REVEALED"; readonly viewer: AbilityActor; readonly cardId: string; readonly rank: Rank; readonly suit: Suit }
  | { readonly type: "SKILL_GAINED"; readonly skillId: string }
  | { readonly type: "ABILITY_RESULT"; readonly level?: number; readonly instanceId: string; readonly definitionId: string; readonly owner: AbilityActor; readonly result:
      | { readonly type: "derived-card-added"; readonly actor: AbilityActor; readonly rank: Rank; readonly suit: Suit }
      | { readonly type: "derived-card-replaced"; readonly actor: AbilityActor; readonly oldRank: Rank; readonly rank: Rank; readonly suit: Suit }
      | { readonly type: "status-stacks-updated"; readonly actor: AbilityActor; readonly statusDefinitionId: string; readonly stacks: number; readonly delta: number }
      | { readonly type: "skill-card-granted"; readonly definitionId: string }
      | { readonly type: "hit-bust-forecast"; readonly actor: AbilityActor; readonly wouldBust: boolean }
      | { readonly type: "hand-total-compared"; readonly actor: AbilityActor; readonly relation: "higher" | "equal" | "lower" }
      | { readonly type: "gun-bullets-added"; readonly actor: AbilityActor; readonly amount: number; readonly bullets: number }
      | { readonly type: "draw-pile-rotated" } };
export type AbilityEvent = AbilityDomainEvent;
