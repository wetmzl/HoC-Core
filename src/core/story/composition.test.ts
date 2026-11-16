import { describe, expect, it } from "vitest";
import { advanceStory, createStoryRun } from "./engine";
import { resolveStorySpeakerActor, storyComposition } from "./composition";
import { StoryRunSchema, StorySceneSchema } from "./schema";
import type { StoryEngineContext, StoryScene } from "./types";

const scene = (value: unknown): StoryScene => StorySceneSchema.parse(value);
const context = (scenes: Record<string, StoryScene>): StoryEngineContext => ({ resolveScene: id => scenes[id] });
const text = (id: string, next: string, speaker?: string) => ({ id, type: "say", ...(speaker ? { speaker } : {}), segments: [{ text: id }], next });

function twoActors() {
  return scene({ entry: "enter", actors: {
    first: { name: "First", image: "first.png", scale: .8 },
    second: { name: "Second", image: "second.png", scale: 1 }
  }, nodes: [
    { id: "enter", type: "present", action: { type: "stage", actors: [{ id: "first", layer: -2 }, { id: "second", layer: 1000 }] }, next: "first-line" },
    text("first-line", "narration", "first"), text("narration", "expression"),
    { id: "expression", type: "present", action: { type: "stage", actors: [{ id: "first", image: "first-smile.png" }] }, next: "player" },
    text("player", "second-line", "Player"), text("second-line", "hide", "Second"),
    { id: "hide", type: "present", action: { type: "stage", actors: [{ id: "second", visible: false }] }, next: "show" },
    { id: "show", type: "present", action: { type: "stage", actors: [{ id: "second", visible: true }] }, next: "after-exit" },
    text("after-exit", "end"), { id: "end", type: "end" }
  ] });
}

describe("story portrait composition", () => {
  it("retains the last portrait speaker through narration, player lines and expressions, including restored checkpoints", () => {
    const definition = twoActors(), host = context({ main: definition });
    let run = advanceStory(createStoryRun("main", host), host);
    expect(run.cursor).toBe("first-line");
    expect(storyComposition(run, definition)).toEqual({ speaker: "first", foreground: "first", atmosphere: false });
    const authoredLayers = Object.fromEntries(Object.values(run.stage.actors).map(actor => [actor.id, actor.layer]));
    run = advanceStory(run, host);
    expect(run.cursor).toBe("narration");
    run = StoryRunSchema.parse(JSON.parse(JSON.stringify(run)));
    expect(storyComposition(run, definition)).toEqual({ speaker: undefined, foreground: "first", atmosphere: true });
    run = advanceStory(run, host);
    expect(storyComposition(run, definition)).toEqual({ speaker: undefined, foreground: "first", atmosphere: false });
    run = advanceStory(run, host);
    expect(run.cursor).toBe("player");
    expect(run.stage.actors.first.image).toBe("first-smile.png");
    expect(storyComposition(run, definition)).toEqual({ speaker: undefined, foreground: "first", atmosphere: true });
    run = advanceStory(run, host);
    expect(storyComposition(run, definition)).toEqual({ speaker: "second", foreground: "second", atmosphere: false });
    expect(Object.fromEntries(Object.values(run.stage.actors).map(actor => [actor.id, actor.layer]))).toEqual(authoredLayers);
    run = advanceStory(run, host); // Wait for the exit action.
    run = advanceStory(run, host); // Exit applied, waiting for re-entry.
    expect(run.lastSpeaker).toBeUndefined();
    run = advanceStory(run, host);
    expect(run.cursor).toBe("after-exit");
    expect(storyComposition(run, definition).foreground).toBeUndefined();
  });

  it("clears retention when an actor exits and re-enters within the same action sequence", () => {
    const original = twoActors();
    const definition = scene({ ...original, nodes: original.nodes.map(node => node.id === "hide" && node.type === "present"
      ? { ...node, action: { type: "sequence", actions: [
        { type: "stage", remove: ["second"] }, { type: "stage", actors: [{ id: "second" }] }
      ] } } : node) });
    const host = context({ main: definition });
    let run = createStoryRun("main", host);
    for (let step = 0; run.cursor !== "second-line" && step < 20; step++) run = advanceStory(run, host);
    expect(run.lastSpeaker?.actorId).toBe("second");
    run = advanceStory(advanceStory(run, host), host);
    expect(run.cursor).toBe("show");
    expect(run.stage.actors.second.visible).toBe(true);
    expect(run.lastSpeaker).toBeUndefined();
    expect(storyComposition(run, definition).foreground).toBeUndefined();
  });

  it("reads legacy runs without retention and records their current keyed speaker before advancing", () => {
    const definition = twoActors(), host = context({ main: definition });
    const current = advanceStory(createStoryRun("main", host), host);
    const { lastSpeaker: _last, ...legacy } = current;
    const restored = StoryRunSchema.parse(JSON.parse(JSON.stringify(legacy)));
    expect(restored.lastSpeaker).toBeUndefined();
    const narration = advanceStory(restored, host);
    expect(narration.lastSpeaker).toEqual({ sceneId: "main", actorId: "first" });
    expect(storyComposition(narration, definition).foreground).toBe("first");
    const { lastSpeaker: _previous, ...legacyNarration } = narration;
    expect(storyComposition(StoryRunSchema.parse(legacyNarration), definition).foreground).toBeUndefined();
  });

  it("prefers source keys, excludes hidden keyed actors and rejects ambiguous display names", () => {
    const definition = scene({ entry: "end", actors: {
      a: { name: "Same", image: "a.png" }, b: { name: "Same", image: "b.png" },
      hidden: { name: "Other", image: "hidden.png" }, alias: { name: "hidden", image: "alias.png" }
    }, nodes: [{ id: "end", type: "end" }] });
    const stage = { overlay: .5, actors: Object.fromEntries(Object.entries(definition.actors!).map(([id, actor]) => [id,
      { id, image: actor.image, visible: id !== "hidden", x: 50, y: 100, scale: 1, rotation: 0, opacity: 1, anchorX: .5, anchorY: 1, layer: 0 }])) };
    expect(resolveStorySpeakerActor(stage, definition, "a", "Same")).toBe("a");
    expect(resolveStorySpeakerActor(stage, definition, "Same")).toBeUndefined();
    expect(resolveStorySpeakerActor(stage, definition, "hidden")).toBeUndefined();
    expect(resolveStorySpeakerActor(stage, definition, "Other")).toBeUndefined();
  });

  it("initializes size from the actor definition and retains explicit action overrides across expressions", () => {
    const definition = twoActors();
    const host = context({ main: definition });
    const run = advanceStory(createStoryRun("main", host), host);
    expect(run.stage.actors.first.scale).toBe(.8);
    expect(run.stage.actors.second.scale).toBe(1);
    const override = scene({ ...definition, nodes: definition.nodes.map(node => node.id === "enter" && node.type === "present"
      ? { ...node, action: { type: "stage", actors: [{ id: "first", scale: .6 }, { id: "second" }] } } : node) });
    const overrideHost = context({ main: override });
    let overridden = advanceStory(createStoryRun("main", overrideHost), overrideHost);
    expect(overridden.stage.actors.first.scale).toBe(.6);
    overridden = advanceStory(advanceStory(advanceStory(overridden, overrideHost), overrideHost), overrideHost);
    expect(overridden.cursor).toBe("player");
    expect(overridden.stage.actors.first.scale).toBe(.6);
    for (const scale of [-1, Infinity, 101]) expect(StorySceneSchema.safeParse({ ...definition, actors: { first: { name: "First", scale } } }).success).toBe(false);
    expect(StorySceneSchema.safeParse({ ...definition, actors: { first: { name: "First" } } }).success).toBe(true);
  });

  it("clears retention on scene calls and returns instead of borrowing matching actor keys", () => {
    const parent = scene({ entry: "enter", actors: { guide: { name: "Parent", image: "parent.png" } }, nodes: [
      { id: "enter", type: "present", action: { type: "stage", actors: [{ id: "guide" }] }, next: "hello" },
      text("hello", "call", "guide"), { id: "call", type: "call", sceneId: "child", next: "after" }, text("after", "end"), { id: "end", type: "end" }
    ] });
    const child = scene({ entry: "child-line", actors: { guide: { name: "Child", image: "child.png" } }, nodes: [text("child-line", "return"), { id: "return", type: "return" }] });
    const host = context({ parent, child });
    const speaking = advanceStory(createStoryRun("parent", host), host);
    const called = advanceStory(speaking, host);
    expect(called.sceneId).toBe("child");
    expect(called.lastSpeaker).toBeUndefined();
    expect(storyComposition(called, child).foreground).toBeUndefined();
    const returned = advanceStory(called, host);
    expect(returned.sceneId).toBe("parent");
    expect(returned.lastSpeaker).toBeUndefined();
    expect(storyComposition(returned, parent).foreground).toBeUndefined();
  });
});
