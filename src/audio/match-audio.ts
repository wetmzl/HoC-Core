import type { MatchState } from "../core/match/types";
import type { SoundCue } from "./game-audio";

export interface MatchAudioPort {
  play(cue: Exclude<SoundCue, "heartbeat">, delayMs?: number): void;
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

const FOLLOW_UP_CUE_DELAY_MS = 160;
const CONFIRMED_PUSH_SHUFFLE_DELAY_MS = 220;

function awaitsTrigger(state: MatchState): boolean {
  return state.status === "active"
    && state.scene === "match"
    && state.view === "table"
    && (
      state.round.phase === "roulette-reaction"
      || state.round.phase === "roulette-trigger"
    );
}

/** Restores continuous audio correctly when loading or resuming an existing table. */
export function syncMatchAudioState(audio: MatchAudioPort, state: MatchState): void {
  if (awaitsTrigger(state)) audio.startHeartbeat();
  else audio.stopHeartbeat();
}

/** Plays cues already present in a brand-new match state. */
export function presentOpeningMatchAudio(audio: MatchAudioPort, state: MatchState): void {
  if (state.history.some((event) => event.type === "BLACKJACK")) audio.play("blackjack", FOLLOW_UP_CUE_DELAY_MS);
}

/** Maps newly emitted domain events to presentation audio without coupling the reducer to audio. */
export function presentMatchAudio(audio: MatchAudioPort, before: MatchState, after: MatchState): void {
  const events = after.history.slice(before.history.length);
  const trigger = events.find((event) => event.type === "TRIGGER_PULLED");
  if (trigger?.type === "TRIGGER_PULLED") {
    audio.stopHeartbeat();
    audio.play(trigger.result === "fired" ? "gunshot" : trigger.result === "misfire" ? "misfire" : "dryFire");
    return;
  }

  const roundStarted = events.some((event) => event.type === "ROUND_STARTED");
  const resultAcknowledged = events.some((event) => event.type === "ROUND_RESULT_ACKNOWLEDGED");
  const skillDrawOpened = events.some((event) => event.type === "SKILL_DRAW_OPENED");
  const playerAbilityPlayed = events.some((event) => event.type === "ABILITY_PLAYED" && event.owner === "player");
  const playerHit = events.some((event) => event.type === "PLAYER_HIT");
  const opponentHit = events.some((event) => event.type === "OPPONENT_HIT");
  const hit = playerHit || opponentHit;
  const manualStand = (events.some((event) => event.type === "PLAYER_STOOD") && !playerHit)
    || (events.some((event) => event.type === "OPPONENT_STOOD") && !opponentHit);

  if (resultAcknowledged) audio.play("stand");
  if (skillDrawOpened) audio.play("skillDraw");
  if (playerAbilityPlayed) audio.play("skillUse");
  if (roundStarted) audio.play("shuffle", resultAcknowledged ? CONFIRMED_PUSH_SHUFFLE_DELAY_MS : 0);
  if (hit) audio.play("cardFlip");
  if (manualStand) audio.play("stand");
  if (events.some((event) => event.type === "BLACKJACK")) audio.play("blackjack", roundStarted ? FOLLOW_UP_CUE_DELAY_MS : 0);
  if (events.some((event) => event.type === "BUST")) audio.play("bust", hit ? FOLLOW_UP_CUE_DELAY_MS : 0);
  if (events.some((event) => event.type === "ROUND_RESOLVED" && event.outcome.reason === "comparison"))
    audio.play("compare", manualStand ? FOLLOW_UP_CUE_DELAY_MS : 0);
  if (before.view !== "match-summary" && after.view === "match-summary") audio.play("result");

  const wasWaiting = awaitsTrigger(before);
  const isWaiting = awaitsTrigger(after);
  if (!wasWaiting && isWaiting) audio.startHeartbeat();
  else if (wasWaiting && !isWaiting) audio.stopHeartbeat();
}
