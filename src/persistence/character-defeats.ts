import { z } from "zod";
import type { LongTermSave } from "./schema";
import type { MatchState } from "../core/match/types";

export const CharacterDefeatProgressSchema = z.object({
  counts: z.record(z.string().min(1), z.number().int().nonnegative().safe()),
  matchIds: z.array(z.string().min(1)).refine(ids => new Set(ids).size === ids.length, "击败计数收据不可重复")
}).strict();

function legacyWins(save: LongTermSave, characterId: string): number {
  return new Set(save.history.filter(record => record.opponentId === characterId && record.winner === "player" && !record.escaped).map(record => record.id)).size;
}

/** Retain the provable legacy lower bound; never invent victories from missing history. */
export function characterDefeatCount(save: LongTermSave, characterId: string): number {
  return Math.max(Object.hasOwn(save.characterDefeatProgress?.counts ?? {}, characterId) ? save.characterDefeatProgress!.counts[characterId] : 0,
    legacyWins(save, characterId), save.defeats.some(record => record.opponentId === characterId) ? 1 : 0);
}

export function preserveCharacterDefeatProgress(save: LongTermSave): LongTermSave {
  const counts = { ...save.characterDefeatProgress?.counts };
  const wins = save.history.filter(record => record.winner === "player" && !record.escaped);
  for (const id of new Set([...save.defeats.map(record => record.opponentId), ...wins.map(record => record.opponentId)])) counts[id] = characterDefeatCount(save, id);
  const matchIds = [...new Set([...(save.characterDefeatProgress?.matchIds ?? []), ...wins.map(record => record.id)])];
  if (!Object.keys(counts).length && !save.characterDefeatProgress) return save;
  const progress = { counts, matchIds };
  return JSON.stringify(progress) === JSON.stringify(save.characterDefeatProgress) ? save : { ...save, characterDefeatProgress: progress };
}

/** Receipts survive history cleanup and make replay/retry idempotent. */
export function recordCharacterDefeat(save: LongTermSave, match: MatchState): LongTermSave {
  if (match.status !== "finished" || match.scene !== "lobby" || match.outcome?.winner !== "player" || match.outcome.reason === "escaped") return save;
  const migrated = preserveCharacterDefeatProgress(save);
  if (migrated.characterDefeatProgress?.matchIds.includes(match.id)) return migrated;
  return { ...migrated, updatedAt: new Date().toISOString(), characterDefeatProgress: {
    counts: { ...migrated.characterDefeatProgress?.counts, [match.opponentId]: characterDefeatCount(migrated, match.opponentId) + 1 },
    matchIds: [...(migrated.characterDefeatProgress?.matchIds ?? []), match.id]
  } };
}
