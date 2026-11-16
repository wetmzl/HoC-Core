import type { MatchState } from "../core/match/types";
import { isBlackjack } from "../core/blackjack/hand";
import type { MatchTransition } from "../runtime/match-transition";
import type { MatchFactBatch } from "../core/events";
import { awaitsTrigger, selectMatchAudio, selectMatchAudioFacts, type AudioCommand } from "./match-audio-policy";
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

export function presentMatchAudioTransition(audio: MatchAudioPort, transition: Pick<MatchTransition, "before" | "after" | "events">): void {
  presentCommands(audio, selectMatchAudio(transition));
}

export function presentMatchAudioFacts(audio: MatchAudioPort, batch: MatchFactBatch): void {
  presentCommands(audio, selectMatchAudioFacts(batch));
}

function presentCommands(audio: MatchAudioPort, commands: readonly AudioCommand[]): void {
  for (const command of commands) {
    if (command.type === "play") audio.play(command.cue, command.delayMs);
    else if (command.active) audio.startHeartbeat();
    else audio.stopHeartbeat();
  }
}

/** Compatibility adapter for callers with two snapshots. */
export function presentMatchAudio(audio: MatchAudioPort, before: MatchState, after: MatchState): void {
  presentMatchAudioTransition(audio, { before, after, events: after.history.slice(before.history.length) });
}
