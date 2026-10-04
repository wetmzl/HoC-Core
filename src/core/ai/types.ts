import type { Card } from "../blackjack/types";

export type AiAction = "hit" | "stand";

export interface AiProfile {
  /** Fixed threshold offset. */
  readonly P: number;
  /** Weight applied to 0.1 * (player bullets - opponent bullets). */
  readonly A: number;
  /** Match-long noise weight. */
  readonly B: number;
  /** Current-hand noise weight. */
  readonly C: number;
}

export const DEFAULT_AI_PROFILE: AiProfile = {
  P: 0,
  A: 1,
  B: 1,
  C: 1
};

export interface AiNoiseState {
  /** Rmatch, sampled once when the match is created. */
  readonly match: number;
  /** Rplay, sampled once when the current hand is created. */
  readonly play: number;
}

export interface ObservedParticipant {
  readonly cards: readonly (Card | null)[];
  readonly stood: boolean;
  readonly busted: boolean;
  readonly value: number | null;
}

export interface MatchObservation {
  readonly viewer: "player" | "opponent";
  readonly roundIndex: number;
  readonly phase: string;
  readonly currentActor: "player" | "opponent" | null;
  readonly player: ObservedParticipant;
  readonly opponent: ObservedParticipant;
  readonly shoeRemaining: number;
  readonly roulette: {
    readonly playerBullets: number;
    readonly opponentBullets: number;
    readonly capacity: number;
  };
}

export interface AiDecision {
  readonly handValue: number;
  readonly threshold: number;
  /** Event-scoped threshold modifier composed by the ability system. */
  readonly bySkill: number;
  readonly bulletDifference: number;
  readonly matchNoise: number;
  readonly playNoise: number;
  readonly action: AiAction;
  readonly actionOverride?: { readonly action: AiAction; readonly sourceInstanceId: string };
}
