import type { MatchState, RoundOutcome } from "../core/match/types";
import { isBlackjack } from "../core/blackjack/hand";
import type { MatchTransition } from "../runtime/match-transition";
import type { SoundCue } from "./sound-resources";

export type AudioCommand =
  | { readonly type: "play"; readonly cue: Exclude<SoundCue, "heartbeat">; readonly delayMs: number }
  | { readonly type: "heartbeat"; readonly active: boolean };

export function awaitsTrigger(state: MatchState): boolean {
  return state.status === "active" && state.scene === "match" && state.view === "table"
    && (state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger");
}

/** Hand shape and modified bullet amounts never select a round-result cue. */
export function roundResultCue(outcome: RoundOutcome): "blackjack" | "bust" | "compare" | null {
  if (outcome.winner === null) return null;
  if (outcome.reason === "blackjack") return "blackjack";
  return outcome.winner === "player" ? "compare" : "bust";
}

/** Pure policy: no playback, timers, state mutation or history restoration. */
export function selectMatchAudio({ before, after, events }: MatchTransition): readonly AudioCommand[] {
  const commands: AudioCommand[] = [];
  const play = (cue: Exclude<SoundCue, "heartbeat">, delayMs = 0) => commands.push({ type: "play", cue, delayMs });
  const trigger = events.find(event => event.type === "TRIGGER_PULLED");
  if (trigger?.type === "TRIGGER_PULLED") {
    commands.push({ type: "heartbeat", active: false });
    play(trigger.result === "fired" ? "gunshot" : trigger.result === "misfire" ? "misfire" : "dryFire");
    return commands;
  }
  const types = new Set(events.map(event => event.type));
  const hit = types.has("PLAYER_HIT") || types.has("OPPONENT_HIT");
  const manualStand = (types.has("PLAYER_STOOD") && !types.has("PLAYER_HIT"))
    || (types.has("OPPONENT_STOOD") && !types.has("OPPONENT_HIT"));
  if (types.has("ROUND_RESULT_ACKNOWLEDGED")) play("stand");
  if (types.has("SKILL_DRAW_OPENED") || types.has("SKILL_DRAW_REFRESHED")) play("skillDraw");
  if (types.has("SKILL_DRAW_RESOLVED")) play("skillAcquire");
  if (events.some(event => event.type === "ABILITY_PLAYED" && event.owner === "player")) play("skillUse");
  if (types.has("ROUND_STARTED")) play("shuffle", types.has("ROUND_RESULT_ACKNOWLEDGED") ? 220 : 0);
  if (hit) play("cardFlip");
  if (manualStand) play("stand");
  // Reward a newly acquired player hand, including ability changes and new rounds.
  // Hidden opponent hands and settlement-only BLACKJACK events stay silent.
  if (after.status === "active" && after.scene === "match" && after.view === "table"
    && isBlackjack(after.player.hand)
    && (after.roundIndex !== before.roundIndex || !isBlackjack(before.player.hand))) {
    play("naturalBlackjack", types.has("ROUND_STARTED") ? (types.has("ROUND_RESULT_ACKNOWLEDGED") ? 380 : 160) : hit ? 160 : 0);
  }
  const resolved = [...events].reverse().find(event => event.type === "ROUND_RESOLVED");
  if (resolved?.type === "ROUND_RESOLVED" && after.round.phase === "round-reveal") {
    const cue = roundResultCue(resolved.outcome);
    if (cue) play(cue, hit || manualStand ? 160 : 0);
  }
  if (before.view !== "match-summary" && after.view === "match-summary") play("result");
  if (awaitsTrigger(before) !== awaitsTrigger(after)) commands.push({ type: "heartbeat", active: awaitsTrigger(after) });
  return commands;
}
