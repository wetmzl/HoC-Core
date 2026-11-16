import { describe, expect, it } from "vitest";
import { replayStoryResources, triggeredStorySceneIds, unlockedStorySceneIds } from "./story-replay";
import { StorySceneSchema } from "../core/story/schema";
import type { PublicCondition } from "../core/events/triggers";
import { emptyStorySave } from "./story-checkpoint";
import { StoryDirector } from "./story-director";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { PersistenceService } from "../persistence/save-service";
import { createDefaultSave } from "../persistence/boot";
import type { ExtensionResource } from "../content/packages/resources";
import { prepareStoryContent } from "../content/packages/stories";
import manifestJson from "../../public/characters/official-story/hocpkg-info.json";
import { HocpkgManifestSchema } from "../content/packages/schema";

const manifest = HocpkgManifestSchema.parse(manifestJson);
const original = { entry: "hello", nodes: [
  { id: "hello", type: "say", segments: [{ text: "Hello" }], next: "invite" },
  { id: "invite", type: "command", command: { type: "core.encounter.invite", apiVersion: 1, args: { characterId: "llama" } }, next: "end" },
  { id: "end", type: "end" }
] };
const resource = { descriptor: { id: "replay", type: "story.scene", apiVersion: 1, entry: "resources/opening.json", requires: [] },
  packageId: "hoc-core/official-story", packageManifest: manifest, value: original, resolvePath: (path: string) => path } as ExtensionResource;

describe("notebook replay isolation", () => {
  const progressFact = (key: string): PublicCondition => ({ type: "compare",
    left: { type: "query", query: { id: "context.value", key } }, operator: "eq", right: { type: "literal", value: true } });
  const archiveScene = (id: string, archiveUnlock?: PublicCondition) => ({ id, definition: StorySceneSchema.parse({
    entry: "end", nodes: [{ id: "end", type: "end" }], ...(archiveUnlock ? { archiveUnlock } : {})
  }) });

  it("unions observed scenes with progress eligibility without modifying either save", () => {
    const save = { ...emptyStorySave(), completed: [{ id: "1", sceneId: "neutral#observed", status: "skipped" as const }] };
    const progress = createDefaultSave(); progress.defeats = [{ opponentId: "visitor", timestamp: new Date(0).toISOString() }];
    const before = structuredClone({ save, progress });
    const scenes = [archiveScene("neutral#eligible", progressFact("progression.defeated.visitor")), archiveScene("neutral#legacy"),
      archiveScene("neutral#locked", progressFact("progression.defeated.other"))];
    expect([...unlockedStorySceneIds(save, scenes, progress)]).toEqual(["neutral#observed", "neutral#eligible"]);
    expect({ save, progress }).toEqual(before);
    expect([...unlockedStorySceneIds(undefined, scenes, null)]).toEqual([]);
  });

  it.each(["completedFlows", "completedChallenges"] as const)("reads %s as completed flow facts", field => {
    const progress = createDefaultSave(); progress[field] = ["neutral-trial"];
    const scene = archiveScene("neutral#ending", progressFact("progression.completedFlows.neutral-trial"));
    expect([...unlockedStorySceneIds(undefined, [scene], progress)]).toEqual([scene.id]);
    expect([...unlockedStorySceneIds(undefined, [scene], createDefaultSave())]).toEqual([]);
  });

  it("supports combined progress conditions without providing a live match or triggering event", () => {
    const progress = createDefaultSave(); progress.defeats = [{ opponentId: "visitor", timestamp: new Date(0).toISOString() }];
    const scene = archiveScene("neutral#ending", { type: "all", conditions: [progressFact("progression.defeated.visitor"),
      { type: "any", conditions: [progressFact("progression.completedFlows.a"), progressFact("progression.completedFlows.b")] }] });
    expect(unlockedStorySceneIds(undefined, [scene], progress).size).toBe(0);
    progress.completedFlows = ["b"];
    expect(unlockedStorySceneIds(undefined, [scene], progress).has(scene.id)).toBe(true);
    const eventScene = archiveScene("neutral#event", { type: "not", condition: { type: "compare",
      left: { type: "query", query: { id: "event.data", key: "result" } }, operator: "eq", right: { type: "literal", value: "defeat" } } });
    expect(unlockedStorySceneIds(undefined, [eventScene], progress).size).toBe(0);
    expect(StorySceneSchema.safeParse({ ...scene.definition, archiveUnlock: { type: "unknown" } }).success).toBe(false);
  });

  it("only exposes triggered scenes including skipped and interrupted playbacks", () => {
    const save = { ...emptyStorySave(), completed: [
      { id: "1", sceneId: "example/story#skipped", status: "skipped" as const },
      { id: "2", sceneId: "example/story#interrupted", status: "interrupted" as const }
    ] };
    expect([...triggeredStorySceneIds(save)]).toEqual(["example/story#skipped", "example/story#interrupted"]);
    expect(triggeredStorySceneIds(undefined).size).toBe(0);
  });
  it("projects command nodes into no-ops without mutating installed resources", async () => {
    const resources = { "story.scene": [resource], "story.binding": [resource] };
    const projected = replayStoryResources(resources);
    expect(projected["story.binding"]).toEqual([]);
    expect(original.nodes[1].type).toBe("command");
    const content = prepareStoryContent(projected["story.scene"]);
    const source = { longTerm: createDefaultSave(), runtime: null };
    const driver = new MemorySaveStorageDriver(source), repository = new PersistenceService(driver);
    let commands = 0;
    const replay = new StoryDirector({ repository, catalog: () => content, projectCommand: (_intent, snapshot) => { commands++; return snapshot; } });
    await replay.initialize(); await replay.enqueue("hoc-core/official-story#replay");
    await replay.advance(); await replay.flush();
    expect(replay.state.save.completed).toHaveLength(1);
    expect(replay.state.save.completed[0].receipts).toEqual([]);
    expect(commands).toBe(0);
    expect((await repository.readSnapshot()).longTerm).toEqual(source.longTerm);
    expect((await repository.readSnapshot()).runtime).toBeNull();
    expect(replay.state.save.once).toEqual([]);
    replay.dispose();
  });
});
