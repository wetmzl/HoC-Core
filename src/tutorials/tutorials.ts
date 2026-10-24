export type TutorialCue = "skill-draw-available";

export interface TutorialImageResource {
  readonly type: "image";
  readonly src: string;
  readonly alt: string;
  readonly caption?: string;
}

export type TutorialResource = TutorialImageResource;

export interface TutorialPage {
  readonly body: string;
  readonly resources?: readonly TutorialResource[];
}

export interface TutorialDefinition {
  readonly id: string;
  readonly title: string;
  readonly cue: TutorialCue;
  readonly tags: readonly string[];
  readonly pages: readonly [TutorialPage, ...TutorialPage[]];
}

export interface TutorialProgress {
  readonly completedIds: readonly string[];
}

export const ADULT_CONTENT_WARNING_ID = "adult-content-warning";
export const THIRD_PARTY_CONTENT_WARNING_ID = "third-party-content-warning";

export const TUTORIAL_DEFINITIONS: readonly TutorialDefinition[] = Object.freeze([
  Object.freeze({
    id: "skill-draw-system",
    title: "技能抽卡系统",
    cue: "skill-draw-available",
    tags: Object.freeze(["skills"]),
    pages: Object.freeze([Object.freeze({
      body: "你的对手会作弊，但你也可以。点击右下角的金色按钮抽取你的技能卡。"
    })]) as readonly [TutorialPage]
  })
]);

export function isTutorialCompleted(definition: TutorialDefinition, progress: TutorialProgress): boolean {
  return progress.completedIds.includes(definition.id);
}

export function firstTutorialForCue(cue: TutorialCue, progress: TutorialProgress, skipAll = false): TutorialDefinition | null {
  if (skipAll) return null;
  return TUTORIAL_DEFINITIONS.find((definition) => definition.cue === cue && !isTutorialCompleted(definition, progress)) ?? null;
}

export function completeTutorial(progress: TutorialProgress, tutorialId: string): TutorialProgress {
  if (progress.completedIds.includes(tutorialId)) return progress;
  return { completedIds: [...progress.completedIds, tutorialId] };
}

export function completeTutorialsByTag(progress: TutorialProgress, tag: string): TutorialProgress {
  const matchingIds = TUTORIAL_DEFINITIONS.filter((definition) => definition.tags.includes(tag)).map((definition) => definition.id);
  if (matchingIds.length === 0) return progress;
  const completedIds = [...new Set([...progress.completedIds, ...matchingIds])];
  return completedIds.length === progress.completedIds.length ? progress : { completedIds };
}
