import { afterEach, expect, it, vi } from "vitest";
import { gameAudio } from "../audio/game-audio";
import { createMatch } from "../core/match/reducer";
import { createDefaultSave } from "../persistence/boot";
import { resourceLoader } from "../resources/resource-loader";
import { RuntimeController, type RuntimeControllerDependencies } from "./game-runtime";
import { RuntimeExtensions } from "./runtime-extensions";
import { RuntimeScreenRouter } from "./screen-router";

const presentation = vi.hoisted(() => ({ clearMatch: vi.fn(), flush: vi.fn(async () => {}) }));
vi.mock("../persistence/presentation", () => ({ presentationStore: () => presentation }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("clears old tutorials after page disposal and before the next page can request one", async () => {
  const order: string[] = [];
  const runtime = new RuntimeController({
    discardActiveTutorial: () => { order.push("clear-tutorials"); }
  } as unknown as RuntimeControllerDependencies);
  const router = new RuntimeScreenRouter({ reportNavigationError: () => { order.push("load-failed"); } } as never, {});
  Reflect.set(runtime, "router", router);
  await runtime.navigateScreen(async () => ({ mount: async () => {
    order.push("first-page-tutorial");
    return { dispose: () => { order.push("dispose-first-page"); } };
  } }));
  expect(order).toEqual(["clear-tutorials", "first-page-tutorial"]);
  order.length = 0;
  await runtime.navigateScreen(async () => { throw new Error("failed load"); });
  expect(order).toEqual(["load-failed"]);
  order.length = 0;
  await runtime.navigateScreen(async () => ({ mount: async () => {
    order.push("new-page-tutorial");
    return { dispose() {} };
  } }));
  expect(order).toEqual(["dispose-first-page", "clear-tutorials", "new-page-tutorial"]);
  await router.dispose();
});

function closingRuntime() {
  const state = createMatch("exit-cleanup");
  const save = createDefaultSave();
  const deps = {
    pauseMatch: vi.fn(), clearAiSchedule: vi.fn(), scheduleAiTurn: vi.fn(), clearActiveMatch: vi.fn(),
    deckQueue: { flush: vi.fn(async () => {}) },
    flushTutorials: vi.fn(async () => {}),
    autosave: { flush: vi.fn(async () => {}), getState: () => state, getSave: () => save },
    disposePresentation: vi.fn(), disposeLobby: vi.fn(), disposeSkills: vi.fn(), disposeSession: vi.fn(async () => {})
  };
  const runtime = new RuntimeController(deps as unknown as RuntimeControllerDependencies);
  const root = Object.assign(new EventTarget(), { inert: false, replaceChildren: vi.fn() }) as unknown as HTMLDivElement;
  const document = { removeEventListener: vi.fn(), querySelector: vi.fn(() => ({ remove: vi.fn() })), body: { classList: { remove: vi.fn() } } };
  vi.stubGlobal("document", document);
  const resources = vi.spyOn(resourceLoader, "dispose").mockImplementation(() => {});
  const audio = vi.spyOn(gameAudio, "dispose").mockResolvedValue(undefined);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const repository = {
    closeGameRuntime: vi.fn(async () => {}), deleteRuntime: vi.fn(async () => {}), flush: vi.fn(async () => {})
  };
  runtime.root = root;
  runtime.repository = repository as unknown as RuntimeController["repository"];
  runtime.runtimeEventController = new AbortController();
  runtime.mounted = true;
  runtime.saveLoaded = true;
  runtime.save = save;
  runtime.interactionHapticsAttached = true;
  return { runtime, deps, root, document, resources, audio, report, repository };
}

it("waits for pending tutorial completion before capturing the durable exit snapshot", async () => {
  const { runtime, deps, root, repository } = closingRuntime();
  const order: string[] = [];
  let finishTutorial!: () => void;
  const completion = new Promise<void>(resolve => { finishTutorial = resolve; });
  const saved = { ...runtime.save, tutorialProgress: { completedIds: ["plugin:test/guide:intro"] } };
  deps.deckQueue.flush.mockImplementation(async () => { order.push("deck"); });
  deps.flushTutorials.mockImplementation(async () => {
    order.push("tutorial");
    await completion;
    runtime.save = saved;
    deps.autosave.getSave = () => saved;
  });
  deps.autosave.flush.mockImplementation(async () => { order.push("autosave"); });
  const exiting = runtime.disposeGameRuntime();
  await vi.waitFor(() => expect(deps.flushTutorials).toHaveBeenCalledOnce());
  expect(order).toEqual(["deck", "tutorial"]);
  expect(root.inert).toBe(true);
  expect(runtime.mounted).toBe(true);
  expect(deps.autosave.flush).not.toHaveBeenCalled();
  expect(repository.closeGameRuntime).not.toHaveBeenCalled();
  expect(deps.disposePresentation).not.toHaveBeenCalled();
  finishTutorial();
  await exiting;
  expect(order).toEqual(["deck", "tutorial", "autosave"]);
  expect(repository.closeGameRuntime).toHaveBeenCalledExactlyOnceWith(saved);
  expect(deps.disposePresentation).toHaveBeenCalledOnce();
  expect(runtime.mounted).toBe(false);
});

it("preserves a failed exit session, restores interaction and resumes scheduling before any release", async () => {
  const order: string[] = [];
  const state = createMatch("exit-storage-failure");
  const save = createDefaultSave();
  const pause = vi.fn();
  const schedule = vi.fn();
  const dispose = vi.fn();
  const runtime = new RuntimeController({
    pauseMatch: pause, clearAiSchedule: () => { order.push("pause-ai"); }, scheduleAiTurn: schedule,
    deckQueue: { flush: async () => { order.push("deck"); } },
    autosave: { flush: async () => { order.push("match"); }, getState: () => state, getSave: () => save },
    disposePresentation: dispose, disposeSession: dispose, disposeLobby: dispose, disposeSkills: dispose,
  } as unknown as RuntimeControllerDependencies);
  runtime.root = { inert: false } as HTMLDivElement;
  runtime.repository = { closeGameRuntime: async () => { order.push("close"); throw new Error("storage refused"); } } as unknown as RuntimeController["repository"];
  runtime.runtimeEventController = new AbortController();
  runtime.mounted = true;
  runtime.saveLoaded = true;
  runtime.save = save;
  await expect(runtime.disposeGameRuntime()).rejects.toThrow("storage refused");
  expect(order).toEqual(["pause-ai", "deck", "match", "close"]);
  expect(runtime.mounted).toBe(true);
  expect(runtime.root.inert).toBe(false);
  expect(runtime.runtimeEventController.signal.aborted).toBe(false);
  expect(pause.mock.calls).toEqual([[true], [false]]);
  expect(schedule).toHaveBeenCalledExactlyOnceWith(state);
  expect(dispose).not.toHaveBeenCalled();
});

it("finishes durable exit after plugin and host cleanup failures and reports all failures", async () => {
  const { runtime, deps, root, document, resources, audio, report, repository } = closingRuntime();
  const pluginFailure = new Error("plugin cleanup failed");
  const navigationFailure = new Error("screen cleanup failed");
  const sessionFailure = new Error("session cleanup failed");
  const hapticFailure = new Error("haptic cleanup failed");
  const pluginRelease = vi.fn(() => { throw pluginFailure; });
  const otherPluginRelease = vi.fn();
  runtime.extensions = new RuntimeExtensions({
    context: runtime.pluginContext(), contributions: [
      { mountRuntime: () => otherPluginRelease }, { mountRuntime: () => pluginRelease }
    ],
    getMatch: () => undefined, dispatch: vi.fn(), autoActionsChanged: vi.fn()
  });
  await runtime.extensions.mount();
  const navigation = vi.fn(async () => { throw navigationFailure; });
  Reflect.set(runtime, "router", { dispose: navigation });
  const settingsRelease = vi.fn();
  Reflect.set(runtime, "releaseSettingsWriter", settingsRelease);
  const hapticRelease = vi.fn(async () => { throw hapticFailure; });
  const nativeRelease = vi.fn(async () => {});
  runtime.hapticLifecycleDisposer = hapticRelease;
  runtime.nativeLifecycleDisposer = nativeRelease;
  deps.disposeSession.mockRejectedValueOnce(sessionFailure);
  const signal = runtime.runtimeEventController!.signal;

  await expect(runtime.disposeGameRuntime()).resolves.toBeUndefined();

  expect(repository.flush).toHaveBeenCalledOnce();
  expect(pluginRelease).toHaveBeenCalledOnce();
  expect(otherPluginRelease).toHaveBeenCalledOnce();
  expect(navigation).toHaveBeenCalledOnce();
  expect(deps.disposePresentation).toHaveBeenCalledOnce();
  expect(deps.disposeLobby).toHaveBeenCalledOnce();
  expect(deps.disposeSkills).toHaveBeenCalledOnce();
  expect(deps.disposeSession).toHaveBeenCalledOnce();
  expect(settingsRelease).toHaveBeenCalledOnce();
  expect(document.removeEventListener).toHaveBeenCalledOnce();
  expect(hapticRelease).toHaveBeenCalledOnce();
  expect(nativeRelease).toHaveBeenCalledOnce();
  expect(presentation.clearMatch).toHaveBeenCalledExactlyOnceWith(deps.autosave.getState().id);
  expect(presentation.flush).toHaveBeenCalledOnce();
  expect(resources).toHaveBeenCalledOnce();
  expect(audio).toHaveBeenCalledOnce();
  expect(root.replaceChildren).toHaveBeenCalledOnce();
  expect(deps.clearActiveMatch).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(true);
  expect(runtime.mounted).toBe(false);
  expect(runtime.saveLoaded).toBe(false);
  expect(root.inert).toBe(false);
  expect(runtime.extensions).toBeUndefined();
  expect(runtime.runtimeEventController).toBeUndefined();
  expect(runtime.hapticLifecycleDisposer).toBeUndefined();
  expect(runtime.nativeLifecycleDisposer).toBeUndefined();
  expect(report).toHaveBeenCalledOnce();
  const failure = report.mock.calls[0][1] as AggregateError;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual(expect.arrayContaining([navigationFailure, sessionFailure, hapticFailure]));
  expect(failure.errors.find(error => error instanceof AggregateError)?.errors).toEqual([pluginFailure]);

  // A completed exit does not retry releases that have already been attempted.
  await runtime.disposeGameRuntime();
  expect(pluginRelease).toHaveBeenCalledOnce();
  expect(audio).toHaveBeenCalledOnce();
  expect(repository.flush).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
});

it("retries a failed persistence flush without releasing the live runtime early", async () => {
  const { runtime, deps, root, repository, resources, audio, report } = closingRuntime();
  const storageFailure = new Error("flush refused");
  repository.flush.mockRejectedValueOnce(storageFailure);
  const release = vi.fn();
  runtime.extensions = new RuntimeExtensions({
    context: runtime.pluginContext(), contributions: [{ mountRuntime: () => release }],
    getMatch: () => undefined, dispatch: vi.fn(), autoActionsChanged: vi.fn()
  });
  await runtime.extensions.mount();
  const signal = runtime.runtimeEventController!.signal;

  await expect(runtime.disposeGameRuntime()).rejects.toBe(storageFailure);
  expect(runtime.mounted).toBe(true);
  expect(root.inert).toBe(false);
  expect(signal.aborted).toBe(false);
  expect(deps.pauseMatch.mock.calls).toEqual([[true], [false]]);
  expect(deps.scheduleAiTurn).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  expect(resources).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();

  await runtime.disposeGameRuntime();
  expect(repository.flush).toHaveBeenCalledTimes(2);
  expect(runtime.mounted).toBe(false);
  expect(release).toHaveBeenCalledOnce();
  expect(resources).toHaveBeenCalledOnce();
  expect(audio).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
});
