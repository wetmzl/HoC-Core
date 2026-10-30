import { getAbilityDefinition, type AbilityRegistry } from "./registry";
import type { AbilityActor, AbilityWorld, SkillCardFilter, SkillCardInstance, AbilityInstance } from "./types";

/** Arrays are alternatives; separately declared fields must all match. */
export function selectSkillCards(world: AbilityWorld, owner: AbilityActor, filter: SkillCardFilter = {}, registry?: AbilityRegistry): readonly SkillCardInstance[] {
  return world.cards.filter(card => {
    if (card.owner !== owner) return false;
    const definition = getAbilityDefinition(card.definitionId, registry, card.level);
    if (!definition || definition.sourceKind !== "player-skill") throw new Error(`Unknown Player Skill card: ${card.definitionId}`);
    return (!filter.definitionIds || filter.definitionIds.includes(card.definitionId))
      && (!filter.instanceIds || filter.instanceIds.includes(card.instanceId))
      && (!filter.primaryDomains || filter.primaryDomains.includes(definition.primaryDomain))
      && (!filter.skillTags || filter.skillTags.some(tag => definition.skillTags.includes(tag)))
      && (!filter.tags || filter.tags.some(tag => definition.tags.includes(tag)))
      && (!filter.activation || definition.activation.type === filter.activation);
  });
}

export function skillCardAgreesWithInstance(card: SkillCardInstance, instance: AbilityInstance | undefined): boolean {
  return Boolean(instance && instance.kind === card.kind && instance.owner === card.owner
    && instance.definitionId === card.definitionId && (instance.level ?? 1) === (card.level ?? 1));
}
