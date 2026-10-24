import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSave } from "../persistence/boot";
import { PersistenceService } from "../persistence/save-service";
import type { LongTermSave } from "../persistence/schema";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import type { PluginTutorialDefinition } from "../content/packages/plugin-tutorials";
import { SkillLibraryController } from "../screens/skill-library";
import { TutorialController, type TutorialControllerDependencies } from "./tutorial-controller";

beforeEach(() => {
  vi.stubGlobal("window", { clearTimeout: vi.fn() });
  vi.stubGlobal("document", { querySelector: () => null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(flushPendingSaveWrites?: () => Promise<void>) {
  let save = createDefaultSave();
  const write = vi.fn(async (_save: LongTermSave) => {});
  const notify = vi.fn();
  const controller = new TutorialController({
    get save() { return save; }, set save(next) { save = next; },
    root: {} as HTMLDivElement, autosave: null,
    repository: { saveLongTerm: write } as unknown as TutorialControllerDependencies["repository"],
    enqueueNotification: notify,
    ...{ flushPendingSaveWrites }
  });
  // Exercise request ownership and durable progress independently of browser rendering.
  const render = vi.spyOn(controller, "renderTutorialSurface").mockImplementation(() => {});
  const clear = vi.spyOn(controller, "clearTutorialSurface").mockImplementation(() => {});
  const lifetime = new AbortController();
  return { controller, write, notify, render, clear, lifetime,
    api: controller.forPackage("test/guide", lifetime.signal),
    get save() { return save; }, set save(next: LongTermSave) { save = next; }
  };
}
const tutorial = (id: string): PluginTutorialDefinition => ({ id, title: id, pages: [{ body: "Explanation" }] });

describe("tutorial request lifecycle", () => {
  it("queues initial runtime requests, deduplicates IDs and ignores stale cancel handles", () => {
    const h = fixture();
    const cancelFirst = h.api.show(tutorial("first"));
    h.api.show(tutorial("first"));
    const cancelSecond = h.api.show(tutorial("second"));
    h.controller.discardActiveTutorial();
    expect(h.controller.activeTutorial).toBeNull();
    h.controller.setReady();
    expect(h.controller.activeTutorial?.definition.id).toBe("first");
    cancelFirst();
    expect(h.controller.activeTutorial?.definition.id).toBe("second");
    cancelFirst();
    expect(h.controller.activeTutorial?.definition.id).toBe("second");
    cancelSecond();
    expect(h.controller.activeTutorial).toBeNull();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.save.tutorialProgress.completedIds).toEqual([]);
  });

  it("cancels active and queued requests on navigation and permits new page requests", () => {
    const h = fixture();
    h.controller.setReady();
    h.api.show(tutorial("first"));
    h.api.show(tutorial("queued"));
    h.controller.discardActiveTutorial();
    expect(h.controller.activeTutorial).toBeNull();
    h.api.show(tutorial("new-page"));
    expect(h.controller.activeTutorial?.definition.id).toBe("new-page");
    expect(h.save.tutorialProgress.completedIds).toEqual([]);
    expect(h.write).not.toHaveBeenCalled();
  });

  it("honors request and runtime signals and never revives disposed requests", () => {
    const h = fixture();
    const request = new AbortController();
    h.controller.setReady();
    h.api.show(tutorial("first"), { signal: request.signal });
    h.api.show(tutorial("second"));
    request.abort();
    expect(h.controller.activeTutorial?.definition.id).toBe("second");
    h.lifetime.abort();
    expect(h.controller.activeTutorial).toBeNull();
    h.api.show(tutorial("late"));
    expect(h.controller.activeTutorial).toBeNull();
    h.controller.dispose();
    h.controller.forPackage("another/guide", new AbortController().signal).show(tutorial("after-dispose"));
    h.controller.setReady();
    expect(h.controller.activeTutorial).toBeNull();
  });
});

describe("tutorial durable progress", () => {
  it("waits for an in-flight deck write before merging completion into the latest save", async () => {
    let save = createDefaultSave();
    save.profile.skillDeck = { carried: [], reserve: [] };
    let stored: RawSaveSnapshot = { longTerm: structuredClone(save), runtime: null };
    let releaseWrite!: () => void;
    let markStarted!: () => void;
    const firstWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let writes = 0;
    const repository = new PersistenceService({
      readSnapshot: async () => stored,
      writeSnapshot: async next => {
        if (++writes === 1) { markStarted(); await firstWrite; }
        stored = structuredClone(next);
      }
    });
    const library = new SkillLibraryController({
      get save() { return save; }, set save(next) { save = next; },
      root: {} as HTMLDivElement, repository, autosave: null
    });
    const deckQueue = library.getDeckQueue();
    const skillId = library.currentAvailableDeckSkills()[0]!.id;
    const deck = { carried: [skillId], reserve: [] };
    const flushPendingSaveWrites = vi.fn(() => deckQueue.flush());
    const controller = new TutorialController({
      get save() { return save; }, set save(next) { save = next; },
      root: {} as HTMLDivElement, repository, autosave: null, enqueueNotification: vi.fn(),
      ...{ flushPendingSaveWrites }
    });
    vi.spyOn(controller, "renderTutorialSurface").mockImplementation(() => {});
    vi.spyOn(controller, "clearTutorialSurface").mockImplementation(() => {});
    const api = controller.forPackage("test/guide", new AbortController().signal);
    controller.setReady();
    api.show({ ...tutorial("intro"), presentation: "sidebar" });
    const editing = deckQueue.update(deck);
    await started;
    controller.finishActiveTutorial();
    releaseWrite();
    await editing;
    await vi.waitFor(() => expect(controller.activeTutorial).toBeNull());
    const durable = await repository.loadLongTerm();
    expect(flushPendingSaveWrites).toHaveBeenCalledOnce();
    expect(save.profile.skillDeck).toEqual(deck);
    expect(durable?.profile.skillDeck).toEqual(deck);
    expect(save.tutorialProgress.completedIds).toEqual(["plugin:test/guide:intro"]);
    expect(durable?.tutorialProgress.completedIds).toEqual(["plugin:test/guide:intro"]);
  });

  it("preserves completion from another writer when the pending-save gate fails", async () => {
    let rejectGate!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => { rejectGate = reject; });
    const flushPendingSaveWrites = vi.fn(() => gate);
    const h = fixture(flushPendingSaveWrites);
    h.controller.setReady();
    h.api.show(tutorial("intro"));
    h.controller.finishActiveTutorial();
    // A different writer has restored durable progress while this request is waiting.
    h.save = { ...h.save, tutorialProgress: { completedIds: ["plugin:test/guide:intro", "unrelated-progress"] } };
    rejectGate(new Error("pending settings could not be saved"));
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
    expect(flushPendingSaveWrites).toHaveBeenCalledOnce();
    expect(h.save.tutorialProgress.completedIds).toEqual(["plugin:test/guide:intro", "unrelated-progress"]);
    expect(h.api.isCompleted("intro")).toBe(true);
    expect(h.write).not.toHaveBeenCalled();
  });

  it("keeps same local IDs isolated by package and allows explicit replay without another write", async () => {
    const h = fixture();
    const other = h.controller.forPackage("other/guide", new AbortController().signal);
    h.controller.setReady();
    h.api.show(tutorial("intro"));
    other.show(tutorial("intro"));
    h.controller.finishActiveTutorial();
    await vi.waitFor(() => expect(h.controller.activeTutorial?.request.progressId).toBe("plugin:other/guide:intro"));
    expect(h.api.isCompleted("intro")).toBe(true);
    expect(other.isCompleted("intro")).toBe(false);
    h.controller.discardActiveTutorial();
    h.api.show(tutorial("intro"));
    expect(h.controller.activeTutorial).toBeNull();
    h.api.show(tutorial("intro"), { replay: true });
    expect(h.controller.activeTutorial?.definition.id).toBe("intro");
    h.controller.finishActiveTutorial();
    expect(h.controller.activeTutorial).toBeNull();
    expect(h.write).toHaveBeenCalledTimes(1);
    h.save = { ...h.save, skipTutorial: true };
    h.api.show(tutorial("intro"), { replay: true });
    expect(h.controller.activeTutorial).toBeNull();
  });

  it("retains a failed tutorial for retry while preserving unrelated concurrent progress", async () => {
    const h = fixture();
    let fail!: (error: Error) => void;
    h.write.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    h.controller.setReady();
    h.api.show(tutorial("intro"));
    h.api.show(tutorial("next"));
    h.controller.finishActiveTutorial();
    h.save = { ...h.save, tutorialProgress: { completedIds: [...h.save.tutorialProgress.completedIds, "unrelated-progress"] } };
    fail(new Error("storage unavailable"));
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
    expect(h.api.isCompleted("intro")).toBe(false);
    expect(h.save.tutorialProgress.completedIds).toEqual(["unrelated-progress"]);
    expect(h.controller.activeTutorial).toMatchObject({ definition: { id: "intro" }, error: "教程进度保存失败，请重试。" });
    h.controller.finishActiveTutorial();
    await vi.waitFor(() => expect(h.controller.activeTutorial?.definition.id).toBe("next"));
    expect(h.save.tutorialProgress.completedIds).toEqual(["unrelated-progress", "plugin:test/guide:intro"]);
    expect(h.write).toHaveBeenCalledTimes(2);
  });

  it("does not restore a cancelled tutorial when a pending completion fails", async () => {
    const h = fixture();
    let fail!: (error: Error) => void;
    h.write.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    h.controller.setReady();
    const cancel = h.api.show(tutorial("intro"));
    h.controller.finishActiveTutorial();
    cancel();
    h.api.show(tutorial("new-request"));
    expect(h.controller.activeTutorial).toBeNull();
    fail(new Error("storage unavailable"));
    await vi.waitFor(() => expect(h.controller.activeTutorial?.definition.id).toBe("new-request"));
    expect(h.save.tutorialProgress.completedIds).toEqual([]);
    cancel();
    expect(h.controller.activeTutorial?.definition.id).toBe("new-request");
  });
});
