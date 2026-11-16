import type { StoryRun, StoryScene, StoryStage } from "./types";

export interface StoryComposition {
  readonly speaker?: string;
  readonly foreground?: string;
  readonly atmosphere: boolean;
}

/** Source keys take priority over display names, including explicitly hidden actors. */
export function resolveStorySpeakerActor(stage: StoryStage, scene: StoryScene | undefined,
  sourceSpeaker: string | undefined, resolvedSpeaker = sourceSpeaker): string | undefined {
  const visible = Object.values(stage.actors).filter(actor => actor.visible && actor.image);
  if (sourceSpeaker && (Object.hasOwn(stage.actors, sourceSpeaker)
    || scene?.actors && Object.hasOwn(scene.actors, sourceSpeaker))) {
    return visible.find(actor => actor.id === sourceSpeaker)?.id;
  }
  const named = visible.filter(actor => scene?.actors && Object.hasOwn(scene.actors, actor.id)
    && scene.actors[actor.id].name === resolvedSpeaker);
  return named.length === 1 ? named[0].id : undefined;
}

/** Foreground retention is independent of the current line's lighting emphasis. */
export function storyComposition(run: StoryRun, scene: StoryScene | undefined): StoryComposition {
  const node = scene?.nodes.find(candidate => candidate.id === run.cursor);
  const sourceSpeaker = node?.type === "say" ? node.speaker : run.waiting?.type === "say" ? run.waiting.node.speaker : undefined;
  const speaker = run.waiting?.type === "say"
    ? resolveStorySpeakerActor(run.stage, scene, sourceSpeaker, run.waiting.node.speaker) : undefined;
  const previous = run.lastSpeaker?.sceneId === run.sceneId ? run.stage.actors[run.lastSpeaker.actorId] : undefined;
  const foreground = speaker ?? (previous?.visible && previous.image ? previous.id : undefined);
  return { speaker, foreground, atmosphere: run.waiting?.type === "say" && !speaker };
}
