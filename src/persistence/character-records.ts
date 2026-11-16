import { z } from "zod";
import type { MatchState } from "../core/match/types";
import type { SaveCheckpointContext } from "./repository";
import { MatchHistoryRecordSchema, CharacterDefeatRecordSchema, type LongTermSave } from "./schema";
import type { RawSaveSnapshot } from "./storage-driver";

export const NOTEBOOK_SAVE_FORMAT = "hoc-notebook-save" as const;
export const NOTEBOOK_SAVE_SCHEMA_VERSION = 1 as const;
export const NOTEBOOK_ENDINGS = ["playerVictory", "playerDefeat", "escaped"] as const;
export type NotebookEndingId = typeof NOTEBOOK_ENDINGS[number];
const identity = z.string().min(1).max(1024);
const character = z.object({ characterId: identity, endings: z.array(z.enum(NOTEBOOK_ENDINGS)).max(3)
  .refine(values => new Set(values).size === values.length, "人物结局不可重复") }).strict();
export const NotebookSaveSchema = z.object({ format: z.literal(NOTEBOOK_SAVE_FORMAT), schemaVersion: z.literal(NOTEBOOK_SAVE_SCHEMA_VERSION),
  characters: z.array(character).max(100_000).refine(values => new Set(values.map(value => value.characterId)).size === values.length, "人物记录不可重复") }).strict();
export type NotebookSave = z.infer<typeof NotebookSaveSchema>;
export function emptyNotebookSave(): NotebookSave { return { format: NOTEBOOK_SAVE_FORMAT, schemaVersion: NOTEBOOK_SAVE_SCHEMA_VERSION, characters: [] }; }
export function validateNotebookSave(input: unknown): NotebookSave { return input === null || input === undefined ? emptyNotebookSave() : NotebookSaveSchema.parse(input); }

function object(input: unknown): Record<string, unknown> { return input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}; }
function ending(winner: unknown, escaped: unknown): NotebookEndingId | undefined {
  return escaped === true ? "escaped" : winner === "player" ? "playerVictory" : winner === "opponent" ? "playerDefeat" : undefined;
}
function add(result: NotebookSave, id: unknown, outcome?: NotebookEndingId): void {
  if (!identity.safeParse(id).success) return;
  let entry = result.characters.find(value => value.characterId === id);
  if (!entry) { entry = { characterId: id as string, endings: [] }; result.characters.push(entry); }
  if (outcome && !entry.endings.includes(outcome)) entry.endings.push(outcome);
}
function addLegacy(result: NotebookSave, input: unknown): void {
  const save = object(input);
  if (Array.isArray(save.history)) for (const value of save.history) {
    const parsed = MatchHistoryRecordSchema.safeParse(value);
    if (parsed.success) add(result, parsed.data.opponentId, ending(parsed.data.winner, parsed.data.escaped));
  }
  // A historical defeat proves the player's victory, never the other two endings.
  if (Array.isArray(save.defeats)) for (const value of save.defeats) {
    const parsed = CharacterDefeatRecordSchema.safeParse(value);
    if (parsed.success) add(result, parsed.data.opponentId, "playerVictory");
  }
}
function addMatch(result: NotebookSave, match: MatchState | undefined): void {
  if (match?.status === "finished") add(result, match.opponentId, ending(match.outcome?.winner, match.outcome?.reason === "escaped"));
}

/** A read-only view also understands old saves without rewriting them on startup. */
export function notebookForSave(save: LongTermSave | null | undefined, notebook?: unknown): NotebookSave {
  const result = structuredClone(validateNotebookSave(notebook)); addLegacy(result, save); return result;
}
export function recordedCharacterIds(save: LongTermSave | null | undefined, notebook?: unknown): readonly string[] {
  return notebookForSave(save, notebook).characters.map(entry => entry.characterId);
}
export function unlockedCharacterEndings(save: LongTermSave | null | undefined, notebook: unknown, characterId: string): readonly NotebookEndingId[] {
  const known = notebookForSave(save, notebook).characters.find(entry => entry.characterId === characterId)?.endings ?? [];
  return NOTEBOOK_ENDINGS.filter(value => known.includes(value));
}

/** Permanent collection is committed with the result, before inspectable history can be cleared. */
export function projectNotebookSnapshot(previous: RawSaveSnapshot, proposed: RawSaveSnapshot, context: SaveCheckpointContext = {}): RawSaveSnapshot {
  if (proposed.longTerm === null) return previous.notebook !== undefined || proposed.notebook !== undefined ? { ...proposed, notebook: null } : proposed;
  const replaced = context.notebookReplacement === true
    || (previous.longTerm !== null && object(previous.longTerm).createdAt !== object(proposed.longTerm).createdAt);
  const result = structuredClone(validateNotebookSave(replaced ? context.notebookReplacement ? proposed.notebook : undefined : previous.notebook));
  if (!replaced) addLegacy(result, previous.longTerm);
  // Explicit imports may provide an independent collection even when the old one was empty.
  if ((!replaced || context.notebookReplacement) && proposed.notebook !== previous.notebook && proposed.notebook !== undefined && proposed.notebook !== null) {
    for (const entry of validateNotebookSave(proposed.notebook).characters) {
      add(result, entry.characterId); for (const outcome of entry.endings) add(result, entry.characterId, outcome);
    }
  }
  addLegacy(result, proposed.longTerm);
  if (!context.notebookReplacement) {
    for (const batch of context.matchFacts ?? []) if (!batch.restored) addMatch(result, batch.after);
    for (const batch of context.publicEvents ?? []) if (!batch.restored) addMatch(result, batch.context?.match);
  }
  if (!result.characters.length && previous.notebook === undefined && proposed.notebook === undefined) return proposed;
  return { ...proposed, notebook: result };
}
