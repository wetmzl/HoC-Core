import type { ExtensionResource } from "../content/packages/resources";
import { StorySceneSchema } from "../core/story/schema";
import type { StoryNode } from "../core/story/types";
import { createPublicEventBatch } from "../core/events/public-events";
import { evaluatePublicCondition } from "../core/events/triggers";
import type { LongTermSave } from "../persistence/schema";
import type { StorySceneEntry } from "./story-director";
import { validateStorySave } from "./story-checkpoint";

/** Triggered includes completed, skipped and interrupted scenes, without inventing old progress. */
export function triggeredStorySceneIds(story: unknown): ReadonlySet<string> {
  const save = validateStorySave(story);
  return new Set([...save.completed.map(entry => entry.sceneId), ...save.queue.map(entry => entry.sceneId),
    ...(save.active ? [save.active.request.sceneId] : [])]);
}

/** Archive eligibility is a read-only view, separate from the durable trigger ledger. */
export function unlockedStorySceneIds(story: unknown, scenes: readonly Pick<StorySceneEntry, "id" | "definition">[],
  progress: Pick<LongTermSave, "defeats" | "completedFlows" | "completedChallenges"> | null): ReadonlySet<string> {
  const unlocked = new Set(triggeredStorySceneIds(story));
  const values: Record<string, boolean> = {};
  for (const defeat of progress?.defeats ?? []) values[`progression.defeated.${defeat.opponentId}`] = true;
  // Legacy challenge completion and current flow completion identify the same progress fact.
  for (const id of [...(progress?.completedFlows ?? []), ...(progress?.completedChallenges ?? [])]) values[`progression.completedFlows.${id}`] = true;
  const batch = createPublicEventBatch({ id: "story-archive-progress", facts: [], context: { values } });
  for (const scene of scenes) if (scene.definition.archiveUnlock
    && evaluatePublicCondition(scene.definition.archiveUnlock, { batch }) === true) unlocked.add(scene.id);
  return unlocked;
}

/** Readback keeps narrative and choices but can never execute gameplay commands. */
export function replayStoryResources(resources: Readonly<Record<string, readonly ExtensionResource[]>>): Readonly<Record<string, readonly ExtensionResource[]>> {
  return { ...resources, "story.binding": [], "story.scene": (resources["story.scene"] ?? []).map(resource => {
    const scene = StorySceneSchema.parse(resource.value);
    return { ...resource, value: { ...scene, nodes: scene.nodes.map((node): StoryNode => node.type === "command"
      ? { id: node.id, type: "set", values: {}, next: node.next } : node) } };
  }) };
}
