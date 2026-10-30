import type { RematchOptions } from "../content/characters/rematches";
import type { CharacterDefinition } from "../content/characters";
import { standaloneFlowDefinition } from "../content/encounters";
import type { MatchState } from "../core/match/types";
import type { LongTermSave } from "../persistence/schema";
import { secureSeed } from "../presentation/view-helpers";
import type { EncounterPlan } from "./match-owner";
import { createFlow, startFlowNode, flowEncounterPlan } from "../core/flow/reducer";

export { standaloneFlowDefinition } from "../content/encounters";

/** Compatibility entry for callers that need one prepared table. */
export function standaloneEncounter(character: CharacterDefinition, save: LongTermSave, rematch?: RematchOptions): EncounterPlan {
  const definition = standaloneFlowDefinition(character, save, rematch);
  const seed = secureSeed();
  const progress = startFlowNode(definition, createFlow(`single-${seed}`, seed), "match");
  const plan = flowEncounterPlan(definition, progress, { gun: definition.playerGun, comparisonBonus: 0 });
  return plan;
}
export function standaloneCharacter(character: CharacterDefinition, match: MatchState): CharacterDefinition {
  return { ...character, aiSkills: match.abilities.instances
    .filter(instance => instance.owner === "opponent" && instance.kind === "ai-skill")
    .map(instance => ({ definitionId: instance.definitionId, level: instance.level ?? 1, enabled: true, parameters: instance.parameters })) };
}
