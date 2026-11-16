import { describe, expect, it } from "vitest";
import { createMatch } from "../core/match/reducer";
import { createMatchFactBatch } from "../core/events";
import { createPublicEvent, createPublicEventBatch, matchPublicEventBatch } from "../core/events/public-events";
import type { StoryScene } from "../core/story/types";
import { createDefaultSave, createRuntimeSave } from "../persistence/boot";
import { createProgramRun } from "../core/flow/program-engine";
import { ProgramDefinitionSchema } from "../core/flow/program";
import { PersistenceService } from "../persistence/save-service";
import type { RawSaveSnapshot, SaveStorageDriver } from "../persistence/storage-driver";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { StoryDirector, type StoryCatalog, type StoryDirectorDependencies } from "./story-director";
import { emptyStorySave, validateStorySave } from "./story-checkpoint";
import { ProgramSession } from "./program-session";
import { CapacitorFileSaveStorageDriver } from "../persistence/capacitor-driver";
import { projectProgramCheckpoint } from "./program-checkpoint";
import { projectStoryCommand } from "./story-commands";

const intro: StoryScene = { entry: "hello", nodes: [{ id: "hello", type: "say", segments: [{ text: "Hello" }], next: "end" }, { id: "end", type: "end" }] };
function catalog(scene = intro, event = "match.created"): StoryCatalog {
  return { scenes: [{ id: "neutral/story#intro", packageId: "neutral/story", digest: "scene-v1", definition: scene }],
    bindings: [{ id: "neutral/story#binding", packageId: "neutral/story", digest: "binding-v1", definition: { sceneId: "neutral/story#intro", trigger: { on: [event] }, frequency: "save" } }] };
}
function storage() {
  const driver = new MemorySaveStorageDriver({ longTerm: createDefaultSave(), runtime: null });
  let fail: ((snapshot: RawSaveSnapshot) => boolean) | undefined;
  const port: SaveStorageDriver = { readSnapshot: () => driver.readSnapshot(), writeSnapshot: snapshot => {
    if (fail?.(snapshot)) return Promise.reject(new Error("disk unavailable"));
    return driver.writeSnapshot(snapshot);
  } };
  return { driver, repository: new PersistenceService(port), fail: (predicate?: (snapshot: RawSaveSnapshot) => boolean) => { fail = predicate; } };
}
function director(repository: PersistenceService, overrides: Partial<StoryDirectorDependencies> = {}) {
  return new StoryDirector({ repository, catalog: () => catalog(), scopes: () => ({ game: "test-game" }), ...overrides });
}
function shellEvent() {
  return createPublicEventBatch({ id: "game-start", facts: [createPublicEvent({ id: "game-start", type: "core.game-started", scopes: { game: "test-game" }, data: { label: "original" } })] });
}

describe("durable story direction", () => {
  it("commits a legal invitation and its receipt together, then restores without inviting twice", async () => {
    const scene: StoryScene = { entry: "hello", nodes: [
      { id: "hello", type: "say", segments: [{ text: "Start" }], next: "invite" },
      { id: "invite", type: "command", onSkip: "omit", command: { type: "core.encounter.invite", apiVersion: 1, args: { characterId: "llama" } }, next: "end" },
      { id: "end", type: "end" }
    ] };
    const store = storage(), dependencies = { catalog: () => catalog(scene), projectCommand: projectStoryCommand };
    // projectStoryCommand's optional lifecycle argument is not the request parameter.
    const host = { ...dependencies, projectCommand: (intent: Parameters<typeof projectStoryCommand>[0], snapshot: RawSaveSnapshot) => projectStoryCommand(intent, snapshot) };
    const story = director(store.repository, host);
    await story.initialize(); await story.enqueue("neutral/story#intro");
    store.fail(snapshot => Boolean((snapshot.runtime as { activeProgram?: unknown } | null)?.activeProgram));
    await expect(story.advance()).rejects.toThrow("disk unavailable");
    const failed = await store.driver.readSnapshot();
    expect(failed?.runtime).toBeNull();
    expect(validateStorySave(failed?.story).active?.run.receipts).toHaveLength(0);
    expect(story.run?.waiting?.type).toBe("command");
    story.dispose(); store.fail();
    const restored = director(store.repository, host);
    await restored.initialize(); await restored.flush();
    const committed = await store.driver.readSnapshot();
    const runId = (committed?.runtime as { activeProgram?: { id: string } })?.activeProgram?.id;
    expect(runId).toBeTruthy();
    expect(validateStorySave(committed?.story).completed[0]).toMatchObject({ status: "completed", receipts: [{ id: runId }] });
    await restored.advance(); await restored.advance(); restored.dispose();
    const again = director(store.repository, host);
    await again.initialize(); await again.flush();
    expect((await store.driver.readSnapshot())?.runtime).toEqual(committed?.runtime);
    expect(again.state.save.completed).toHaveLength(1);
    again.dispose();
  });

  it.each(["skip", "cancel"] as const)("can %s a restored optional command checkpoint without projecting its invitation", async action => {
    const scene: StoryScene = { entry: "invite", nodes: [
      { id: "invite", type: "command", onSkip: "omit", command: { type: "core.encounter.invite", apiVersion: 1, args: { characterId: "llama" } }, next: "end" },
      { id: "end", type: "end" }
    ] };
    const store = storage(), dependencies = { catalog: () => catalog(scene), projectCommand: () => { throw new Error("not ready"); } };
    const story = director(store.repository, dependencies);
    await story.initialize(); await expect(story.enqueue("neutral/story#intro")).rejects.toThrow("not ready");
    expect(story.run?.waiting?.type).toBe("command"); story.dispose();
    const restored = director(store.repository, dependencies);
    await restored.initialize({ deferPlayback: true }); await restored[action]();
    expect(restored.run).toBeNull();
    expect(restored.state.save.completed[0]).toMatchObject({ status: action === "skip" ? "skipped" : "interrupted", receipts: [] });
    expect((await store.driver.readSnapshot())?.runtime).toBeNull(); restored.dispose();
  });

  it("commits a trigger inbox with its source checkpoint and never publishes a failed write", async () => {
    const store = storage(), story = director(store.repository);
    await story.initialize();
    const match = createMatch("durable-story", { opponentId: "llama", openingSkillCards: 0 });
    story.reserve(matchPublicEventBatch(createMatchFactBatch(undefined, match), { game: "test-game" }));
    expect(story.state.blocking).toBe(true);
    store.fail(() => true);
    await expect(store.repository.saveRuntime(createRuntimeSave(match))).rejects.toThrow("disk unavailable");
    expect((await store.driver.readSnapshot())?.runtime).toBeNull();
    expect((await store.driver.readSnapshot())?.story).toBeUndefined();
    expect(story.run).toBeNull();
    store.fail();
    await store.repository.saveRuntime(createRuntimeSave(match));
    const source = store.driver.writes[0];
    expect((source.runtime as ReturnType<typeof createRuntimeSave>).activeMatch.id).toBe(match.id);
    expect(validateStorySave(source.story).queue).toHaveLength(1);
    expect(validateStorySave(source.story).queue[0].event?.context?.match).toBeUndefined();
    story.dispose();
    // Simulate death immediately after the source checkpoint, before the player mounted.
    const reopened = new PersistenceService(new MemorySaveStorageDriver(source));
    const restored = director(reopened);
    await restored.initialize();
    expect(restored.run?.waiting?.type).toBe("say");
    await restored.accept(matchPublicEventBatch(createMatchFactBatch(undefined, match), { game: "test-game" }));
    expect(restored.state.save.queue).toHaveLength(0);
    expect(restored.state.save.seen).toHaveLength(1);
    await restored.skip();
    expect(restored.run).toBeNull();
    expect(restored.state.save.completed[0].status).toBe("skipped");
    restored.dispose();
  });

  it("checkpoints a chosen branch, legal reward and command receipt atomically across storage failure and repeated restore", async () => {
    const scene: StoryScene = { entry: "hello", nodes: [
      { id: "hello", type: "say", segments: [{ text: "Start" }], next: "select" },
      { id: "select", type: "choice", options: [{ id: "grant", text: "Grant", next: "grant" }] },
      { id: "grant", type: "command", command: { type: "neutral.reward", apiVersion: 1, args: {} }, next: "after" },
      { id: "after", type: "say", segments: [{ text: "Done" }], next: "end" }, { id: "end", type: "end" }
    ] };
    const store = storage();
    const dependencies: Partial<StoryDirectorDependencies> = { catalog: () => catalog(scene), projectCommand: (_intent, snapshot) => {
      const save = snapshot.longTerm as ReturnType<typeof createDefaultSave>;
      return { ...snapshot, longTerm: { ...save, profile: { ...save.profile, matchesPlayed: save.profile.matchesPlayed + 1 } } };
    } };
    const story = director(store.repository, dependencies);
    await story.initialize(); await story.enqueue("neutral/story#intro"); await story.advance();
    expect(story.run?.waiting?.type).toBe("choice");
    store.fail(snapshot => (snapshot.longTerm as ReturnType<typeof createDefaultSave>).profile.matchesPlayed > 0);
    await expect(story.choose("grant")).rejects.toThrow("disk unavailable");
    const failed = validateStorySave((await store.driver.readSnapshot())?.story);
    expect(failed.active?.run.waiting?.type).toBe("command");
    expect(failed.active?.run.choices).toHaveLength(1);
    expect(failed.active?.run.receipts).toHaveLength(0);
    expect((await store.repository.loadLongTerm())?.profile.matchesPlayed).toBe(0);
    story.dispose(); store.fail();
    const restored = director(store.repository, dependencies);
    await restored.initialize(); await restored.flush();
    expect(restored.run?.waiting?.type).toBe("say");
    expect(restored.run?.receipts).toHaveLength(1);
    expect((await store.repository.loadLongTerm())?.profile.matchesPlayed).toBe(1);
    restored.dispose();
    const again = director(store.repository, dependencies);
    await again.initialize(); await again.flush();
    expect((await store.repository.loadLongTerm())?.profile.matchesPlayed).toBe(1);
    again.dispose();
  });

  it("finishes whole-scene skipping after a required choice while retaining the selected branch", async () => {
    const scene: StoryScene = { entry: "hello", nodes: [
      { id: "hello", type: "say", segments: [{ text: "Start" }], next: "choose" },
      { id: "choose", type: "choice", options: [{ id: "yes", text: "Yes", next: "after" }] },
      { id: "after", type: "say", segments: [{ text: "After" }], next: "end" }, { id: "end", type: "end", result: "chosen" }
    ] };
    const store = storage(), story = director(store.repository, { catalog: () => catalog(scene) });
    await story.initialize(); await story.enqueue("neutral/story#intro"); await story.skip();
    expect(story.run?.waiting?.type).toBe("choice"); expect(story.run?.skipping).toBe(true);
    await story.choose("yes");
    expect(story.run).toBeNull();
    expect(story.state.save.completed[0]).toMatchObject({ status: "skipped", result: "chosen" });
    expect(story.state.save.completed[0].choices?.[0].optionId).toBe("yes");
    expect(story.state.blocking).toBe(false); story.dispose();
  });

  it("restores a pending presentation to its terminal state without replaying its one-shot effects", async () => {
    const scene: StoryScene = { entry: "show", nodes: [
      { id: "show", type: "present", action: { type: "audio", channel: "sound", operation: "play", src: "sound.wav" }, next: "hello" },
      { id: "hello", type: "say", segments: [{ text: "Hello" }], next: "end" }, { id: "end", type: "end" }
    ] };
    const store = storage();
    const original = director(store.repository, { catalog: () => catalog(scene), perform: () => new Promise(() => undefined) });
    await original.initialize(); await original.enqueue("neutral/story#intro");
    expect(original.run?.waiting?.type).toBe("presentation"); original.dispose();
    const performed: { skip: boolean; restore?: boolean }[] = [];
    const restored = director(store.repository, { catalog: () => catalog(scene), perform: async (_action, context) => { performed.push(context); } });
    await restored.initialize(); await restored.flush();
    expect(performed).toMatchObject([{ skip: true, restore: true }]);
    expect(restored.run?.waiting?.type).toBe("say"); restored.dispose();
  });

  it("pins content digests, releases gameplay on missing content, and can cancel without that content", async () => {
    const store = storage(); let content = catalog();
    const story = director(store.repository, { catalog: () => content });
    await story.initialize(); await story.enqueue("neutral/story#intro");
    const original = story.run;
    content = { ...content, scenes: content.scenes.map(entry => ({ ...entry, digest: "changed" })) };
    await story.retry();
    expect(story.state.blocked).toBe(true); expect(story.state.blocking).toBe(false);
    expect(story.run).toEqual(original);
    await story.cancel();
    expect(story.run).toBeNull(); expect(story.state.save.completed[0].status).toBe("interrupted"); story.dispose();
  });

  it("checks choices against current host state while retaining the triggering event data", async () => {
    const scene: StoryScene = { entry: "choose", nodes: [
      { id: "choose", type: "choice", options: [{ id: "yes", text: "Yes", next: "remember", enabledWhen: { type: "public", condition: {
        type: "compare", left: { type: "query", query: { id: "context.value", key: "allowed" } }, operator: "eq", right: { type: "literal", value: true }
      } } }] },
      { id: "remember", type: "set", values: { source: { type: "query", query: { id: "event.data", key: "label" } } }, next: "after" },
      { id: "after", type: "say", segments: [{ text: "${source}" }], next: "end" }, { id: "end", type: "end" }
    ] };
    const store = storage(); let allowed = true;
    const story = director(store.repository, { catalog: () => catalog(scene, "core.game-started"), engineContext: () => ({ publicContext: {
      batch: createPublicEventBatch({ id: "live", facts: [], context: { values: { allowed } } })
    } }) });
    await story.initialize(); await story.accept(shellEvent());
    expect(story.run?.waiting?.type).toBe("choice");
    allowed = false; await story.choose("yes");
    expect(story.run?.waiting?.type).toBe("choice");
    allowed = true; await story.choose("yes");
    expect(story.run?.variables.source).toBe("original");
    expect(story.run?.waiting?.type).toBe("say"); story.dispose();
  });

  it("preserves the additive story record through old save APIs and rejects malformed story checkpoints", async () => {
    const store = storage();
    await store.repository.projectSnapshot(snapshot => ({ ...snapshot, story: emptyStorySave() }), { storyOnly: true });
    const save = createDefaultSave();
    await store.repository.saveLongTerm(save); await store.repository.commitMatchResult(save); await store.repository.closeGameRuntime(save);
    expect((await store.repository.readSnapshot()).story).toEqual(emptyStorySave());
    await store.repository.projectSnapshot(snapshot => ({ ...snapshot, story: { ...emptyStorySave(), queue: [{ id: "bad" }] } }), { storyOnly: true });
    const story = director(store.repository); await story.initialize();
    expect(story.state.blocked).toBe(true); expect(story.state.blocking).toBe(false); expect(story.run).toBeNull(); story.dispose();
  });

  it("cancels only its request without interrupting a different owner's active scene", async () => {
    const store = storage(), story = director(store.repository);
    await story.initialize();
    await story.enqueue("neutral/story#intro", { id: "owner-a" });
    await story.enqueue("neutral/story#intro", { id: "owner-b" });
    await story.cancelRequest("owner-b");
    expect(story.run?.id).toBe("owner-a");
    expect(story.state.save.queue).toHaveLength(0);
    expect(story.state.save.completed[0]).toMatchObject({ id: "owner-b", status: "interrupted" });
    await story.cancelRequest("owner-a");
    expect(story.run).toBeNull(); expect(story.state.blocking).toBe(false); story.dispose();
  });

  it("retries or cancels a failed first transient inbox before a scene has become active", async () => {
    const store = storage(), story = director(store.repository, { catalog: () => catalog(intro, "core.game-started") });
    await story.initialize(); store.fail(() => true);
    await expect(story.accept(shellEvent())).rejects.toThrow("disk unavailable");
    expect(story.run).toBeNull(); expect(story.state.error).toContain("disk unavailable");
    store.fail(); await story.retry();
    expect(story.run?.waiting?.type).toBe("say"); expect(story.state.save.seen).toHaveLength(1);
    await story.cancel(); story.dispose();
    const failed = director(store.repository, { catalog: () => ({ ...catalog(intro, "core.game-started"), bindings: [{ ...catalog(intro, "core.game-started").bindings[0],
      id: "neutral/story#new-binding" }] }) });
    await failed.initialize(); store.fail(() => true);
    await expect(failed.accept(shellEvent())).rejects.toThrow("disk unavailable");
    await failed.cancel();
    expect(failed.run).toBeNull(); expect(failed.state.blocking).toBe(false); expect(failed.state.error).toBeUndefined(); failed.dispose();
  });

  it("writes program lifecycle triggers into the same source snapshot", async () => {
    const store = storage(), story = director(store.repository, { catalog: () => catalog(intro, "program.started") });
    await story.initialize();
    let save = (await store.repository.loadLongTerm())!;
    const session = new ProgramSession(store.repository, { get: () => save, set: next => { save = next; } }, undefined, undefined, undefined, { game: "test-game" });
    const definition = ProgramDefinitionSchema.parse({ version: 2, id: "neutral-program", start: "select", nodes: [
      { id: "select", type: "choice", options: [{ id: "finish", to: "end" }] }, { id: "end", type: "end", result: "victory" }
    ] });
    await session.begin(createProgramRun("program-story", "seed", definition));
    const source = store.driver.writes[0];
    expect((source.runtime as { activeProgram: { id: string } }).activeProgram.id).toBe("program-story");
    expect(validateStorySave(source.story).queue[0].event?.facts[0].type).toBe("program.started");
    story.dispose(); await session.dispose();
  });

  it("rejects a forged persisted command before calling its legal host adapter", async () => {
    const scene: StoryScene = { entry: "command", nodes: [
      { id: "command", type: "command", command: { type: "neutral.legal", apiVersion: 1, args: {} }, next: "end" }, { id: "end", type: "end" }
    ] };
    const store = storage();
    const original = director(store.repository, { catalog: () => catalog(scene) });
    await original.initialize(); await original.enqueue("neutral/story#intro"); original.dispose();
    const source = await store.repository.readSnapshot(), save = validateStorySave(source.story), active = save.active!;
    if (active.run.waiting?.type !== "command") throw new Error("expected pending command");
    const forged = { ...active, run: { ...active.run, waiting: { ...active.run.waiting, intent: { ...active.run.waiting.intent, type: "neutral.forged" } } } };
    await store.repository.projectSnapshot(snapshot => ({ ...snapshot, story: { ...save, active: forged } }), { storyOnly: true });
    let calls = 0;
    const restored = director(store.repository, { catalog: () => catalog(scene), projectCommand: (_intent, snapshot) => { calls++; return snapshot; } });
    await restored.initialize();
    expect(restored.state.blocked).toBe(true); expect(calls).toBe(0); expect(restored.state.blocking).toBe(false); restored.dispose();
  });

  it("round-trips all three records through native crash-recovery slots", async () => {
    const files = new Map<string, string>();
    const port = {
      readFile: async ({ path }: { path: string }) => { if (!files.has(path)) throw new Error("not found"); return { data: files.get(path)! }; },
      writeFile: async ({ path, data }: { path: string; data: string }) => { files.set(path, data); }
    };
    const native = new PersistenceService(new CapacitorFileSaveStorageDriver(port));
    await native.saveLongTerm(createDefaultSave());
    const story = director(native); await story.initialize(); await story.enqueue("neutral/story#intro"); story.dispose();
    const persisted = (await native.readSnapshot()).story;
    await native.closeGameRuntime((await native.loadLongTerm())!);
    const recreated = new PersistenceService(new CapacitorFileSaveStorageDriver(port));
    expect((await recreated.readSnapshot()).story).toEqual(persisted);
    const restored = director(recreated); await restored.initialize(); expect(restored.run?.waiting?.type).toBe("say"); restored.dispose();
  });

  it("does not execute commands or presentations before initialized playback resumes", async () => {
    const scene: StoryScene = { entry: "command", nodes: [
      { id: "command", type: "command", command: { type: "neutral.legal", apiVersion: 1, args: {} }, next: "show" },
      { id: "show", type: "present", action: { type: "wait", durationMs: 0 }, next: "hello" },
      { id: "hello", type: "say", segments: [{ text: "Hello" }], next: "end" }, { id: "end", type: "end" }
    ] };
    const store = storage(); let commands = 0, presentations = 0;
    const story = director(store.repository, { catalog: () => catalog(scene),
      projectCommand: (_intent, snapshot) => { commands++; return snapshot; },
      perform: async () => { presentations++; }
    });
    await story.enqueue("neutral/story#intro");
    expect(story.run).toBeNull(); expect(story.state.save.queue).toHaveLength(1); expect(commands).toBe(0);
    await story.resumePlayback(); expect(commands).toBe(0);
    await story.initialize({ deferPlayback: true }); await story.flush();
    expect(story.run).toBeNull(); expect(commands).toBe(0); expect(presentations).toBe(0);
    await story.resumePlayback(); await story.flush();
    expect(commands).toBe(1); expect(presentations).toBe(1); expect(story.run?.waiting?.type).toBe("say"); story.dispose();
  });

  it("evaluates immediate post-command branches from the projected owner checkpoint", async () => {
    const definition = ProgramDefinitionSchema.parse({ version: 2, id: "neutral-program", start: "before", nodes: [
      { id: "before", type: "presentation", body: "Before", next: "after" },
      { id: "after", type: "presentation", body: "After", next: "end" }, { id: "end", type: "end", result: "victory" }
    ] });
    const scene: StoryScene = { entry: "command", nodes: [
      { id: "command", type: "command", command: { type: "core.program.confirm", apiVersion: 1, args: {} }, next: "branch" },
      { id: "branch", type: "branch", branches: [{ when: { type: "compare", left: { type: "query", query: { id: "program.node-id" } }, operator: "eq", right: { type: "literal", value: "after" } }, next: "remember" }], otherwise: "wrong" },
      { id: "remember", type: "set", values: { source: { type: "query", query: { id: "event.data", key: "label" } } }, next: "correct" },
      { id: "correct", type: "say", segments: [{ text: "Correct" }], next: "end" },
      { id: "wrong", type: "say", segments: [{ text: "Wrong" }], next: "end" }, { id: "end", type: "end" }
    ] };
    const store = storage();
    let owner = projectProgramCheckpoint(createDefaultSave(), createProgramRun("program-story", "seed", definition));
    await store.repository.projectSnapshot(snapshot => ({ ...snapshot, ...owner }));
    const story = director(store.repository, { catalog: () => catalog(scene, "core.game-started"),
      engineContext: () => ({ publicContext: { batch: createPublicEventBatch({ id: "live", facts: [], context: {
        program: { id: owner.runtime!.activeProgram!.id, nodeId: owner.runtime!.activeProgram!.cursor }
      } }) } }),
      projectCommand: (intent, snapshot) => projectStoryCommand(intent, snapshot),
      onSnapshotCommitted: snapshot => { owner = { longTerm: snapshot.longTerm as typeof owner.longTerm, runtime: snapshot.runtime as typeof owner.runtime }; }
    });
    await story.initialize(); await story.accept(shellEvent());
    expect(story.run?.cursor).toBe("correct"); expect(story.run?.variables.source).toBe("original");
    expect(owner.runtime?.activeProgram?.cursor).toBe("after"); expect(story.run?.receipts).toHaveLength(1); story.dispose();
  });

  it("cancels a missing queued scene while preserving and starting the remaining valid request", async () => {
    const store = storage();
    const original = catalog();
    const missing = { ...original.scenes[0], id: "neutral/missing#intro", packageId: "neutral/missing" };
    let content = { ...original, scenes: [missing, ...original.scenes] };
    const story = director(store.repository, { catalog: () => content });
    await story.initialize({ deferPlayback: true });
    await story.enqueue(missing.id, { id: "missing-request" });
    await story.enqueue(original.scenes[0].id, { id: "valid-request" });
    content = { ...content, scenes: [] };
    await story.resumePlayback(); expect(story.state.blocked).toBe(true); expect(story.run).toBeNull();
    content = { ...original, scenes: [...original.scenes] };
    await story.cancel();
    expect(story.run?.id).toBe("valid-request"); expect(story.state.save.queue).toHaveLength(0);
    expect(story.state.save.completed[0]).toMatchObject({ id: "missing-request", status: "interrupted" });
    expect(story.state.error).toBeUndefined(); story.dispose();
  });

  it("keeps a large source checkpoint valid while diagnosing and bounding excess story requests", async () => {
    const content = catalog();
    const store = storage(); const diagnostics: string[] = [];
    const story = director(store.repository, { catalog: () => ({ ...content, bindings: Array.from({ length: 300 }, (_, index) => ({
      ...content.bindings[0], id: `neutral/story#binding-${index}`, definition: { ...content.bindings[0].definition, frequency: "always" }
    })) }), onDiagnostic: diagnostic => { diagnostics.push(diagnostic.code); } });
    await story.initialize({ deferPlayback: true });
    const match = createMatch("capacity-source", { opponentId: "llama", openingSkillCards: 0 });
    story.reserve(matchPublicEventBatch(createMatchFactBatch(undefined, match), { game: "test-game" }));
    await expect(store.repository.saveRuntime(createRuntimeSave(match))).resolves.toBeUndefined();
    const saved = validateStorySave((await store.driver.readSnapshot())?.story);
    expect(saved.queue).toHaveLength(256); expect(saved.seen).toHaveLength(256); expect(saved.diagnostics).toHaveLength(32);
    expect(saved.diagnostics?.every(item => item.code === "queue-full")).toBe(true); expect(diagnostics).toHaveLength(32);
    expect((await store.repository.loadRuntime())?.activeMatch?.id).toBe(match.id);
    await expect(story.enqueue("neutral/story#intro", { id: "explicit-overflow" })).rejects.toThrow("待播队列");
    expect(validateStorySave((await store.driver.readSnapshot())?.story).queue).toHaveLength(256);
    await expect(store.repository.saveLongTerm(createDefaultSave())).resolves.toBeUndefined(); story.dispose();
  });

  it("does not retain a second reservation after an already-reserved once scope commits", async () => {
    const store = storage(), story = director(store.repository, { catalog: () => catalog(intro, "core.game-started") });
    await story.initialize();
    const first = shellEvent(), second = createPublicEventBatch({ id: "second", facts: [createPublicEvent({ id: "second", type: "core.game-started", scopes: { game: "test-game" } })] });
    story.reserve(first); story.reserve(second);
    await story.accept(first); await story.accept(second); await story.skip();
    expect(story.state.save.seen).toHaveLength(1); expect(story.state.blocking).toBe(false); story.dispose();
  });

  it("preserves the valid command checkpoint and gameplay when another receipt would exceed its schema budget", async () => {
    const scene: StoryScene = { entry: "command", nodes: [
      { id: "command", type: "command", command: { type: "neutral.legal", apiVersion: 1, args: {} }, next: "end" }, { id: "end", type: "end" }
    ] };
    const store = storage(), original = director(store.repository, { catalog: () => catalog(scene) });
    await original.initialize(); await original.enqueue("neutral/story#intro"); original.dispose();
    await store.repository.projectSnapshot(snapshot => {
      const save = validateStorySave(snapshot.story), active = save.active!;
      return { ...snapshot, story: { ...save, active: { ...active, run: { ...active.run, receipts: Array.from({ length: 4096 }, (_, index) => ({ id: `old-${index}` })) } } } };
    }, { storyOnly: true });
    const valid = await store.repository.readSnapshot();
    const restored = director(store.repository, { catalog: () => catalog(scene), projectCommand: (_intent, snapshot) => {
      const save = snapshot.longTerm as ReturnType<typeof createDefaultSave>;
      return { ...snapshot, longTerm: { ...save, profile: { ...save.profile, matchesPlayed: 1 } } };
    } });
    await expect(restored.initialize()).rejects.toThrow("剧情存档");
    expect(await store.repository.readSnapshot()).toEqual(valid);
    expect(validateStorySave((await store.repository.readSnapshot()).story).active?.run.receipts).toHaveLength(4096);
    expect((await store.repository.loadLongTerm())?.profile.matchesPlayed).toBe(0);
    await restored.cancel(); expect(restored.run).toBeNull(); restored.dispose();
  });

  it("stops a command-only cycle at a durable failure checkpoint without continuing writes", async () => {
    const scene: StoryScene = { entry: "command", nodes: [
      { id: "command", type: "command", command: { type: "neutral.legal", apiVersion: 1, args: {} }, next: "command" }
    ] };
    const store = storage(), story = director(store.repository, { catalog: () => catalog(scene), engineContext: () => ({ stepBudget: 2 }),
      projectCommand: (_intent, snapshot) => {
        const save = snapshot.longTerm as ReturnType<typeof createDefaultSave>;
        return { ...snapshot, longTerm: { ...save, profile: { ...save.profile, matchesPlayed: save.profile.matchesPlayed + 1 } } };
      }
    });
    await story.initialize(); await story.enqueue("neutral/story#intro"); await story.flush();
    expect(story.run?.status).toBe("failed"); expect(story.state.error).toContain("命令循环");
    expect((await store.repository.loadLongTerm())?.profile.matchesPlayed).toBe(2);
    const writes = store.driver.writes.length;
    await Promise.resolve(); await story.flush(); expect(store.driver.writes).toHaveLength(writes);
    const checkpoint = validateStorySave((await store.repository.readSnapshot()).story);
    expect(checkpoint.active?.run.receipts).toHaveLength(2); expect(checkpoint.active?.run.status).toBe("failed");
    await story.cancel(); expect(story.run).toBeNull(); expect(story.state.blocking).toBe(false); story.dispose();
  });
});
