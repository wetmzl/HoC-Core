import { getActiveBustLimit, getLegalActions, previewComparisonScores } from "../match/reducer";
import type { Action, Actor, MatchState } from "../match/types";
import { getPlayerSkillDefinition } from "../skills/definitions";

export interface PublicSkillLifetime {
  readonly definitionId: string;
  readonly instanceId?: string;
  readonly hasLifetime: boolean;
}
/** Host-produced semantic values. A standalone SDK must never reconstruct these from its own registry. */
export interface PublicMatchReadModel {
  readonly legalActionTypes: readonly Action["type"][];
  readonly playablePlayerSkill: boolean;
  readonly activeBustLimits: Readonly<Record<Actor, number>>;
  readonly comparisonModified: boolean;
  readonly passiveSkillPresent: boolean;
  readonly skillLifetimes: readonly PublicSkillLifetime[];
}

/** Capture with the owning host's installed content; no cache survives a registry change. */
export function capturePublicMatchReadModel(state: MatchState): PublicMatchReadModel {
  const actions = getLegalActions(state);
  const cards = state.playerSkills.cards.filter(card => card.owner === "player");
  const scores = previewComparisonScores(state);
  const lifetimes: PublicSkillLifetime[] = cards.map(card => {
    const definition = getPlayerSkillDefinition(card.definitionId, card.level);
    return Object.freeze({ definitionId: card.definitionId, instanceId: card.instanceId,
      hasLifetime: Boolean(definition && (definition.category === "active" || definition.ttl)) });
  });
  for (const definitionId of state.playerSkills.drawOffer?.candidateDefinitionIds ?? []) {
    const definition = getPlayerSkillDefinition(definitionId);
    lifetimes.push(Object.freeze({ definitionId, hasLifetime: Boolean(definition && (definition.category === "active" || definition.ttl)) }));
  }
  return Object.freeze({
    legalActionTypes: Object.freeze([...new Set(actions.map(action => action.type))]),
    playablePlayerSkill: actions.some(action => action.type === "PLAY_ABILITY" && cards.some(card => card.instanceId === action.instanceId)),
    activeBustLimits: Object.freeze({ player: getActiveBustLimit(state, "player"), opponent: getActiveBustLimit(state, "opponent") }),
    comparisonModified: scores.scores.player !== scores.baseScores.player || scores.scores.opponent !== scores.baseScores.opponent,
    passiveSkillPresent: cards.some(card => getPlayerSkillDefinition(card.definitionId, card.level)?.category === "passive"),
    skillLifetimes: Object.freeze(lifetimes)
  });
}
