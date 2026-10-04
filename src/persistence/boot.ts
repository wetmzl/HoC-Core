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

/** The default user-facing/exportable save contains only durable progress and preferences. */
export function createDefaultSave(now = new Date().toISOString()): LongTermSave {
  const profile: PlayerProfile = { id: "player", displayName: "策展人", matchesPlayed: 0, wins: 0, selectedSkillTags: [] };
  const settings: GameSettings = { soundEnabled: true, reducedMotion: false };
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
    history: [],
    defeats: []
  };
}

/** Explicit, recoverable boundary helper used by the dangerous long-term reset action. */
export function resetSave(now = new Date().toISOString()): LongTermSave { return createDefaultSave(now); }

export function createRuntimeSave(match: MatchState, now = new Date().toISOString()): RuntimeSave {
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

/** Clears only inspectable match summaries; collection and progression are preserved. */
export function clearMatchHistory(save: LongTermSave, now = new Date().toISOString()): LongTermSave {
  if (save.history.length === 0) return save;
  return { ...save, history: [], updatedAt: now };
}

/** Converts one acknowledged finished runtime match into durable history/progression. */
export function acknowledgeMatchResult(save: LongTermSave, match: MatchState, now = new Date().toISOString()): LongTermSave {
  if (match.status !== "finished" || match.scene !== "lobby") return save;
  const record = summarizeMatch(match, now);
  if (save.history.some((entry) => entry.id === record.id)) return save;
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
  return { ...save, profile, history, defeats, updatedAt: now };
}
