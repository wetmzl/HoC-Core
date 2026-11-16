import { describe, expect, it } from "vitest";
import { z } from "zod";
import { acknowledgeStoryCommand, advanceStory, chooseStory, createStoryRun, evaluateStoryCondition, interruptStory, refreshStory, retryStory, skipStory } from "./engine";
import { StoryExtensions, validateStorySceneCapabilities } from "./extensions";
import { StoryActionSchema, StoryBindingSchema, StoryRunSchema, StorySceneSchema } from "./schema";
import type { StoryEngineContext, StoryScene } from "./types";

const scene = (value: unknown): StoryScene => StorySceneSchema.parse(value);
const context = (scenes: Record<string, StoryScene>, extra: Partial<StoryEngineContext> = {}): StoryEngineContext => ({ resolveScene: id => scenes[id], ...extra });
const line = { id: "line", type: "say", segments: [{ text: "开始" }, { pauseMs: 400 }], next: "finish" };

describe("semantic story execution", () => {
  it("omits only explicitly optional commands while skipping, including restored command waits", () => {
    const definition = scene({ entry: "line", nodes: [
      { ...line, next: "invite" },
      { id: "invite", type: "command", onSkip: "omit", command: { type: "neutral.invite", apiVersion: 1, args: {} }, next: "required" },
      { id: "required", type: "command", command: { type: "neutral.record", apiVersion: 1, args: {} }, next: "finish" },
      { id: "finish", type: "end" }
    ] });
    const host = context({ intro: definition });
    const initial = createStoryRun("intro", host);
    const skipped = skipStory(initial, host);
    expect(skipped.waiting?.node.id).toBe("required");
    const normal = advanceStory(initial, host);
    expect(normal.waiting?.node.id).toBe("invite");
    if (normal.waiting?.type !== "command") throw new Error("expected optional command");
    const restored = StoryRunSchema.parse(JSON.parse(JSON.stringify(normal)));
    const skippedWaiting = skipStory(restored, host);
    expect(skippedWaiting.waiting?.node.id).toBe("required");
    expect(skippedWaiting.receipts).toHaveLength(0);
    expect(acknowledgeStoryCommand(skippedWaiting, { id: normal.waiting.intent.id }, host)).toBe(skippedWaiting);
    if (skippedWaiting.waiting?.type !== "command") throw new Error("expected required command");
    expect(acknowledgeStoryCommand(skippedWaiting, { id: skippedWaiting.waiting.intent.id }, host).status).toBe("skipped");
    expect(interruptStory(normal).status).toBe("interrupted");
    expect(StorySceneSchema.safeParse({ ...definition, nodes: definition.nodes.map(node => node.id === "invite" ? { ...node, onSkip: "execute-everything" } : node) }).success).toBe(false);
  });

  it("keeps gameplay commands on the chosen path during skip and waits for required choices", () => {
    const definition = scene({ entry: "line", nodes: [
      { ...line, next: "choice" },
      { id: "choice", type: "choice", options: [{ id: "left", text: "接受", next: "reward" }, { id: "right", text: "离开", next: "finish" }] },
      { id: "reward", type: "command", command: { type: "core.program.effects", apiVersion: 1, args: { reward: true } }, next: "after" },
      { id: "after", type: "say", segments: [{ text: "已记录" }], next: "finish" }, { id: "finish", type: "end", result: "done" }
    ] });
    const host = context({ intro: definition });
    const initial = createStoryRun("intro", host, { id: "run-1" });
    const choice = skipStory(initial, host);
    expect(choice.waiting?.type).toBe("choice");
    expect(choice.skipping).toBe(true);
    expect(advanceStory(choice, host)).toBe(choice);
    const command = chooseStory(choice, "left", host);
    expect(command.waiting?.type).toBe("command");
    expect(command.receipts).toHaveLength(0);
    expect(skipStory(command, host).waiting).toEqual(command.waiting);
    if (command.waiting?.type !== "command") throw new Error("expected command");
    const receipt = { id: command.waiting.intent.id, result: { granted: true } };
    expect(acknowledgeStoryCommand(command, { id: "other" }, host)).toBe(command);
    const complete = acknowledgeStoryCommand(command, receipt, host);
    expect(complete.status).toBe("skipped");
    expect(complete.receipts).toEqual([receipt]);
    expect(complete.variables.granted).toBe(true);
    expect(acknowledgeStoryCommand(complete, receipt, host)).toBe(complete);
    expect(chooseStory(choice, "right", host).status).toBe("skipped");
  });

  it("uses only the explicit skip route for optional choices and never executes abandoned branch commands", () => {
    const definition = scene({ entry: "choice", nodes: [
      { id: "choice", type: "choice", required: false, skipTo: "finish", options: [{ id: "reward", text: "领取", next: "reward" }] },
      { id: "reward", type: "command", command: { type: "core.reward", apiVersion: 1, args: {} }, next: "finish" }, { id: "finish", type: "end" }
    ] });
    const host = context({ optional: definition });
    const complete = skipStory(createStoryRun("optional", host), host);
    expect(complete.status).toBe("skipped");
    expect(complete.choices).toHaveLength(0);
    expect(complete.receipts).toHaveLength(0);
  });

  it("rechecks current choice eligibility and refreshes options when facts change", () => {
    const ready = { type: "compare", left: { type: "variable", key: "ready" }, operator: "eq", right: { type: "literal", value: true } };
    const definition = scene({ entry: "choice", variables: { ready: false }, nodes: [
      { id: "choice", type: "choice", options: [{ id: "new", text: "新解锁", enabledWhen: ready, next: "end" }, { id: "hidden", text: "出现", when: ready, next: "end" }, { id: "always", text: "继续", next: "end" }] }, { id: "end", type: "end" }
    ] });
    const host = context({ changing: definition });
    const run = createStoryRun("changing", host);
    expect(chooseStory(run, "new", host)).toBe(run);
    const changed = { ...run, variables: { ready: true } };
    expect(chooseStory(changed, "new", host).status).toBe("completed");
    expect(chooseStory(changed, "hidden", host).status).toBe("completed");
    const refreshed = refreshStory(changed, host);
    expect(refreshed.sequence).toBe(changed.sequence);
    expect(refreshed.waiting?.type === "choice" && refreshed.waiting.options.map(option => [option.id, option.enabled])).toEqual([["new", true], ["hidden", true], ["always", true]]);
  });

  it("handles interpolation, conditions, subscene return and disabled options without mutating the source", () => {
    const sub = scene({ entry: "set", nodes: [{ id: "set", type: "set", values: { ready: { type: "literal", value: true } }, next: "return" }, { id: "return", type: "return" }] });
    const intro = scene({ entry: "call", variables: { name: "访客", ready: false }, actors: { guide: { name: "引导员" } }, nodes: [
      { id: "call", type: "call", sceneId: "sub", next: "branch" },
      { id: "branch", type: "branch", branches: [{ when: { type: "compare", left: { type: "variable", key: "ready" }, operator: "eq", right: { type: "literal", value: true } }, next: "line" }], otherwise: "finish" },
      { ...line, speaker: "guide", segments: [{ text: "欢迎，{{ name }}" }], next: "choice" },
      { id: "choice", type: "choice", options: [{ id: "locked", text: "未解锁", enabledWhen: { type: "compare", left: { type: "variable", key: "ready" }, operator: "eq", right: { type: "literal", value: false } }, disabledReason: "稍后开放", next: "finish" }, { id: "ok", text: "继续", next: "finish" }] },
      { id: "finish", type: "end" }
    ] });
    const host = context({ intro, sub });
    const run = createStoryRun("intro", host);
    expect(run.waiting?.type === "say" && run.waiting.node.speaker).toBe("引导员");
    expect(run.waiting?.type === "say" && run.waiting.node.segments[0]).toEqual({ text: "欢迎，访客" });
    const choice = advanceStory(run, host);
    expect(chooseStory(choice, "locked", host)).toBe(choice);
    expect(chooseStory(choice, "ok", host).status).toBe("completed");
    expect(intro.variables?.ready).toBe(false);
    expect(StoryRunSchema.safeParse(JSON.parse(JSON.stringify(choice))).success).toBe(true);
    expect(evaluateStoryCondition({ type: "not", condition: { type: "compare", left: { type: "query", query: { id: "match.phase" } }, operator: "eq", right: { type: "literal", value: "match" } } }, choice, host)).toBe(false);
  });

  it("applies final animation state on acknowledgement and skip, while cancellation is distinct", () => {
    const definition = scene({ entry: "show", actors: { guide: { name: "向导", image: "guide.png" } }, nodes: [
      { id: "show", type: "present", action: { type: "sequence", actions: [{ type: "stage", actors: [{ id: "guide", x: 20 }] }, { type: "animate", actor: "guide", durationMs: 1200, keyframes: [{ x: 80, opacity: 0.4 }] }] }, next: "finish" }, { id: "finish", type: "end" }
    ] });
    const host = context({ stage: definition });
    const run = createStoryRun("stage", host);
    expect(run.stage.actors).toEqual({});
    const complete = advanceStory(run, host);
    expect(complete.stage.actors.guide).toMatchObject({ x: 80, opacity: 0.4, image: "guide.png" });
    expect(skipStory(run, host).stage).toEqual(complete.stage);
    expect(interruptStory(run).status).toBe("interrupted");
    expect(complete.status).toBe("completed");
  });

  it("treats prototype-named actor IDs as ordinary declared instances", () => {
    const definition = scene({ entry: "show", actors: { toString: { name: "向导", image: "guide.png" } }, nodes: [
      { id: "show", type: "present", action: { type: "animate", actor: "toString", durationMs: 1, keyframes: [{ x: 60 }] }, next: "end" }, { id: "end", type: "end" }
    ] });
    const host = context({ names: definition });
    const complete = advanceStory(createStoryRun("names", host), host);
    expect(complete.stage.actors.toString).toMatchObject({ id: "toString", image: "guide.png", x: 60, y: 100, scale: 1, opacity: 1 });
    expect(StoryRunSchema.safeParse(JSON.parse(JSON.stringify(complete))).success).toBe(true);
  });

  it("keeps a skipped extension at a semantic wait so the host can call fastForward", () => {
    const definition = scene({ entry: "line", nodes: [
      { ...line, next: "extension" }, { id: "extension", type: "present", action: { type: "extension", typeId: "demo:flash", apiVersion: 1, args: {} }, next: "finish" }, { id: "finish", type: "end" }
    ] });
    const host = context({ extension: definition });
    const run = skipStory(createStoryRun("extension", host), host);
    expect(run.waiting?.type).toBe("presentation");
    expect(run.skipping).toBe(true);
    expect(advanceStory(run, host).status).toBe("skipped");
    const playing = advanceStory(createStoryRun("extension", host), host);
    const skippedActive = skipStory(playing, host);
    expect(skippedActive.waiting).toEqual(playing.waiting);
    expect(skippedActive.skipping).toBe(true);
    expect(advanceStory(skippedActive, host).status).toBe("skipped");
  });

  it("bounds automatic loops and recursive calls, supports repairing a missing subscene", () => {
    const loop = scene({ entry: "loop", nodes: [{ id: "loop", type: "branch", branches: [], otherwise: "loop" }] });
    expect(createStoryRun("loop", context({ loop }, { stepBudget: 8 })).error).toContain("步骤预算");
    const recursive = scene({ entry: "call", nodes: [{ id: "call", type: "call", sceneId: "recursive", next: "end" }, { id: "end", type: "end" }] });
    expect(createStoryRun("recursive", context({ recursive })).error).toContain("调用栈");
    const caller = scene({ entry: "call", nodes: [{ id: "call", type: "call", sceneId: "missing", next: "end" }, { id: "end", type: "end" }] });
    const failed = createStoryRun("caller", context({ caller }));
    expect(failed.status).toBe("failed");
    const missing = scene({ entry: "end", nodes: [{ id: "end", type: "end" }] });
    expect(retryStory(failed, context({ caller, missing })).status).toBe("completed");
  });
});

describe("story declarations", () => {
  it("rejects cycles, oversized nested timelines, unknown fields, missing targets and ambiguous skips", () => {
    const cycle: Record<string, unknown> = { type: "sequence" }; cycle.actions = [cycle];
    expect(StoryActionSchema.safeParse(cycle).success).toBe(false);
    let deep: unknown = { type: "wait", durationMs: 1 };
    for (let index = 0; index < 50; index++) deep = { type: "sequence", actions: [deep] };
    expect(StoryActionSchema.safeParse(deep).success).toBe(false);
    expect(StorySceneSchema.safeParse({ entry: "line", nodes: [line], script: "code()" }).success).toBe(false);
    expect(StorySceneSchema.safeParse({ entry: "choice", nodes: [{ id: "choice", type: "choice", required: false, options: [{ id: "one", text: "一", next: "choice" }] }] }).success).toBe(false);
    expect(StoryBindingSchema.safeParse({ sceneId: "demo/content#intro", trigger: {}, frequency: "game" }).success).toBe(true);
    expect(StoryBindingSchema.safeParse({ sceneId: "intro", trigger: {}, frequency: "turn" }).success).toBe(false);
  });
  it("rejects parallel property collisions, decreasing keyframes and infinite audio waits", () => {
    const animation = { type: "animate", actor: "guide", durationMs: 50, keyframes: [{ x: 30 }] };
    expect(StoryActionSchema.safeParse({ type: "parallel", actions: [animation, animation] }).success).toBe(false);
    expect(StoryActionSchema.safeParse({ type: "sequence", actions: [animation, animation] }).success).toBe(true);
    expect(StoryActionSchema.safeParse({ ...animation, keyframes: [{ offset: 1, x: 30 }, { offset: 0, x: 10 }] }).success).toBe(false);
    expect(StoryActionSchema.safeParse({ type: "audio", channel: "music", operation: "play", src: "music.ogg", loop: true, wait: true }).success).toBe(false);
  });
  it("checks unknown required actions and host command schemas before activation", () => {
    const definition = scene({ entry: "extension", nodes: [
      { id: "extension", type: "present", action: { type: "extension", typeId: "demo:flash", apiVersion: 1, args: { strength: 2 } }, next: "command" },
      { id: "command", type: "command", command: { type: "core.unlock", apiVersion: 1, args: { id: "sample" } }, next: "finish" }, { id: "finish", type: "end" }
    ] });
    const registry = new StoryExtensions();
    expect(validateStorySceneCapabilities(definition, registry)).toHaveLength(2);
    const calls: string[] = [];
    const remove = registry.registerAction({ type: "demo:flash", apiVersion: 1, schema: z.object({ strength: z.number() }).strict(), execute: () => { calls.push("execute"); }, fastForward: () => { calls.push("skip"); }, restore: () => { calls.push("restore"); }, cancel: () => { calls.push("cancel"); } });
    registry.registerCommand({ type: "core.unlock", apiVersion: 1, schema: z.object({ id: z.string() }).strict() });
    expect(validateStorySceneCapabilities(definition, registry)).toEqual([]);
    expect(calls).toEqual([]);
    expect(() => registry.registerCommand({ type: "core.unlock", apiVersion: 1, schema: z.object({}) })).toThrow("已经注册");
    remove();
    expect(validateStorySceneCapabilities(definition, registry)).toHaveLength(1);
  });
});
