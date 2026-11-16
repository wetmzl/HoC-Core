import type { MatchState } from '../../src/core/match/types';
import { createProgramRun, programMatchId } from '../../src/core/flow/program-engine';
import { singleMatchProgram } from '../../src/core/flow/program-templates';
import { createRuntimeSave as createLegacyRuntimeSave } from '../../src/persistence/boot';
export { createDefaultSave } from '../../src/persistence/boot';

/** Current tables have one program owner; historical-save tests use boot.ts directly. */
export function createRuntimeSave(match: MatchState, now = new Date().toISOString()) {
  const snapshot = createLegacyRuntimeSave(match, now);
  const program = createProgramRun(`fixture-${match.id}`, match.seed, singleMatchProgram({ opponentId: match.opponentId }));
  return { ...snapshot, activeProgram: { ...program, resources: null },
    activeMatch: { ...match, id: programMatchId(program) } };
}
