import trial from "../fixtures/boss-trial.json";
import { EncounterFlowResourceSchema, installEncounterFlows } from "../../src/content/encounter-flows/catalog";

/** Browser-only test setup; the trial is never included in shipped content. */
export function installBossTrial(): void {
  installEncounterFlows([EncounterFlowResourceSchema.parse(trial)]);
}
