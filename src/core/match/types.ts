import type { AiDecision, AiNoiseState, AiProfile } from "../ai/types";
import type { Card, Hand, Rank, ShoeState, RoundStarter, Suit } from "../blackjack/types";
import type { RngSnapshot } from "../rng/seeded";
import type { RouletteState } from "../roulette/types";
import type { PlayerSkillInventory } from "../skills/types";
import type { AbilityRuntimeState } from "../abilities/types";

export type AppScene = "lobby" | "match";
export type MatchView = "table" | "execution-room" | "match-summary";
export type RoundPhase = "dealing" | "initial-blackjack-check" | "turns" | "settlement" | "round-reveal" | "roulette-reaction" | "roulette-trigger" | "roulette-result" | "round-end";
/** Narrative mapping: player is the Curator; opponent is the invited attendee. */
export type Actor = "player" | "opponent";

export interface ParticipantState {
  readonly id: Actor;
  readonly hand: Hand;
  readonly stood: boolean;
  readonly busted: boolean;
  /** Last bust threshold checked for this hand; omitted for ordinary hands. */
  readonly bustLimit?: number;
}

export type RoundReason = "blackjack" | "bust" | "comparison" | "push";
export interface RoundOutcome {
  readonly winner: Actor | null;
  readonly reason: RoundReason;
  readonly penaltyTarget: Actor | null;
  readonly bulletsAdded: number;
  /** Final totals used by point comparison, after all score modifiers. */
  readonly comparisonScores?: Readonly<Record<Actor, number>>;
}

export interface RoundState {
  readonly index: number;
  readonly phase: RoundPhase;
  readonly starter: RoundStarter;
  readonly currentActor: Actor | null;
  readonly player: ParticipantState;
  readonly opponent: ParticipantState;
  readonly outcome: RoundOutcome | null;
}

/**
 * Compatibility identifiers: player-killed means the Curator fired at the
 * ceiling and lost this timeline; opponent-killed is the attendee's death.
 */
export type MatchEndReason = "player-killed" | "opponent-killed" | "escaped";
export interface MatchOutcome {
  readonly winner: Actor | null;
  readonly reason: MatchEndReason;
}

export interface MatchRngState {
  readonly deck: RngSnapshot;
  readonly roulette: RngSnapshot;
  readonly ai: RngSnapshot;
  readonly loot: RngSnapshot;
  readonly dialogue: RngSnapshot;
}

export type GameEvent =
  | { readonly type: "ABILITY_PLAYED"; readonly instanceId: string; readonly definitionId: string; readonly owner: Actor }
  | { readonly type: "ABILITY_TRIGGERED"; readonly instanceId: string; readonly definitionId: string; readonly ruleId: string; readonly owner: Actor }
  | { readonly type: "ABILITY_EXPIRED"; readonly instanceId: string; readonly definitionId: string; readonly owner: Actor; readonly reason: "rounds" | "triggers" }
  | { readonly type: "ABILITY_RESOLUTION_FAILED"; readonly instanceId: string; readonly definitionId: string; readonly ruleId: string; readonly reason: string }
  | { readonly type: "STATUS_ADDED"; readonly statusDefinitionId: string; readonly owner: Actor; readonly sourceInstanceId: string }
  | { readonly type: "STATUS_REMOVED"; readonly statusDefinitionId: string; readonly owner: Actor; readonly reason: "consumed" | "expired" | "dispelled" }
  | { readonly type: "PENDING_EVENT_MODIFIED"; readonly eventId: string; readonly effectType: string; readonly sourceInstanceId: string }
  | { readonly type: "PENDING_EVENT_CANCELLED"; readonly eventId: string; readonly sourceInstanceId: string }
  | { readonly type: "HAND_REDEALT"; readonly actor: Actor; readonly discardedCardIds: readonly string[] }
  | { readonly type: "CARD_SUIT_REVEALED"; readonly viewer: Actor; readonly target: Actor; readonly cardId: string; readonly suit: Suit }
  | { readonly type: "DRAW_PILE_CARD_SUIT_REVEALED"; readonly viewer: Actor; readonly cardId: string; readonly suit: Suit }
  | { readonly type: "DRAW_PILE_CARD_REVEALED"; readonly viewer: Actor; readonly cardId: string; readonly rank: Rank; readonly suit: Suit }
  | { readonly type: "ABILITY_RESULT"; readonly instanceId: string; readonly definitionId: string; readonly owner: Actor; readonly result:
      | { readonly type: "derived-card-added"; readonly actor: Actor; readonly rank: Rank; readonly suit: Suit }
      | { readonly type: "derived-card-replaced"; readonly actor: Actor; readonly oldRank: Rank; readonly rank: Rank; readonly suit: Suit }
      | { readonly type: "status-stacks-updated"; readonly actor: Actor; readonly statusDefinitionId: string; readonly stacks: number; readonly delta: number }
      | { readonly type: "skill-card-granted"; readonly definitionId: string }
      | { readonly type: "hit-bust-forecast"; readonly actor: Actor; readonly wouldBust: boolean }
      | { readonly type: "hand-total-compared"; readonly actor: Actor; readonly relation: "higher" | "equal" | "lower" }
      | { readonly type: "gun-bullets-added"; readonly actor: Actor; readonly amount: number; readonly bullets: number }
      | { readonly type: "draw-pile-rotated" } }
  | { readonly type: "ROUND_STARTED"; readonly roundIndex: number }
  | { readonly type: "CARD_DEALT"; readonly actor: Actor; readonly card: Card; readonly private: boolean }
  | { readonly type: "INITIAL_BLACKJACK_CHECK"; readonly player: boolean; readonly opponent: boolean }
  | { readonly type: "TURN_SKIPPED"; readonly actor: Actor; readonly sourceInstanceId: string }
  | { readonly type: "PLAYER_HIT" | "OPPONENT_HIT"; readonly value: number }
  | { readonly type: "PLAYER_STOOD" | "OPPONENT_STOOD" }
  | { readonly type: "BLACKJACK"; readonly actor: Actor }
  | { readonly type: "BUST"; readonly actor: Actor }
  | { readonly type: "ROUND_RESOLVED"; readonly outcome: RoundOutcome }
  | { readonly type: "ROUND_RESULT_ACKNOWLEDGED" }
  | { readonly type: "BULLET_ADDED"; readonly actor: Actor; readonly amount: number }
  | { readonly type: "TRIGGER_PULLED"; readonly actor: Actor; readonly probability: number; readonly baseProbability: number; readonly misfireChance: number; readonly result: "fired" | "empty-chamber" | "misfire"; readonly fired: boolean }
  | { readonly type: "TRIGGER_SURVIVED"; readonly actor: Actor }
  | { readonly type: "TRIGGER_RESULT_ACKNOWLEDGED" }
  /** Compatibility event name; actor=player never means the Curator physically dies. */
  | { readonly type: "PARTICIPANT_KILLED"; readonly actor: Actor }
  | { readonly type: "SKILL_GAINED"; readonly skillId: string }
  | { readonly type: "SKILL_DRAWS_ADDED"; readonly reason: "blackjack" | "win" | "loss" | "push"; readonly amount: number }
  | { readonly type: "SKILL_DRAW_OPENED"; readonly offerId: string; readonly candidateDefinitionIds: readonly string[] }
  | { readonly type: "SKILL_DRAW_RESOLVED"; readonly offerId: string; readonly selectedDefinitionId: string }
  | { readonly type: "MATCH_FINISHED"; readonly reason: MatchEndReason }
  | { readonly type: "MATCH_ESCAPED" }
  | { readonly type: "MATCH_RESULT_ACKNOWLEDGED" }
  | { readonly type: "AI_DECISION"; readonly decision: AiDecision };

export type Action =
  | { readonly type: "PLAYER_HIT" }
  | { readonly type: "PLAYER_STAND" }
  | { readonly type: "AI_TURN" }
  | { readonly type: "AI_HIT" | "OPPONENT_HIT" }
  | { readonly type: "AI_STAND" | "OPPONENT_STAND" }
  | { readonly type: "PLAY_ABILITY"; readonly instanceId: string; readonly selections?: Readonly<Record<string, string | number>> }
  | { readonly type: "OPEN_SKILL_DRAW" }
  | { readonly type: "SELECT_SKILL_DRAW"; readonly definitionId: string }
  | { readonly type: "TRIGGER_ROULETTE" }
  | { readonly type: "ACK_ROUND_RESULT" }
  | { readonly type: "ACK_TRIGGER_RESULT" }
  | { readonly type: "CONTINUE_ROUND" }
  | { readonly type: "ESCAPE_MATCH" }
  | { readonly type: "ACK_MATCH_RESULT" };

export interface MatchState {
  readonly id: string;
  readonly seed: string;
  readonly opponentId: string;
  readonly status: "active" | "finished";
  readonly scene: AppScene;
  readonly view: MatchView;
  readonly roundIndex: number;
  readonly player: ParticipantState;
  readonly opponent: ParticipantState;
  readonly shoe: ShoeState;
  readonly roulette: RouletteState;
  readonly playerSkills: PlayerSkillInventory;
  readonly talentIds: readonly string[];
  /** Declarative execution runtime shared by the three independent ability domains. */
  readonly abilities: AbilityRuntimeState;
  readonly round: RoundState;
  readonly outcome?: MatchOutcome;
  readonly history: readonly GameEvent[];
  readonly rng: MatchRngState;
  readonly aiProfile: AiProfile;
  readonly aiNoise: AiNoiseState;
  readonly lastAiDecision: AiDecision | null;
}
