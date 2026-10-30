import { CHARACTER_CATALOG, defeatedCharacterIdsByFirstDefeat, getCharacterMetadata, isCharacterUnlocked, type CharacterDefinition } from "./characters";
import { characterInvitation, pendingCharacterChallenges } from "./characters/invitations";
import { characterEncounterCapabilities } from "./characters/encounter-capabilities";
import { rematchAbilities, type RematchOptions } from "./characters/rematches";
import { singleEncounterFlow } from "../core/flow/single";
import type { FlowDefinition } from "../core/flow/schema";
import type { LongTermSave } from "../persistence/schema";
import { getEncounterFlows, encounterUnlockProgress } from "./encounter-flows/catalog";
import { compileLegacyFlow, singleMatchProgram } from "../core/flow/program-templates";
import { ProgramDefinitionSchema, type ProgramDefinition } from "../core/flow/program";

/** Legacy eligibility, equipment and rematch choices are compiled before runtime starts. */
export function standaloneFlowDefinition(character: CharacterDefinition, save: LongTermSave, rematch?: RematchOptions): FlowDefinition {
  if (!defeatedCharacterIdsByFirstDefeat(save.defeats).includes(character.id) && !isCharacterUnlocked(character, save.defeats))
    throw new Error("该角色尚未解锁。");
  const guns = characterEncounterCapabilities(character);
  const definition = singleEncounterFlow(character.id, guns.playerGun, guns.opponentGun);
  return { ...definition, presentation: { title: character.name }, nodes: definition.nodes.map(node => ({ ...node,
    abilities: rematchAbilities(character, rematch).map((binding, index) => ({ slot: `skill:${index}`, binding: { ...binding, level: binding.level ?? 1 }, overrides: [] }))
  })) };
}

export function invitationFlow(character: CharacterDefinition, save: LongTermSave, weakenedSkills: readonly string[] = [], challengeId?: string): { definition: FlowDefinition; nodeId?: string } {
  const invitation = characterInvitation(character, save, challengeId);
  if (!invitation.available) throw new Error(invitation.hint);
  if (invitation.challenge) {
    const definition = invitation.challenge.definition;
    const multiple = getEncounterFlows().filter(candidate => candidate.ownerId === character.id).length > 1;
    return { definition: { ...definition, presentation: { ...definition.presentation!, title: multiple ? invitation.challenge.name : character.name } } };
  }
  const definition = standaloneFlowDefinition(character, save, { weakenedSkills });
  return { definition, nodeId: definition.nodes[0].id };
}

/** All production invitations return an executable program, including ordinary matches. */
export function invitationProgram(character: CharacterDefinition, save: LongTermSave, weakenedSkills: readonly string[] = [], challengeId?: string): { definition: ProgramDefinition } {
  const invitation = characterInvitation(character, save, challengeId);
  if (!invitation.available) throw new Error(invitation.hint);
  if (invitation.challenge) {
    const entry = invitation.challenge;
    const program = entry.program ?? compileLegacyFlow(entry.definition);
    const multiple = getEncounterFlows().filter(candidate => candidate.ownerId === character.id).length > 1;
    return { definition: { ...program, presentation: { ...program.presentation, title: multiple ? entry.name : character.name } } };
  }
  const ordinary = standaloneFlowDefinition(character, save, { weakenedSkills });
  const declaredTemplate = character.runtime?.type === "template" ? character.runtime.template : undefined;
  const template = declaredTemplate?.type === "single-match" ? declaredTemplate : undefined;
  if (!character.program || template) {
    const node = ordinary.nodes[0];
    return { definition: singleMatchProgram({
      id: template?.id ?? ordinary.id, opponentId: template?.opponentId ?? character.id,
      playerGun: ordinary.playerGun, opponentGun: node.opponentGun, presentation: ordinary.presentation,
      init: { opponentAbilities: rematchAbilities(character, { weakenedSkills }).map(binding => ({ ...binding, level: binding.level ?? 1 })), ...template?.init,
        ...(weakenedSkills.length ? { opponentAbilities: rematchAbilities(character, { weakenedSkills }).map(binding => ({ ...binding, level: binding.level ?? 1 })) } : {}) }
    }) };
  }
  const program = character.program;
  const bindings = rematchAbilities(character, { weakenedSkills });
  return { definition: ProgramDefinitionSchema.parse({ ...program,
    nodes: program.nodes.map(node => node.type === "match" && node.opponentId === character.id && weakenedSkills.length
      ? { ...node, abilities: bindings.map((binding, index) => ({ slot: `rematch:${index}`, binding, overrides: [] })) } : node)
  }) };
}

export function pendingInvitationEntries(save: LongTermSave) {
  return pendingCharacterChallenges(save).flatMap(definition => {
    const character = getCharacterMetadata(definition.ownerId);
    if (!character) return [];
    const progress = encounterUnlockProgress(definition, save.defeats, CHARACTER_CATALOG);
    const multiple = getEncounterFlows().filter(candidate => candidate.ownerId === character.id).length > 1;
    return [{ id: definition.id, character, progress, label: multiple ? definition.name : character.name,
      subtitle: multiple ? definition.description : undefined,
      description: progress.unlocked ? "挑战开启" : `${definition.unlock.type === "defeat-faction-count" ? "击败同阵营角色" : "击败角色"} ${progress.current}/${progress.required}` }];
  });
}
