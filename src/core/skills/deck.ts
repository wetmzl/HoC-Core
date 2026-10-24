import type { PlayerSkillDefinition } from "./types";

export const MINIMUM_SKILL_DECK_SIZE = 8;
export type DeckZone = "carried" | "reserve";
export interface SkillDeck {
  readonly carried: readonly string[];
  readonly reserve: readonly string[];
}

export function availableDeckSkills(definitions: readonly PlayerSkillDefinition[], unlocked: readonly string[]): PlayerSkillDefinition[] {
  const ids = new Set(unlocked);
  return definitions.filter((skill) => ids.has(skill.id) && skill.drop.enabled && skill.drop.baseWeight > 0);
}

/** Absent configuration means first use; new unlocks join reserve after initialization. */
export function resolveSkillDeck(saved: SkillDeck | undefined, available: readonly string[]): SkillDeck {
  if (!saved) return { carried: [...available], reserve: [] };
  const carried = [...new Set(saved.carried)];
  const reserve = [...new Set(saved.reserve)].filter((id) => !carried.includes(id));
  const known = new Set([...carried, ...reserve]);
  return { carried, reserve: [...reserve, ...available.filter((id) => !known.has(id))] };
}

export function skillDeckRequirement(deck: SkillDeck, available: readonly string[]) {
  const availableSet = new Set(available);
  const count = deck.carried.filter((id) => availableSet.has(id)).length;
  const minimum = Math.min(MINIMUM_SKILL_DECK_SIZE, availableSet.size);
  return { count, minimum, missing: Math.max(0, minimum - count) };
}

/** Anchor insertion preserves the relative order of hidden/filtered skills. */
export function moveDeckSkill(deck: SkillDeck, id: string, zone: DeckZone, beforeId?: string): SkillDeck {
  if (!deck.carried.includes(id) && !deck.reserve.includes(id)) return deck;
  if (beforeId === id) return deck;
  const carried = deck.carried.filter((value) => value !== id);
  const reserve = deck.reserve.filter((value) => value !== id);
  const target = zone === "carried" ? carried : reserve;
  const anchor = beforeId ? target.indexOf(beforeId) : -1;
  target.splice(anchor < 0 ? target.length : anchor, 0, id);
  return { carried, reserve };
}
