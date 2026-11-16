import type { AbilitySourceKind, AbilityWorld, PendingComparison, PendingLoad } from "../abilities/types";
import type { Actor, GameEvent, MatchState } from "../match/types";

/** Internal observation contract; independent of saved GameEvent and plugin APIs. */
export const MATCH_FACT_API_VERSION = 1 as const;

/** Captured when an effect succeeds, before its source can expire or be removed. */
export interface MatchFactSource {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly owner: Actor;
  readonly level: number;
  readonly kind?: AbilitySourceKind;
  readonly ruleId?: string;
}

export interface MatchFactCause {
  readonly sourceEventId: string;
  readonly trigger: string;
}

/** Internal, immutable effect evidence. Never serialized into public event history. */
export interface MatchEffectFact {
  readonly type: string;
  readonly effect: import("../abilities/types").Effect;
  readonly events: readonly import("../abilities/types").AbilityDomainEvent[];
  readonly actor: Actor;
  readonly before: AbilityWorld;
  readonly after: AbilityWorld;
  readonly bustLimitsBefore: Readonly<Record<Actor, number>>;
  readonly bustLimitsAfter: Readonly<Record<Actor, number>>;
  readonly comparisonBefore?: PendingComparison;
  readonly comparisonAfter?: PendingComparison;
  readonly loadBefore?: PendingLoad;
  readonly loadAfter?: PendingLoad;
  readonly roundHitCounts?: Readonly<Record<Actor, number>>;
}

export interface MatchFactSnapshot {
  readonly world: AbilityWorld;
  readonly busted: Readonly<Record<Actor, boolean>>;
  readonly bustLimits: Readonly<Record<Actor, number>>;
  readonly outcome?: import("../match/types").MatchOutcome;
}
export interface MatchAbilityPlayFact {
  readonly before: AbilityWorld;
  readonly after: AbilityWorld;
  readonly usesBefore: number;
  readonly roundHitCounts?: Readonly<Record<Actor, number>>;
  readonly consumesCard: boolean;
  readonly primaryDomain: string;
}
interface MatchFactIdentity {
  readonly apiVersion: typeof MATCH_FACT_API_VERSION;
  readonly id: string;
  readonly matchId: string;
  /** Zero-based position in the unchanged match history. */
  readonly index: number;
  readonly roundIndex: number;
  readonly source?: MatchFactSource;
  readonly cause?: MatchFactCause;
  readonly effects?: readonly MatchEffectFact[];
  readonly snapshot?: MatchFactSnapshot;
  readonly play?: MatchAbilityPlayFact;
  readonly voluntaryStand?: boolean;
}

/** Immutable observation of an accepted domain result, not a mutable rule window. */
export type MatchFact = {
  [Type in GameEvent["type"]]: MatchFactIdentity & {
    readonly type: Type;
    readonly event: GameEvent & { readonly type: Type };
  }
}[GameEvent["type"]];

/** Accepted domain results are not necessarily durable until the owner saves them. */
export interface MatchFactBatch {
  readonly apiVersion: typeof MATCH_FACT_API_VERSION;
  readonly before: MatchState | undefined;
  readonly after: MatchState;
  readonly restored: boolean;
  /** Legacy payloads are preserved; each fact contains its own frozen copy. */
  readonly events: readonly GameEvent[];
  readonly facts: readonly MatchFact[];
  readonly fromIndex: number;
  /** End-exclusive history cursor. */
  readonly toIndex: number;
}

export interface MatchFactBatchOptions {
  /** Restoration advances the cursor without replaying historical occurrences. */
  readonly restored?: boolean;
}
