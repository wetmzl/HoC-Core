import type { CharacterDefeatRecord } from "../../core/progression/defeats";
import { CHARACTER_CATALOG, characterHasTag, getCharacterMetadata } from "./catalog";
import type { CharacterMetadata, CharacterUnlockCondition } from "./types";
import { characterEncounterCapabilities } from "./encounter-capabilities";

export function unlockConditionLabel(condition: CharacterUnlockCondition | undefined): string {
  if (!condition) return "完成条件后";
  if (condition.type === "defeat-any") return "击败任意角色";
  if (condition.type === "defeat-count") return `击败 ${condition.count} 名不同与会者`;
  if (condition.type === "defeat-faction-count") {
    const faction = CHARACTER_CATALOG.find(character => character.faction === condition.faction && character.badge)?.badge?.label ?? condition.faction;
    return `击败「${faction}」阵营的 ${condition.count} 名不同角色`;
  }
  const tagLabel = (tag: string): string => {
    const tier = /^tier:(d|c|b|a|s|ss)$/.exec(tag)?.[1];
    return tier ? `${tier.toUpperCase()}级` : `带有「${tag}」标签的`;
  };
  if (condition.type === "defeat-any-tag") return `击败一名${tagLabel(condition.tag)}角色`;
  if (condition.type === "defeat-character") return `击败指定角色 ${getCharacterMetadata(condition.characterId)?.name ?? condition.characterId}`;
  return `击败${tagLabel(condition.tag)}角色的 ${condition.percentage}%`;
}

/** Character IDs recorded by the durable first-defeat collection. */
export function defeatedCharacterIds(defeats: readonly CharacterDefeatRecord[]): ReadonlySet<string> {
  return new Set(defeats.map((record) => record.opponentId));
}

function conditionMet(condition: CharacterUnlockCondition, defeats: readonly CharacterDefeatRecord[], characterId: string): boolean {
  const defeated = defeatedCharacterIds(defeats);
  switch (condition.type) {
    case "defeat-any":
      return defeated.size > 0;
    case "defeat-count":
      return defeated.size >= condition.count;
    case "defeat-faction-count":
      return CHARACTER_CATALOG.filter(character => character.id !== characterId && character.faction === condition.faction && defeated.has(character.id)).length >= condition.count;
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
  if (characterEncounterCapabilities(character).requiresDefeat) return defeatedCharacterIds(defeats).has(character.id);
  return !character.unlock || conditionMet(character.unlock, defeats, character.id);
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
