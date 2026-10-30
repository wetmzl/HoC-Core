import { getEncounterFlows, encounterUnlockProgress } from "../encounter-flows/catalog";
import { CHARACTER_CATALOG, defeatedCharacterIdsByFirstDefeat, isCharacterUnlocked, type CharacterDefinition } from "./index";
import { specialOpponentRematchSkills } from "./rematches";
import type { LongTermSave } from "../../persistence/schema";
import { unlockConditionLabel } from "../../presentation/view-helpers";

/** A legacy defeat implies completion only when that opponent has one authored challenge. */
export function pendingCharacterChallenges(save: LongTermSave, characterId?: string) {
  const definitions = getEncounterFlows();
  const defeated = new Set(save.defeats.map(record => record.opponentId));
  return definitions.filter(definition => (!characterId || definition.ownerId === characterId)
    && (definition.repeatable || (!save.completedFlows?.includes(definition.id) && !save.completedChallenges?.includes(definition.id)
      && !((!definition.program || definition.program.legacyDefinition?.completionId) && defeated.has(definition.ownerId)
        && definitions.filter(candidate => candidate.ownerId === definition.ownerId).length === 1))));
}

/** Legacy package eligibility and rematch capabilities stay at the content boundary. */
export function characterInvitation(character: CharacterDefinition, save: LongTermSave, challengeId?: string) {
  const defeated = defeatedCharacterIdsByFirstDefeat(save.defeats).includes(character.id);
  const pending = pendingCharacterChallenges(save, character.id);
  const challenge = challengeId ? pending.find(definition => definition.id === challengeId)
    : !defeated ? pending[0] : undefined;
  if (challengeId && !challenge) throw new Error("该挑战已结束或不属于此角色。");
  if (challenge) {
    const progress = encounterUnlockProgress(challenge, save.defeats, CHARACTER_CATALOG);
    return { challenge, available: progress.unlocked, skills: [], abilities: challenge.rematchSkills?.map(slot => slot.binding) ?? character.aiSkills,
      hint: progress.unlocked ? challenge.invitationHint ?? "" : `尚未解锁：${progress.current}/${progress.required}` };
  }
  const available = defeated || isCharacterUnlocked(character, save.defeats);
  return { challenge: undefined, available, skills: defeated ? specialOpponentRematchSkills(character) : [], abilities: character.aiSkills,
    hint: available ? "" : `尚未解锁：${unlockConditionLabel(character.unlock)}` };
}
