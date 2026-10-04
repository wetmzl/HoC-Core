import { handValue } from "../blackjack/hand";
import type { Card } from "../blackjack/types";
import type { AiAction, AiDecision, AiNoiseState, AiProfile, MatchObservation } from "./types";
import type { SeededRng } from "../rng/seeded";

export const AI_NOISE_MIN = -0.3;
export const AI_NOISE_MAX = 0.3;

/** Baseline Hit/Stand advice used by the player's action-advice ability. */
export function decideOptimalAction(observation: MatchObservation): AiAction {
  const side = observation.viewer === "player" ? observation.player : observation.opponent;
  const knownCards = side.cards.filter((card): card is Card => card !== null);
  if (knownCards.length === 0) return "stand";
  return handValue({ cards: knownCards }) < 17 ? "hit" : "stand";
}

/** Samples Rmatch or Rplay in [-0.3, 0.3). */
export function sampleAiNoise(rng: SeededRng): number {
  return AI_NOISE_MIN + rng.next() * (AI_NOISE_MAX - AI_NOISE_MIN);
}

function assertFiniteProfile(profile: AiProfile): void {
  if (![profile.P, profile.A, profile.B, profile.C].every(Number.isFinite)) {
    throw new RangeError("AI profile parameters must be finite numbers");
  }
}

function assertNoise(noise: AiNoiseState): void {
  if (![noise.match, noise.play].every((value) => Number.isFinite(value) && value >= AI_NOISE_MIN && value <= AI_NOISE_MAX)) {
    throw new RangeError("AI noise must be between -0.3 and 0.3");
  }
}

export function calculateAiThreshold(observation: MatchObservation, profile: AiProfile, noise: AiNoiseState, bySkill = 0): number {
  assertFiniteProfile(profile);
  assertNoise(noise);
  if (!Number.isFinite(bySkill)) throw new RangeError("AI skill threshold modifier must be finite");
  const bulletDifference = observation.roulette.playerBullets - observation.roulette.opponentBullets;
  return 16 + profile.P + 0.1 * profile.A * bulletDifference + profile.B * noise.match + profile.C * noise.play + bySkill;
}

export function decideAiAction(observation: MatchObservation, profile: AiProfile, noise: AiNoiseState, bySkill = 0): AiDecision {
  const side = observation.viewer === "player" ? observation.player : observation.opponent;
  const knownCards = side.cards.filter((card): card is Card => card !== null);
  const value = knownCards.length === 0 ? 0 : handValue({ cards: knownCards });
  const bulletDifference = observation.roulette.playerBullets - observation.roulette.opponentBullets;
  const threshold = calculateAiThreshold(observation, profile, noise, bySkill);
  return {
    handValue: value,
    threshold,
    bySkill,
    bulletDifference,
    matchNoise: noise.match,
    playNoise: noise.play,
    action: knownCards.length > 0 && value <= threshold ? "hit" : "stand"
  };
}
