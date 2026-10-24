import type { CharacterDefeatRecord } from "../../core/progression/defeats";
import { CHARACTER_CATALOG, characterHasTag, getCharacterMetadata } from "./catalog";
import type { CharacterMetadata, CharacterUnlockCondition } from "./types";

/** Character IDs recorded by the durable first-defeat collection. */
export function defeatedCharacterIds(defeats: readonly CharacterDefeatRecord[]): ReadonlySet<string> {
  return new Set(defeats.map((record) => record.opponentId));
}

function conditionMet(condition: CharacterUnlockCondition, defeats: readonly CharacterDefeatRecord[]): boolean {
  const defeated = defeatedCharacterIds(defeats);
  switch (condition.type) {
    case "defeat-any":
      return defeated.size > 0;
    case "defeat-count":
      return defeated.size >= condition.count;
    case "defeat-character":
      return defeated.has(condition.characterId);
    case "defeat-any-tag":
      return CHARACTER_CATALOG.some((character) => characterHasTag(character, condition.tag) && defeated.has(character.id));
    case "defeat-tag-percentage": {
      const tagged = CHARACTER_CATALOG.filter((character) => characterHasTag(character, condition.tag));
      if (tagged.length === 0) return false;
      const taggedDefeated = tagged.filter((character) => defeated.has(character.id)).length;
      return taggedDefeated / tagged.length >= condition.percentage / 100;
    }
  }
}

export function isCharacterUnlocked(character: CharacterMetadata, defeats: readonly CharacterDefeatRecord[]): boolean {
  return !character.unlock || conditionMet(character.unlock, defeats);
}

/** Computes the canonical set of unlocked attendees from durable defeat facts. */
export function unlockedCharacterIdsForDefeats(defeats: readonly CharacterDefeatRecord[]): readonly string[] {
  return CHARACTER_CATALOG.filter((character) => isCharacterUnlocked(character, defeats)).map((character) => character.id);
}

export function newlyUnlockedCharacterIds(
  before: readonly CharacterDefeatRecord[],
  after: readonly CharacterDefeatRecord[]
): readonly string[] {
  const previous = new Set(unlockedCharacterIdsForDefeats(before));
  return unlockedCharacterIdsForDefeats(after).filter((id) => !previous.has(id));
}

export function newlyUnlockedForDefeat(defeats: readonly CharacterDefeatRecord[], opponentId: string): readonly string[] {
  const projected = [...defeats, { opponentId, timestamp: new Date(0).toISOString() }];
  return newlyUnlockedCharacterIds(defeats, projected);
}

/** Acquisition order used by the lobby and optional collections. */
export function defeatedCharacterIdsByFirstDefeat(defeats: readonly CharacterDefeatRecord[]): readonly string[] {
  const seen = new Set<string>();
  return [...defeats]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((record) => record.opponentId)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .filter((id) => Boolean(getCharacterMetadata(id)));
}
