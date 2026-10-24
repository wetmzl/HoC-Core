import type { MatchState } from "../core/match/types";
import type { CharacterDialogue, DialogueSelection } from "./types";
import { DialogueEngine } from "./engine";

// A restoration query, cached per immutable snapshot. Live tables use DialogueSession.peek().
const restored = new WeakMap<MatchState, WeakMap<CharacterDialogue, DialogueSelection>>();
export function resolveDialogueState(state: MatchState, dialogue: CharacterDialogue) {
  let programs = restored.get(state); if (!programs) { programs = new WeakMap(); restored.set(state, programs); }
  let value = programs.get(dialogue); if (!value) { value = new DialogueEngine(dialogue, state.opponentId).select(state); programs.set(dialogue, value); } return value;
}
export function resolveDialogueLine(state: MatchState, dialogue: CharacterDialogue): string { return resolveDialogueState(state, dialogue).line; }
