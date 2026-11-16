import type { CheckpointSaveRepository } from "./repository";
import type { SaveTransfer } from "./json";
import { validateLongTermSave, CURRENT_GAME_VERSION } from "./schema";
import { validateStorySave } from "../runtime/story-checkpoint";
import { validateNotebookSave } from "./character-records";

/** Replacing a save replaces its story ledger in the same durable transaction. */
export async function replaceTransferredSave(repository: CheckpointSaveRepository, transfer: SaveTransfer): Promise<void> {
  const longTerm = validateLongTermSave({ ...transfer.longTerm, gameVersion: CURRENT_GAME_VERSION });
  const story = transfer.story === null ? null : validateStorySave(transfer.story);
  const notebook = transfer.notebook === undefined || transfer.notebook === null ? null : validateNotebookSave(transfer.notebook);
  await repository.projectSnapshot(snapshot => ({ ...snapshot, longTerm, runtime: null, story,
    ...(notebook !== null || snapshot.notebook !== undefined ? { notebook } : {}) }), { storyOnly: true, achievementOnly: true, notebookReplacement: true });
}
