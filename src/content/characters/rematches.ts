import { getEncounterFlows } from "../encounter-flows/catalog";
import type { AbilityBinding } from "../../core/abilities/types";
import { getAbilityDefinition } from "../../core/abilities/registry";
import type { CharacterDefinition } from "./types";
import { characterEncounterCapabilities } from "./encounter-capabilities";

export interface RematchSkill {
  readonly key: string;
  readonly full: AbilityBinding;
  readonly weakened: AbilityBinding;
}
export interface RematchOptions { readonly weakenedSkills: readonly string[]; }

/** Skill choices belong to one rematch, never to durable level unlocks or a challenge run. */
export function specialOpponentRematchSkills(character: CharacterDefinition): readonly RematchSkill[] {
  if (!characterEncounterCapabilities(character).rematchSkillChoices) return [];
  const challenges = getEncounterFlows().filter(definition => definition.ownerId === character.id);
  // Multiple authored flows may use different skills; an independent rematch uses the character itself.
  const challenge = challenges.length === 1 ? challenges[0] : undefined;
  if (challenge?.rematchSkills) return challenge.rematchSkills.map(ability => ({ key: ability.slot, full: ability.binding,
    weakened: ability.weakenedBinding ?? { ...ability.binding, enabled: false } }));
  return character.aiSkills.filter(binding => binding.enabled).map((full, index) => ({ key: `${full.definitionId}:${index}`, full,
    weakened: (full.level ?? 1) > 1 && getAbilityDefinition(full.definitionId, undefined, 1)
      ? { ...full, level: 1 } : { ...full, enabled: false } }));
}

export function rematchAbilities(character: CharacterDefinition, options?: RematchOptions): readonly AbilityBinding[] {
  if (!characterEncounterCapabilities(character).rematchSkillChoices) {
    if (options?.weakenedSkills.length) throw new Error("该对手不支持选择技能削弱。");
    return character.aiSkills;
  }
  const skills = specialOpponentRematchSkills(character);
  const selected = new Set(options?.weakenedSkills ?? []);
  if (selected.size !== (options?.weakenedSkills.length ?? 0) || [...selected].some(key => !skills.some(skill => skill.key === key)))
    throw new Error("未知或重复的削弱技能。");
  return skills.map(skill => selected.has(skill.key) ? skill.weakened : skill.full);
}
