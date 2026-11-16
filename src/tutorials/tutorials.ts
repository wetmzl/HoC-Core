import type { TutorialProgress } from "../persistence/schema";

export const ADULT_CONTENT_WARNING_ID = "adult-content-warning";
export const THIRD_PARTY_CONTENT_WARNING_ID = "third-party-content-warning";

export function completeTutorial(progress: TutorialProgress, tutorialId: string): TutorialProgress {
  if (progress.completedIds.includes(tutorialId)) return progress;
  return { completedIds: [...progress.completedIds, tutorialId] };
}
