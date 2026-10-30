import type { MatchState } from "../core/match/types";
import { summarizeMatch } from "../core/match/history";
import { addFirstCharacterDefeat } from "../core/progression/defeats";
import {
  assertMatchStateForSave,
  CURRENT_GAME_VERSION,
  CURRENT_LONG_TERM_SCHEMA_VERSION,
  CURRENT_RUNTIME_SCHEMA_VERSION,
  LONG_TERM_SAVE_FORMAT,
  RUNTIME_SAVE_FORMAT,
  type GameSettings,
  type LongTermSave,
  type PlayerProfile,
  type RuntimeSave
} from "./schema";
import type { SaveRepository } from "./repository";
import { DEFAULT_MUSIC_VOLUME } from "../audio/music-volume";
import { preserveCharacterDefeatProgress, recordCharacterDefeat } from "./character-defeats";
import { grantDeclaredSkinUnlocks } from "./skin-unlocks";
import { CHARACTER_CATALOG } from "../content/characters/catalog";

/** The default user-facing/exportable save contains only durable progress and preferences. */
export function createDefaultSave(now = new Date().toISOString()): LongTermSave {
  const profile: PlayerProfile = { id: "player", displayName: "策展人", matchesPlayed: 0, wins: 0, selectedSkillTags: [] };
  const settings: GameSettings = { soundEnabled: true, musicVolume: DEFAULT_MUSIC_VOLUME, reducedMotion: false, autoSkipAfterStand: true };
  return {
    format: LONG_TERM_SAVE_FORMAT,
    schemaVersion: CURRENT_LONG_TERM_SCHEMA_VERSION,
    gameVersion: CURRENT_GAME_VERSION,
    createdAt: now,
    updatedAt: now,
    profile,
    settings,
    skipTutorial: false,
    tutorialProgress: { completedIds: [] },
    characterSkinUnlocks: {},
    history: [],
    defeats: []
  };
}

/** Explicit, recoverable boundary helper used by the dangerous long-term reset action. */
export function resetSave(now = new Date().toISOString()): LongTermSave { return createDefaultSave(now); }

export function createRuntimeSave(match: MatchState, now = new Date().toISOString()): RuntimeSave & { activeMatch: MatchState } {
  assertMatchStateForSave(match);
  return {
    format: RUNTIME_SAVE_FORMAT,
    schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION,
    gameVersion: CURRENT_GAME_VERSION,
    updatedAt: now,
    activeMatch: match
  };
}

export async function bootLoad(repository: SaveRepository, now = new Date().toISOString()): Promise<LongTermSave> {
  const existing = await repository.loadLongTerm();
  if (existing) return existing;
  const fresh = createDefaultSave(now);
  await repository.saveLongTerm(fresh);
  return fresh;
}

export async function restoreActiveMatch(repository: SaveRepository): Promise<MatchState | null> {
  return (await repository.loadRuntime())?.activeMatch ?? null;
}

/** Older saves used victory receipts for both counting and result acknowledgement. */
function preserveMatchResultReceipts(save: LongTermSave): LongTermSave {
  const receipts = [...new Set([...(save.matchResultReceipts ?? save.characterDefeatProgress?.matchIds ?? []), ...save.history.map(record => record.id)])];
  return save.matchResultReceipts && receipts.length === save.matchResultReceipts.length
    ? save : { ...save, matchResultReceipts: receipts };
}

/** Count an acknowledged victory immediately, independently of a later history effect. */
export function recordMatchProgress(save: LongTermSave, match: MatchState): LongTermSave {
  if (match.status !== "finished" || match.scene !== "lobby" || match.outcome?.winner !== "player" || match.outcome.reason === "escaped") return save;
  // Establish legacy result receipts before adding this new, possibly deferred result.
  return grantDeclaredSkinUnlocks(recordCharacterDefeat(preserveMatchResultReceipts(save), match), CHARACTER_CATALOG);
}

/** Clears only inspectable match summaries; collection and progression are preserved. */
export function clearMatchHistory(save: LongTermSave, now = new Date().toISOString()): LongTermSave {
  if (save.history.length === 0) return save;
  return { ...preserveCharacterDefeatProgress(preserveMatchResultReceipts(save)), history: [], updatedAt: now };
}

/** Converts one acknowledged finished runtime match into durable history/progression. */
export function acknowledgeMatchResult(save: LongTermSave, match: MatchState, now = new Date().toISOString()): LongTermSave {
  if (match.status !== "finished" || match.scene !== "lobby") return save;
  const record = summarizeMatch(match, now);
  const migrated = preserveMatchResultReceipts(save);
  if (migrated.matchResultReceipts!.includes(record.id)) return save;
  save = migrated;
  save = recordCharacterDefeat(save, match);
  const history = [...save.history, record];
  const won = record.winner === "player" && !record.escaped;
  const defeats = won
    ? [...addFirstCharacterDefeat(save.defeats, record.opponentId, record.timestamp)]
    : save.defeats;
  const profile: PlayerProfile = {
    ...save.profile,
    matchesPlayed: save.profile.matchesPlayed + 1,
    wins: save.profile.wins + (won ? 1 : 0)
  };
  return grantDeclaredSkinUnlocks({ ...save, profile, history, defeats, matchResultReceipts: [...save.matchResultReceipts!, record.id], updatedAt: now }, CHARACTER_CATALOG);
}
