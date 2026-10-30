import { getAbilityDefinition, subscribeAbilityRegistry } from "../abilities/registry";
import type { PlayerSkillAbilityDefinition } from "../abilities/types";
import type { PlayerSkillDefinition, SkillCategory, SkillTiming } from "./types";

function toPlayerSkillDefinition(definition: PlayerSkillAbilityDefinition, level = 1): PlayerSkillDefinition {
  const category: SkillCategory = definition.activation.type === "action" ? "active" : "passive";
  const timing: readonly SkillTiming[] = definition.activation.type === "action"
    ? definition.activation.windows.map((window) => window === "owner-turn" ? "player-turn" : "roulette-reaction")
    : [];
  return Object.freeze({
    metadataLabels: definition.metadataLabels,
    id: definition.id, level, name: definition.name, category, description: definition.description,
    usage: definition.usage ?? definition.description, triggerNotice: definition.triggerNotice ?? definition.description,
    profileLore: definition.profileLore ?? definition.description, timing,
    uses: definition.activation.type === "action" ? definition.activation.uses ?? 1 : 1,
    primaryDomain: definition.primaryDomain,
    skillTags: definition.skillTags,
    tags: definition.tags, drop: definition.drop, stackable: definition.stackable, acquisitionLimit: definition.acquisitionLimit, ttl: definition.ttl, unlock: definition.unlock,
    hidden: definition.hidden ?? false
  });
}

export let PLAYER_SKILL_DEFINITIONS: readonly PlayerSkillDefinition[] = Object.freeze([]);
export let INITIAL_PLAYER_SKILL_IDS: readonly string[] = Object.freeze([]);
subscribeAbilityRegistry((registry) => {
  PLAYER_SKILL_DEFINITIONS = Object.freeze(registry.definitions
    .filter((definition): definition is PlayerSkillAbilityDefinition => definition.sourceKind === "player-skill" && !definition.hidden)
    .map(definition => toPlayerSkillDefinition(definition)));
  INITIAL_PLAYER_SKILL_IDS = Object.freeze(PLAYER_SKILL_DEFINITIONS.filter((skill) => !skill.unlock).map((skill) => skill.id));
});
export function getPlayerSkillDefinition(id: string, level = 1): PlayerSkillDefinition | undefined {
  if (level === 1) return PLAYER_SKILL_DEFINITIONS.find(skill => skill.id === id);
  const definition = getAbilityDefinition(id, undefined, level);
  return definition?.sourceKind === "player-skill" && !definition.hidden ? toPlayerSkillDefinition(definition, level) : undefined;
}
