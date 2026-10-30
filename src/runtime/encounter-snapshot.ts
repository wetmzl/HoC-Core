import type { ChallengeRun } from "../core/challenge/schema";
import { challengeFlowRun } from "../core/challenge/flow";
import type { FlowRun } from "../core/flow/schema";
import { singleEncounterFlow, singleEncounterProgress } from "../core/flow/single";
import type { MatchState } from "../core/match/types";
import { CURRENT_GAME_VERSION, CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT, type ChallengeMemory, type RuntimeSave } from "../persistence/schema";

export { challengeFlowRun } from "../core/challenge/flow";

export function singleMatchFlow(match: MatchState): FlowRun {
  return { ...singleEncounterProgress(match), definition: singleEncounterFlow(match.opponentId, match.roulette.player, match.roulette.opponent),
    playerGun: match.roulette.player, playerComparisonBonus: match.comparisonBonuses?.player ?? 0 };
}

export function runtimeFlow(snapshot: RuntimeSave | null): FlowRun | null {
  if (!snapshot) return null;
  const match = snapshot.activeMatch;
  if (snapshot.activeFlow) {
    const playerGun = match?.roulette.player ?? snapshot.activeFlow.playerGun;
    if (!playerGun) throw new Error("流程资源缺失");
    return { ...snapshot.activeFlow, playerGun };
  }
  if (snapshot.activeChallenge) {
    const playerGun = match?.roulette.player ?? snapshot.activeChallenge.playerGun;
    if (!playerGun) throw new Error("流程资源缺失");
    return challengeFlowRun({ ...snapshot.activeChallenge, playerGun });
  }
  return match ? singleMatchFlow(match) : null;
}

export function flowMemory(snapshot: RuntimeSave | null): ChallengeMemory {
  return snapshot?.flowMemory ?? snapshot?.challengeMemory ?? { player: null };
}

/** A table owns all live resources; selection owns only the carried resources. */
export function flowSnapshot(run: FlowRun, match: MatchState | null, memory: ChallengeMemory = { player: null }): RuntimeSave {
  const { playerGun, ...progress } = run;
  return { format: RUNTIME_SAVE_FORMAT, schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION,
    gameVersion: CURRENT_GAME_VERSION, updatedAt: new Date().toISOString(), activeMatch: match,
    ...(match ? { activeFlow: progress } : { activeFlow: { ...progress, playerGun }, flowMemory: memory }) };
}

/** Kept for existing internal consumers and fixtures of the legacy save contract. */
export function challengeSnapshot(run: ChallengeRun, match: MatchState | null, memory: ChallengeMemory = { player: null }): RuntimeSave {
  const { playerGun, ...progress } = run;
  return { format: RUNTIME_SAVE_FORMAT, schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION,
    gameVersion: CURRENT_GAME_VERSION, updatedAt: new Date().toISOString(), activeMatch: match,
    ...(match ? { activeChallenge: progress } : { activeChallenge: { ...progress, playerGun }, challengeMemory: memory }) };
}
