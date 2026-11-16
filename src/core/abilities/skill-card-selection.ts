import { getAbilityDefinition, type AbilityRegistry } from "./registry";
import type { AbilityActor, AbilityWorld, SkillCardFilter, SkillCardInstance, AbilityInstance, PlayerSkillAbilityDefinition } from "./types";

/** Definition metadata is supplied by the caller, including its resolved level. */
export interface SkillCardFilterSubject extends Pick<SkillCardInstance, "instanceId" | "definitionId">, Pick<PlayerSkillAbilityDefinition, "primaryDomain" | "skillTags" | "tags"> {
  readonly activation: PlayerSkillAbilityDefinition["activation"]["type"];
}

/** Arrays are alternatives; separately declared fields must all match. */
export function matchesSkillCard(subject: SkillCardFilterSubject, filter: SkillCardFilter = {}): boolean {
  return (!filter.definitionIds || filter.definitionIds.includes(subject.definitionId))
    && (!filter.instanceIds || filter.instanceIds.includes(subject.instanceId))
    && (!filter.primaryDomains || filter.primaryDomains.includes(subject.primaryDomain))
    && (!filter.skillTags || filter.skillTags.some(tag => subject.skillTags.includes(tag)))
    && (!filter.tags || filter.tags.some(tag => subject.tags.includes(tag)))
    && (!filter.activation || subject.activation === filter.activation);
}

export function selectSkillCards(world: AbilityWorld, owner: AbilityActor, filter: SkillCardFilter = {}, registry?: AbilityRegistry): readonly SkillCardInstance[] {
  return world.cards.filter(card => {
    if (card.owner !== owner) return false;
    const definition = getAbilityDefinition(card.definitionId, registry, card.level);
    if (!definition || definition.sourceKind !== "player-skill") throw new Error(`Unknown Player Skill card: ${card.definitionId}`);
    return matchesSkillCard({ instanceId: card.instanceId, definitionId: card.definitionId,
      primaryDomain: definition.primaryDomain, skillTags: definition.skillTags, tags: definition.tags, activation: definition.activation.type }, filter);
  });
}

export function skillCardAgreesWithInstance(card: SkillCardInstance, instance: AbilityInstance | undefined): boolean {
  return Boolean(instance && instance.kind === card.kind && instance.owner === card.owner
    && instance.definitionId === card.definitionId && (instance.level ?? 1) === (card.level ?? 1));
}
