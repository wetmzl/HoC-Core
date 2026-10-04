import type { GameEvent, MatchState, RoundPhase } from "../core/match/types";
import { SeededRng } from "../core/rng/seeded";
import { roundOverrideDialogueEvent } from "./round-context";
import { chooseDialogue, type CharacterDialogue, type DialogueEvent } from "./types";

export interface ResolvedDialogueState {
  readonly event: DialogueEvent;
  /** Changes whenever a new action/result should restart the typewriter. */
  readonly key: string;
}

const actionTypes = new Set<GameEvent["type"]>([
  "PLAYER_HIT", "PLAYER_STOOD", "OPPONENT_HIT", "OPPONENT_STOOD"
]);

function lastIndex(state: MatchState, predicate: (event: GameEvent) => boolean): number {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const event = state.history[index];
    if (event && predicate(event)) return index;
  }
  return -1;
}

function resolved(event: DialogueEvent, phase: RoundPhase, sourceIndex: number): ResolvedDialogueState {
  return { event, key: `${phase}:${sourceIndex}:${event}` };
}

function roundResultDialogue(state: MatchState): DialogueEvent {
  const special = roundOverrideDialogueEvent(state);
  if (special) return special;
  const outcome = state.round.outcome;
  if (!outcome) return "MATCH_START";
  switch (outcome.reason) {
    case "blackjack": return outcome.winner === "player" ? "PLAYER_BLACKJACK" : "OPPONENT_BLACKJACK";
    case "bust": return outcome.penaltyTarget === "player" ? "PLAYER_BUST" : "OPPONENT_BUST";
    case "comparison": return outcome.winner === "player" ? "PLAYER_WIN_ROUND" : "OPPONENT_WIN_ROUND";
    case "push": return "PUSH_ROUND";
  }
}

function turnDialogue(state: MatchState, roundStartIndex: number): ResolvedDialogueState {
  const roundEvents = state.history.slice(roundStartIndex + 1);
  let latestActionOffset = -1;
  for (let index = roundEvents.length - 1; index >= 0; index -= 1) {
    if (roundEvents[index] && actionTypes.has(roundEvents[index]!.type)) { latestActionOffset = index; break; }
  }
  if (latestActionOffset < 0) return resolved("MATCH_START", state.round.phase, roundStartIndex);

  const sourceIndex = roundStartIndex + 1 + latestActionOffset;
  const latestAction = roundEvents[latestActionOffset]!;
  if (latestAction.type === "PLAYER_HIT") return resolved("PLAYER_HIT", state.round.phase, sourceIndex);
  if (latestAction.type === "PLAYER_STOOD") return resolved("PLAYER_STAND", state.round.phase, sourceIndex);

  const opponentActions = roundEvents.filter((event) => event.type === "OPPONENT_HIT" || event.type === "OPPONENT_STOOD");
  if (latestAction.type === "OPPONENT_STOOD" && opponentActions.length === 1)
    return resolved("OPPONENT_FIRST_STAND", state.round.phase, sourceIndex);
  if (latestAction.type === "OPPONENT_HIT") {
    const opponentHits = opponentActions.filter((event) => event.type === "OPPONENT_HIT").length;
    const playerStood = roundEvents.some((event) => event.type === "PLAYER_STOOD");
    if (opponentHits >= 2 && playerStood)
      return resolved("OPPONENT_REPEAT_HIT_AFTER_PLAYER_STAND", state.round.phase, sourceIndex);
    if (opponentActions.length === 1)
      return resolved("OPPONENT_FIRST_HIT", state.round.phase, sourceIndex);
  }

  // Later AI actions outside the three dedicated contexts retain the most
  // recent player intent instead of inventing an overlapping generic AI pool.
  let latestPlayerOffset = -1;
  for (let index = roundEvents.length - 1; index >= 0; index -= 1) {
    const type = roundEvents[index]?.type;
    if (type === "PLAYER_HIT" || type === "PLAYER_STOOD") { latestPlayerOffset = index; break; }
  }
  if (latestPlayerOffset >= 0) {
    const playerEvent = roundEvents[latestPlayerOffset]!;
    return resolved(playerEvent.type === "PLAYER_STOOD" ? "PLAYER_STAND" : "PLAYER_HIT", state.round.phase, roundStartIndex + 1 + latestPlayerOffset);
  }
  return resolved("MATCH_START", state.round.phase, roundStartIndex);
}

/**
 * Resolves exactly one dialogue pool for every renderable match phase.
 * Phase-specific states always win over historical actions, preventing a
 * generic ROUND_RESOLVED event from masking Blackjack, bust, or special hands.
 */
export function resolveDialogueState(state: MatchState): ResolvedDialogueState {
  const phase = state.round.phase;
  const roundStartIndex = lastIndex(state, (event) => event.type === "ROUND_STARTED");
  switch (phase) {
    case "roulette-trigger":
      return resolved("OPPONENT_TRIGGER_READY", phase, lastIndex(state, (event) => event.type === "ROUND_RESULT_ACKNOWLEDGED"));
    case "roulette-reaction":
      return resolved("PLAYER_TRIGGER_READY", phase, lastIndex(state, (event) => event.type === "ROUND_RESULT_ACKNOWLEDGED"));
    case "roulette-result": {
      const triggerIndex = lastIndex(state, (event) => event.type === "TRIGGER_PULLED");
      const trigger = state.history[triggerIndex];
      if (trigger?.type !== "TRIGGER_PULLED") return resolved("MATCH_START", phase, roundStartIndex);
      const event = trigger.fired
        ? trigger.actor === "player" ? "PLAYER_TRIGGER_HIT" : "OPPONENT_TRIGGER_HIT"
        : trigger.actor === "player" ? "PLAYER_SURVIVED_TRIGGER" : "OPPONENT_SURVIVED_TRIGGER";
      return resolved(event, phase, triggerIndex);
    }
    case "round-reveal":
      return resolved(roundResultDialogue(state), phase, lastIndex(state, (event) => event.type === "ROUND_RESOLVED"));
    case "turns":
      return turnDialogue(state, roundStartIndex);
    case "dealing":
    case "initial-blackjack-check":
    case "settlement":
    case "round-end":
      return resolved("MATCH_START", phase, roundStartIndex);
  }
}

/** Keeps one deterministic line attached to one dialogue-state key. Events
 * ignored by the state machine (including TURN_SKIPPED) cannot silently
 * reroll the line while the visible dialogue is meant to remain unchanged. */
export function resolveDialogueLine(state: MatchState, dialogue: CharacterDialogue): string | null {
  const resolvedState = resolveDialogueState(state);
  const rng = SeededRng.fromSnapshot(state.rng.dialogue).derive(resolvedState.key);
  return chooseDialogue(dialogue, resolvedState.event, rng).line;
}
