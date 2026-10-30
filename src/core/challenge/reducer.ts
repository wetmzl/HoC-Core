import { createFlow, startFlowNode, finishFlowNode, flowNodeAbilities, flowVictoryRewards, pendingFlowRewards, claimFlowReward } from "../flow/reducer";
import { challengeFlow, challengeProgress, challengeFlowRun, withFlowProgress, guardNodeId, BOSS_NODE_ID } from "./flow";
import type { MatchState } from "../match/types";
import type { CharacterDefeatRecord } from "../progression/defeats";
import { ChallengeDefinitionSchema, type ChallengeDefinition, type ChallengeRun, type ChallengeVictoryRewards, type ChallengeVictoryRewardKind } from "./schema";

export interface ChallengeCharacter { readonly id: string; readonly faction?: string; }
export function challengeUnlockProgress(definition: ChallengeDefinition, defeats: readonly CharacterDefeatRecord[], characters: readonly ChallengeCharacter[] = []): { current: number; required: number; unlocked: boolean } {
  const ids = new Set(defeats.map(record => record.opponentId));
  const unlock = definition.unlock;
  const required = unlock.type === "defeat-character" ? 1 : unlock.count;
  const current = unlock.type === "defeat-character" ? Number(ids.has(unlock.characterId))
    : unlock.type === "defeat-count" ? ids.size
      : new Set(characters.filter(character => character.id !== definition.bossId && character.faction === definition.faction && ids.has(character.id)).map(character => character.id)).size;
  return { current: Math.min(current, required), required, unlocked: current >= required };
}
export function isChallengeUnlocked(definition: ChallengeDefinition, defeats: readonly CharacterDefeatRecord[], characters: readonly ChallengeCharacter[] = []): boolean {
  return challengeUnlockProgress(definition, defeats, characters).unlocked;
}
export function createChallenge(seed: string, definition: ChallengeDefinition, defeats: readonly CharacterDefeatRecord[], characters: readonly ChallengeCharacter[] = []): ChallengeRun {
  definition = ChallengeDefinitionSchema.parse(definition);
  if (!isChallengeUnlocked(definition, defeats, characters)) throw new Error("Boss 挑战尚未解锁");
  const flow = challengeFlow(definition);
  const progress = createFlow(`challenge-${seed}`, seed);
  return { id: progress.id, seed, definition, phase: progress.phase, defeatedGuards: [], playerGun: flow.playerGun,
    playerComparisonBonus: 0, encounter: null, encounterIndex: progress.encounterIndex, result: null };
}
export function startEncounter(run: ChallengeRun, characterId: string): ChallengeRun {
  const progress = challengeProgress(run);
  const next = startFlowNode(challengeFlow(run.definition), progress, characterId === run.definition.bossId ? BOSS_NODE_ID : guardNodeId(characterId));
  return next === progress ? run : withFlowProgress(run, next);
}
export function challengeBossAbilities(run: ChallengeRun) {
  const definition = challengeFlow(run.definition);
  return flowNodeAbilities(definition.nodes.find(node => node.id === BOSS_NODE_ID)!, challengeProgress(run))!;
}
/** Accept only the acknowledged encounter that this run currently owns. Replays are inert. */
export function finishEncounter(run: ChallengeRun, match: MatchState): ChallengeRun {
  const progress = challengeProgress(run);
  const next = finishFlowNode(challengeFlow(run.definition), progress, match);
  return next === progress ? run : { ...withFlowProgress(run, next), playerGun: { ...match.roulette.player } };
}
export function abandonChallenge(run: ChallengeRun): ChallengeRun {
  return run.phase === "selection" ? { ...run, phase: "finished", result: "abandoned" } : run;
}

export function guardVictoryReward(run: ChallengeRun, match: MatchState): ChallengeVictoryRewards | undefined {
  return flowVictoryRewards(challengeFlow(run.definition), challengeProgress(run), match);
}
export function pendingGuardRewards(run: ChallengeRun, match: MatchState): ChallengeVictoryRewardKind[] {
  return pendingFlowRewards(challengeFlowRun(run), match);
}
/** Keep the legacy return shape while all eligibility, receipt and resource rules remain generic. */
export function claimGuardVictoryReward(run: ChallengeRun, match: MatchState, kind: ChallengeVictoryRewardKind): { run: ChallengeRun; match: MatchState } {
  const flow = challengeFlowRun(run);
  const next = claimFlowReward(flow, match, kind);
  if (next.run === flow) return { run, match };
  return { run: { ...run, playerGun: next.run.playerGun, playerComparisonBonus: next.run.playerComparisonBonus,
    encounter: { ...run.encounter!, claimedRewards: [...next.run.encounter!.claimedRewards!] } }, match: next.match };
}
