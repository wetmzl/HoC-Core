import type { AutosaveController } from "../persistence/autosave";

/** Storage/view access for consumers; domain actions enter through MatchSession.dispatch. */
export type ActiveMatchPersistence = Pick<AutosaveController, "getState" | "getSave" | "updateSave" | "flush">;
