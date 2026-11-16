import { clearProgramWrites } from "../core/flow/program-engine";
import type { ProgramRun } from "../core/flow/program";
import type { MatchState } from "../core/match/types";
import { CHARACTER_CATALOG } from "../content/characters/catalog";
import { acknowledgeMatchResult } from "../persistence/boot";
import { grantDeclaredSkinUnlocks } from "../persistence/skin-unlocks";
import { CURRENT_GAME_VERSION, CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT, type LongTermSave, type RuntimeSave } from "../persistence/schema";

/** One materialization path for both ordinary flow commands and story commands. */
export function projectProgramCheckpoint(save: LongTermSave, run: ProgramRun, match: MatchState | null = null): { longTerm: LongTermSave; runtime: RuntimeSave | null } {
  for (const write of run.pendingWrites) {
    if (write.type === "record-result") {
      const receipt = run.results.find(item => item.id === write.resultId);
      if (!receipt) throw new Error("结算结果不存在");
      save = acknowledgeMatchResult(save, receipt.match);
    } else {
      save = { ...save, completedFlows: [...new Set([...(save.completedFlows ?? []), write.flowId])],
        ...(write.legacyChallengeId ? { completedChallenges: [...new Set([...(save.completedChallenges ?? []), write.legacyChallengeId])] } : {}) };
    }
  }
  if (run.pendingWrites.length) save = grantDeclaredSkinUnlocks(save, CHARACTER_CATALOG);
  const durable = clearProgramWrites(run);
  return { longTerm: save, runtime: durable.status === "finished" ? null : {
    format: RUNTIME_SAVE_FORMAT, schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION, gameVersion: CURRENT_GAME_VERSION,
    updatedAt: new Date().toISOString(), activeProgram: durable, activeMatch: match
  } };
}
