import type { ChallengeDefinition } from "../../core/challenge/schema";
import type { CharacterDefinition } from "../characters/types";
import { validateAbilityBinding, supportsAbilitySourceKind, type AbilityRegistry } from "../../core/abilities/registry";

let challenges: readonly ChallengeDefinition[] = [];
export function getChallenges(): readonly ChallengeDefinition[] { return challenges; }
export function installChallenges(definitions: readonly ChallengeDefinition[]): void { challenges = structuredClone(definitions); }
export function validateChallenges(definitions: readonly ChallengeDefinition[], characters: readonly CharacterDefinition[], registry: AbilityRegistry): void {
  if (new Set(definitions.map(definition => definition.id)).size !== definitions.length) throw new Error("Boss 挑战 ID 重复");
  for (const definition of definitions) {
    for (const id of [definition.bossId, ...definition.guards.map(guard => guard.characterId)]) {
      const character = characters.find(character => character.id === id);
      if (!character || character.faction !== definition.faction) throw new Error(`Boss 挑战角色缺失或阵营不符：${definition.id}/${id}`);
    }
    const unlock = definition.unlock;
    if (unlock.type === "defeat-character" && !characters.some(character => character.id === unlock.characterId)) throw new Error(`Boss 解锁引用未知角色：${definition.id}`);
    for (const binding of definition.bossAbilities.flatMap(ability => [ability.binding, ...(ability.weakenedBinding ? [ability.weakenedBinding] : [])])) {
      validateAbilityBinding(binding, registry);
      const ability = registry.definitionsById[binding.definitionId];
      if (!ability || !supportsAbilitySourceKind(ability, "ai-skill")) throw new Error(`Boss 技能必须是 AI Skill：${binding.definitionId}`);
    }
  }
}
