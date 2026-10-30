import type { ChallengeDefinition, ChallengeRun } from "./schema";
import type { FlowDefinition, FlowProgress, FlowRun } from "../flow/schema";
import { BOSS_GUN_CAPACITY } from "../roulette/loadout";
import { createGun } from "../roulette/roulette";

export const guardNodeId = (characterId: string): string => `guard:${characterId}`;
export const BOSS_NODE_ID = "boss";

/** Compatibility adapter for game.boss-challenge API 1–6. Its fixed rules do not constrain other flows. */
export function challengeFlow(definition: ChallengeDefinition): FlowDefinition {
  return { id: definition.id, completionId: definition.id, playerGun: createGun(BOSS_GUN_CAPACITY),
    presentation: { resultActions: "return", title: definition.name, backgroundCharacterId: definition.bossId, description: "削弱阶段。做好准备，或者直视神明的怒火……。", continueLabel: "返回四人选择", abandonLabel: "终止挑战", comparisonLabel: "削弱说明" }, nodes: [
    ...definition.guards.map(guard => ({ id: guardNodeId(guard.characterId), opponentId: guard.characterId,
      requires: [], repeatable: false, opponentGun: createGun(6), victoryRewards: guard.victoryRewards,
      recordResult: "never" as const,
      presentation: { layout: "card" as const, tableTitle: "守卫战", objective: "击败 {name} 以削弱", completedLabel: "已击败",
        exit: { label: "逃跑", title: "退出本场战斗；保留左轮、剩余技能和抽数，再进入时重新开局" } },
      routes: { victory: { type: "selection" as const }, defeat: { type: "selection" as const }, escaped: { type: "selection" as const } }
    })),
    { id: BOSS_NODE_ID, opponentId: definition.bossId, requires: [], repeatable: false, opponentGun: createGun(BOSS_GUN_CAPACITY),
      recordResult: "always", presentation: { layout: "action", tableTitle: "Boss 战", objective: "挑战 {name}", progressLabel: "已削弱" },
      abilities: definition.bossAbilities.map(slot => ({ slot: slot.slot, label: slot.label, binding: slot.binding, overrides: [{
        afterAny: definition.guards.filter(guard => guard.suppresses.includes(slot.slot)).map(guard => guardNodeId(guard.characterId)),
        binding: slot.weakenedBinding ?? { ...slot.binding, enabled: false }
      }].filter(override => override.afterAny.length > 0) })),
      routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } }
    }
  ] };
}
export function challengeProgress(run: ChallengeRun): FlowProgress {
  return { id: run.id, seed: run.seed, phase: run.phase, encounterIndex: run.encounterIndex,
    completedNodes: run.defeatedGuards.map(guardNodeId), result: run.result,
    encounter: run.encounter ? { nodeId: run.encounter.kind === "boss" ? BOSS_NODE_ID : guardNodeId(run.encounter.characterId), matchId: run.encounter.matchId } : null
  };
}
/** The legacy challenge state is projected once at the compatibility boundary. */
export function challengeFlowRun(run: ChallengeRun): FlowRun {
  const progress = challengeProgress(run);
  return { ...progress, definition: challengeFlow(run.definition),
    ...(run.encounter ? { encounter: { ...progress.encounter!, claimedRewards: run.encounter.claimedRewards } } : {}),
    playerGun: run.playerGun, playerComparisonBonus: run.playerComparisonBonus };
}
export function withFlowProgress(run: ChallengeRun, progress: FlowProgress): ChallengeRun {
  const node = challengeFlow(run.definition).nodes.find(node => node.id === progress.encounter?.nodeId);
  return { ...run, phase: progress.phase, encounterIndex: progress.encounterIndex, result: progress.result,
    defeatedGuards: progress.completedNodes.flatMap(id => run.definition.guards.filter(guard => guardNodeId(guard.characterId) === id).map(guard => guard.characterId)),
    encounter: progress.encounter && node ? { kind: node.id === BOSS_NODE_ID ? "boss" : "guard", characterId: node.opponentId, matchId: progress.encounter.matchId } : null
  };
}
