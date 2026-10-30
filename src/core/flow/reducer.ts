import type { AbilityBinding } from "../abilities/types";
import type { PlayerSkillCarryover } from "../abilities/carryover";
import type { CreateMatchOptions } from "../match/reducer";
import type { MatchState } from "../match/types";
import type { GunState } from "../roulette/types";
import { removeBullets } from "../roulette/roulette";
import { FlowDefinitionSchema, FlowRunSchema, type EncounterRewardKind, type EncounterRewards, type FlowDefinition, type FlowNode, type FlowProgress, type FlowRoute, type FlowRun } from "./schema";

export function createFlow(id: string, seed: string): FlowProgress {
  return { id, seed, phase: "selection", completedNodes: [], encounterIndex: 0, encounter: null, result: null };
}
export function createFlowRun(id: string, seed: string, definition: FlowDefinition): FlowRun {
  const parsed = FlowDefinitionSchema.parse(definition);
  return FlowRunSchema.parse({ ...createFlow(id, seed), definition: parsed, playerGun: { ...parsed.playerGun }, playerComparisonBonus: 0 });
}
export function availableFlowNodes(definition: FlowDefinition, run: FlowProgress): readonly FlowNode[] {
  if (run.phase !== "selection") return [];
  return definition.nodes.filter(node => (!run.nextNodeId || run.nextNodeId === node.id)
    && (node.repeatable || !run.completedNodes.includes(node.id)) && node.requires.every(id => run.completedNodes.includes(id)));
}
export function startFlowNode(definition: FlowDefinition, run: FlowProgress, nodeId: string): FlowProgress {
  if (!availableFlowNodes(definition, run).some(node => node.id === nodeId)) return run;
  const encounterIndex = run.encounterIndex + 1;
  if (!Number.isSafeInteger(encounterIndex)) return run;
  const { nextNodeId: _next, ...progress } = run;
  return { ...progress, phase: "encounter", encounterIndex, encounter: { nodeId, matchId: `${run.id}:${encounterIndex}` } };
}
export function flowNodeAbilities(node: FlowNode, run: FlowProgress): readonly AbilityBinding[] | undefined {
  return node.abilities?.map(slot => slot.overrides.find(override => override.afterAny.some(id => run.completedNodes.includes(id)))?.binding ?? slot.binding);
}
export function flowEncounterPlan(definition: FlowDefinition, run: FlowProgress, resources: {
  readonly gun: GunState; readonly skills?: PlayerSkillCarryover; readonly comparisonBonus: number;
}): { opponentId: string; seed: string; options: CreateMatchOptions } {
  const encounter = run.encounter;
  const node = definition.nodes.find(node => node.id === encounter?.nodeId);
  if (run.phase !== "encounter" || !encounter || !node) throw new Error("Flow has no active node");
  return { opponentId: node.opponentId, seed: `${run.seed}:encounter:${run.encounterIndex}`, options: {
    id: encounter.matchId, playerGun: { ...resources.gun }, opponentGun: node.opponentGun,
    playerCarryover: resources.skills, comparisonBonuses: { player: resources.comparisonBonus, opponent: 0 },
    ...(node.abilities ? { opponentAiSkills: flowNodeAbilities(node, run) } : {})
  } };
}
export function ownedFlowNode(definition: FlowDefinition, run: FlowProgress, match: MatchState): FlowNode | undefined {
  const node = definition.nodes.find(node => node.id === run.encounter?.nodeId);
  return run.phase === "encounter" && run.encounter?.matchId === match.id && node?.opponentId === match.opponentId ? node : undefined;
}
function outcomeKind(match: MatchState): "victory" | "defeat" | "escaped" | undefined {
  if (match.status !== "finished" || !match.outcome) return undefined;
  return match.outcome.reason === "escaped" ? "escaped"
    : match.outcome.winner === "player" && match.outcome.reason === "opponent-killed" ? "victory" : "defeat";
}
/** Settlement presentation and persistence use the same actual outcome route. */
export function flowOutcomeRoute(definition: FlowDefinition, run: FlowProgress, match: MatchState): FlowRoute | undefined {
  const node = ownedFlowNode(definition, run, match), outcome = outcomeKind(match);
  return node && outcome ? node.routes[outcome] : undefined;
}
export function flowRecordsResult(definition: FlowDefinition, run: FlowProgress, match: MatchState): boolean {
  const node = ownedFlowNode(definition, run, match), route = flowOutcomeRoute(definition, run, match);
  return !!node && !!route && (node.recordResult === "always" || (node.recordResult !== "never" && route.type === "finish"));
}
export function flowVictoryRewards(definition: FlowDefinition, run: FlowProgress, match: MatchState): EncounterRewards | undefined {
  return outcomeKind(match) === "victory" ? ownedFlowNode(definition, run, match)?.victoryRewards : undefined;
}
export function pendingFlowRewards(run: FlowRun, match: MatchState): EncounterRewardKind[] {
  const rewards = flowVictoryRewards(run.definition, run, match);
  const kinds: EncounterRewardKind[] = ["skillDraws", "removeBullets", "pointAdvantage"];
  return kinds.filter(kind => rewards?.[kind] && !run.encounter?.claimedRewards?.includes(kind));
}
/** A receipt and its resource change form one state transition for the owner to commit. */
export function claimFlowReward(run: FlowRun, match: MatchState, kind: EncounterRewardKind): { run: FlowRun; match: MatchState } {
  if (!pendingFlowRewards(run, match).includes(kind)) return { run, match };
  const amount = flowVictoryRewards(run.definition, run, match)?.[kind];
  const effect = amount ? applyEncounterReward(match, run.playerComparisonBonus, kind, amount) : null;
  if (!effect) return { run, match };
  return { run: { ...run, playerGun: effect.match.roulette.player, playerComparisonBonus: effect.comparisonBonus,
    encounter: { ...run.encounter!, claimedRewards: [...(run.encounter?.claimedRewards ?? []), kind] } }, match: effect.match };
}
/** Only acknowledged outcomes advance a node; persistence commits this together with the next phase. */
export function finishFlowNode(definition: FlowDefinition, run: FlowProgress, match: MatchState): FlowProgress {
  const node = ownedFlowNode(definition, run, match), route = flowOutcomeRoute(definition, run, match);
  if (!node || !route || match.scene !== "lobby") return run;
  const outcome = outcomeKind(match);
  const { nextNodeId: _next, ...progress } = run;
  return { ...progress, encounter: null,
    completedNodes: outcome === "victory" ? [...new Set([...run.completedNodes, node.id])] : run.completedNodes,
    phase: route.type === "finish" ? "finished" : "selection",
    result: route.type === "finish" ? route.result : null,
    ...(route.type === "node" ? { nextNodeId: route.nodeId } : {})
  };
}
/** Resource effects are independent of a node's role, character, or navigation policy. */
export function applyEncounterReward(match: MatchState, comparisonBonus: number, kind: EncounterRewardKind, amount: number): {
  match: MatchState; comparisonBonus: number;
} | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const drawCount = match.playerSkills.drawCount + (kind === "skillDraws" ? amount : 0);
  const bonus = comparisonBonus + (kind === "pointAdvantage" ? amount : 0);
  if (!Number.isSafeInteger(drawCount) || !Number.isSafeInteger(bonus)) return null;
  return { comparisonBonus: bonus, match: { ...match,
    playerSkills: { ...match.playerSkills, drawCount },
    roulette: { ...match.roulette, player: kind === "removeBullets" ? removeBullets(match.roulette.player, amount) : match.roulette.player }
  } };
}
