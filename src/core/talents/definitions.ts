import { subscribeAbilityRegistry } from "../abilities/registry";
import type { TalentAbilityDefinition } from "../abilities/types";
import type { CharacterDefeatRecord } from "../progression/defeats";

export let TALENT_DEFINITIONS: readonly TalentAbilityDefinition[] = Object.freeze([]);
subscribeAbilityRegistry((registry) => {
  TALENT_DEFINITIONS = Object.freeze(registry.definitions.filter((definition): definition is TalentAbilityDefinition => definition.sourceKind === "talent"));
});
export function getTalentDefinition(id: string) { return TALENT_DEFINITIONS.find((talent) => talent.id === id); }
export function unlockedTalentIdsForDefeats(defeats: readonly CharacterDefeatRecord[]): string[] {
  const defeatCount = new Set(defeats.map((record) => record.opponentId)).size;
  return TALENT_DEFINITIONS.filter((talent) => !talent.hidden && defeatCount >= talent.unlock.count).map((talent) => talent.id);
}
