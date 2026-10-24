import type { MatchState } from "../core/match/types";
import { isBlackjack } from "../core/blackjack/hand";
import { createMatchTransition, type MatchTransition } from "../runtime/match-transition";
import { awaitsTrigger, selectMatchAudio } from "./match-audio-policy";
import type { SoundCue } from "./sound-resources";

export interface MatchAudioPort {
  play(cue: Exclude<SoundCue, "heartbeat">, delayMs?: number): void;
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

/** Restoration resumes continuous suspense; only a fresh match rewards its opening hand. */
export function syncMatchAudioState(audio: MatchAudioPort, state: MatchState, restored = true): void {
  if (awaitsTrigger(state)) audio.startHeartbeat();
  else audio.stopHeartbeat();
  if (!restored && state.status === "active" && state.scene === "match" && state.view === "table"
    && isBlackjack(state.player.hand)) audio.play("naturalBlackjack");
}

export function presentMatchAudioTransition(audio: MatchAudioPort, transition: MatchTransition): void {
  for (const command of selectMatchAudio(transition)) {
    if (command.type === "play") audio.play(command.cue, command.delayMs);
    else if (command.active) audio.startHeartbeat();
    else audio.stopHeartbeat();
  }
}

/** Compatibility adapter for callers with two snapshots. */
export function presentMatchAudio(audio: MatchAudioPort, before: MatchState, after: MatchState): void {
  presentMatchAudioTransition(audio, createMatchTransition(before, after));
}
