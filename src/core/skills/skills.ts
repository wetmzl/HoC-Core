import type { AbilityDefinition, SkillDrawWeightModifier } from "../abilities/types";
import type { SeededRng, RngSnapshot } from "../rng/seeded";
import type { CharacterDefeatRecord } from "../progression/defeats";
import { INITIAL_PLAYER_SKILL_IDS, PLAYER_SKILL_DEFINITIONS } from "./definitions";
import type { PlayerSkillDefinition, SkillDrawOffer, SkillTag } from "./types";
export { PLAYER_SKILL_INVENTORY_CAPACITY } from "./constants";

export const SKILL_DRAW_CANDIDATE_COUNT = 3;

export function playerSkillHasTag(skill: PlayerSkillDefinition, tag: SkillTag): boolean {
  return skill.skillTags.includes(tag);
}

export function calculatePlayerSkillWeight(
  skill: PlayerSkillDefinition,
  modifiers: readonly SkillDrawWeightModifier[],
  selectedSkillTags: readonly SkillTag[] = []
): number {
  const preferred = selectedSkillTags.some((tag) => playerSkillHasTag(skill, tag));
  return modifiers.reduce((weight, modifier) => playerSkillHasTag(skill, modifier.tag) ? weight * modifier.factor : weight, skill.drop.baseWeight * (preferred ? 4 : 1));
}

export function canGenerateSkillDraw(
  unlockedDefinitionIds: readonly string[],
  heldDefinitionIds: readonly string[],
  weightModifiers: readonly SkillDrawWeightModifier[] = [],
  selectedSkillTags: readonly SkillTag[] = []
): boolean {
  const unlocked = new Set(unlockedDefinitionIds);
  const held = new Set(heldDefinitionIds);
  return PLAYER_SKILL_DEFINITIONS.some((skill) => unlocked.has(skill.id) && skill.drop.enabled
    && (skill.category === "active" || skill.stackable || !held.has(skill.id))
    && calculatePlayerSkillWeight(skill, weightModifiers, selectedSkillTags) > 0);
}

export function collectSkillDrawWeightModifiers(definitions: readonly AbilityDefinition[]): readonly SkillDrawWeightModifier[] {
  return definitions.flatMap((definition) => definition.skillDrawWeightModifiers ?? []);
}

function weightedPickIndex(weights: readonly number[], rng: SeededRng): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) throw new RangeError("Skill offer requires a positive finite total weight");
  let cursor = rng.next() * total;
  for (let index = 0; index < weights.length; index += 1) {
    cursor -= weights[index]!;
    if (cursor < 0) return index;
  }
  return weights.length - 1;
}

export function generateSkillDrawOffer(
  rng: SeededRng,
  unlockedDefinitionIds: readonly string[],
  heldDefinitionIds: readonly string[],
  weightModifiers: readonly SkillDrawWeightModifier[] = [],
  offerId = "skill-draw",
  selectedSkillTags: readonly SkillTag[] = []
): { readonly offer: SkillDrawOffer; readonly rng: RngSnapshot } {
  const unlocked = new Set(unlockedDefinitionIds);
  const held = new Set(heldDefinitionIds);
  const pool = PLAYER_SKILL_DEFINITIONS.filter((skill) => unlocked.has(skill.id) && skill.drop.enabled)
    .filter((skill) => skill.category === "active" || skill.stackable || !held.has(skill.id))
    .map((skill) => ({ skill, weight: calculatePlayerSkillWeight(skill, weightModifiers, selectedSkillTags) }))
    .filter((candidate) => candidate.weight > 0);
  const candidates: PlayerSkillDefinition[] = [];
  while (pool.length > 0 && candidates.length < SKILL_DRAW_CANDIDATE_COUNT) {
    const index = weightedPickIndex(pool.map((candidate) => candidate.weight), rng);
    candidates.push(pool[index]!.skill);
    pool.splice(index, 1);
  }
  const candidateDefinitionIds = candidates.map((skill) => skill.id);
  return {
    offer: { id: offerId, candidateDefinitionIds },
    rng: rng.snapshot()
  };
}

/** Returns skills newly unlocked by a confirmed, non-escaped victory. */
export function playerSkillsUnlockedForVictory(opponentId: string, winner: "player" | "opponent" | null, escaped = false): string[] {
  if (escaped || winner !== "player") return [];
  return PLAYER_SKILL_DEFINITIONS.filter((skill) => skill.unlock?.opponentId === opponentId).map((skill) => skill.id);
}

export function unlockedPlayerSkillIdsForDefeats(defeats: readonly CharacterDefeatRecord[]): string[] {
  const defeatedIds = new Set(defeats.map((record) => record.opponentId));
  return [...new Set([...INITIAL_PLAYER_SKILL_IDS, ...PLAYER_SKILL_DEFINITIONS
    .filter((skill) => skill.unlock && defeatedIds.has(skill.unlock.opponentId))
    .map((skill) => skill.id)])];
}
