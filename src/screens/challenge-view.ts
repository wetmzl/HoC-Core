import type { ChallengeDefinition, ChallengeRun } from "../core/challenge/schema";
import { challengeFlow, challengeProgress, guardNodeId } from "../core/challenge/flow";
import { getCharacterMetadata } from "../content/characters";
import { renderFlowSelection, renderFlowSkillComparison } from "./flow-view";

export { flowBackgrounds as challengeBackgrounds } from "./flow-view";

/** Legacy view entry points adapt their inputs to the common node projection. */
export function renderChallengeSelection(run: ChallengeRun, reducedMotion = false): string {
  const definition = challengeFlow(run.definition);
  return renderFlowSelection({ ...challengeProgress(run), definition: { ...definition,
    presentation: { ...definition.presentation!, title: getCharacterMetadata(run.definition.bossId)?.name ?? definition.presentation!.title }
  }, playerGun: run.playerGun, playerComparisonBonus: run.playerComparisonBonus }, reducedMotion);
}
export function renderChallengeSkillComparison(definition: ChallengeDefinition, guardId: string): string {
  return renderFlowSkillComparison(challengeFlow(definition), guardNodeId(guardId));
}
