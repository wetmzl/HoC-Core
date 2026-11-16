import { describe, expect, it } from "vitest";
import { createDefaultSave } from "../persistence/boot";
import { LongTermSaveSchema } from "../persistence/schema";
import { completeTutorial, ADULT_CONTENT_WARNING_ID, THIRD_PARTY_CONTENT_WARNING_ID } from "./tutorials";

describe("tutorial progress compatibility", () => {
  it("preserves retired, plugin and unknown IDs when confirming startup and round-tripping a save", () => {
    const save = createDefaultSave();
    save.tutorialProgress.completedIds = ["skill-draw-system", "content-import-selection", "plugin:test/guide:intro", "future-tutorial"];
    const progress = completeTutorial(completeTutorial(save.tutorialProgress, ADULT_CONTENT_WARNING_ID), THIRD_PARTY_CONTENT_WARNING_ID);
    const restored = LongTermSaveSchema.parse(JSON.parse(JSON.stringify({ ...save, tutorialProgress: progress })));
    expect(restored.tutorialProgress.completedIds).toEqual([
      ...save.tutorialProgress.completedIds, ADULT_CONTENT_WARNING_ID, THIRD_PARTY_CONTENT_WARNING_ID
    ]);
    expect(completeTutorial(restored.tutorialProgress, ADULT_CONTENT_WARNING_ID)).toBe(restored.tutorialProgress);
    expect(restored.skipTutorial).toBe(false);
  });

  it("still reads old saves without tutorial progress and preserves the skip preference", () => {
    const { tutorialProgress: _, ...legacy } = createDefaultSave();
    const restored = LongTermSaveSchema.parse({ ...legacy, skipTutorial: true });
    expect(restored.tutorialProgress.completedIds).toEqual([]);
    expect(restored.skipTutorial).toBe(true);
  });
});
