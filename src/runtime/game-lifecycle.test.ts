import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootLoad } from "../persistence/boot";
import { gameAudio } from "../audio/game-audio";
import { RuntimeController, type RuntimeControllerDependencies } from "./game-runtime";
import { RuntimeEventHub } from "./public-event-hub";
import type { PublicEvent } from "../core/events/public-events";
import { createDefaultSave } from "../persistence/boot";
import { MemorySaveStorageDriver } from "../persistence/memory-driver";
import { PersistenceService } from "../persistence/save-service";
import { HocpkgManifestSchema } from "../content/packages/schema";
import { bindPluginTutorialIdentity } from "../content/packages/plugin-tutorials";
import type { ExtensionResource } from "../content/packages/resources";
import type { StoryScene } from "../core/story/types";

const repository = vi.hoisted(() => ({
  backend: undefined as PersistenceService | undefined,
  loadRuntime: vi.fn(async () => null), closeGameRuntime: vi.fn(async () => {}),
  deleteRuntime: vi.fn(async () => {}), flush: vi.fn(async () => {})
}));
vi.mock("../persistence/factory", () => ({ createPersistenceService: () => repository.backend ?? repository }));
vi.mock("../persistence/boot", async importOriginal => {
  const actual = await importOriginal<typeof import("../persistence/boot")>();
  return { ...actual, bootLoad: vi.fn(async () => actual.createDefaultSave()) };
});
vi.mock("../persistence/lifecycle", () => ({ bindNativePersistenceLifecycle: vi.fn(async () => async () => {}) }));
vi.mock("../persistence/storage", () => ({ requestPersistentStorage: vi.fn(async () => false) }));
vi.mock("../persistence/presentation", () => ({ presentationStore: () => ({ clearMatch() {}, clearAll() {}, flush: async () => {} }) }));
vi.mock("../audio/game-audio", () => ({ gameAudio: {
  configure: vi.fn(), preloadLobby: vi.fn(), pauseBgm: vi.fn(), restoreBgm: vi.fn(), dispose: vi.fn(async () => {}),
  musicDirector: { setOrder: vi.fn(), forPackage: vi.fn(() => ({})) }
} }));
vi.mock("../presentation/haptic-service", () => ({ haptics: { configure: vi.fn(), stop: vi.fn(async () => {}) } }));
vi.mock("../telemetry", () => ({ gameTelemetry: () => undefined, setTelemetryPackages: vi.fn() }));
vi.mock("../presentation/story-presenter", () => ({ createStoryPresenter: () => ({ update: vi.fn(), perform: vi.fn(async () => {}), dispose: vi.fn() }) }));

beforeEach(() => { vi.clearAllMocks(); repository.backend = undefined; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function harness() {
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    body: { classList: { toggle: vi.fn(), remove: vi.fn() } },
    querySelector: vi.fn(() => null)
  });
  vi.stubGlobal("document", document);
  const root = Object.assign(new EventTarget(), { inert: false, innerHTML: "", replaceChildren: vi.fn() }) as unknown as HTMLDivElement;
  const events = new RuntimeEventHub();
  const facts: PublicEvent[] = [];
  events.subscribe("resolved", batch => { facts.push(...batch.facts); });
  const deps = {
    events, clearAiSchedule: vi.fn(), discardActiveTutorial: vi.fn(), setTutorialsReady: vi.fn(),
    requireAdultContentAcknowledgement: vi.fn(async () => {}), renderError: vi.fn(), enqueueNotification: vi.fn(),
    devCalibrationCharacterId: () => null, writePluginSettings: vi.fn(), dispatch: vi.fn(),
    pauseMatch: vi.fn(), pauseEncounters: vi.fn(), disposeSession: vi.fn(async () => {}),
    disposePresentation: vi.fn(), disposeLobby: vi.fn(), disposeSkills: vi.fn(), clearActiveMatch: vi.fn(),
    renderLobby: vi.fn(async () => { await runtime.navigateScreen(async () => ({ mount: async () => ({ dispose() {} }) }), undefined, "lobby"); }),
    autosave: null
  };
  const runtime = new RuntimeController(deps as unknown as RuntimeControllerDependencies);
  vi.spyOn(runtime, "syncCharacterSkins").mockResolvedValue(undefined);
  return { runtime, deps, root, document, events, facts };
}

it("publishes a successful startup after its first screen and a durable stop before clearing subscribers", async () => {
  const h = harness();
  const handle = await h.runtime.mountGameRuntime({ root: h.root });
  expect(h.facts.map(fact => fact.type)).toEqual(["core.screen-entered", "core.game-started"]);
  expect(h.facts.every(fact => fact.scopes.game === h.runtime.gameScopeId)).toBe(true);
  expect(h.facts[1].data).toEqual({ restored: false });
  const publishedBeforeSessionCleanup = h.facts.length;
  h.deps.disposeSession.mockImplementation(async () => {
    expect(h.facts.some(fact => fact.type === "core.game-stopped")).toBe(false);
  });
  await handle.dispose();
  expect(h.facts.slice(publishedBeforeSessionCleanup).map(fact => fact.type)).toEqual(["core.screen-left", "core.game-stopped"]);
  await handle.dispose();
  expect(h.facts.filter(fact => fact.type === "core.game-stopped")).toHaveLength(1);
  const listener = vi.fn();
  h.events.subscribe("resolved", listener);
  h.events.publish("resolved", { id: "late", facts: [h.facts[0]], restored: false });
  expect(listener).not.toHaveBeenCalled();
  await expect(h.runtime.mountGameRuntime({ root: h.root })).rejects.toThrow("请创建新的运行时");
});

it("publishes the duel action only when explicitly requested in a live game", async () => {
  const h = harness();
  h.runtime.notifyDuelRequested();
  expect(h.facts).toEqual([]);
  const handle = await h.runtime.mountGameRuntime({ root: h.root });
  await h.deps.renderLobby();
  expect(h.facts.some(fact => fact.type === "core.duel-requested")).toBe(false);
  h.runtime.notifyDuelRequested();
  const action = h.facts.at(-1)!;
  expect(action.type).toBe("core.duel-requested");
  expect(action.scopes).toEqual({ game: h.runtime.gameScopeId });
  await handle.dispose();
  const count = h.facts.length;
  h.runtime.notifyDuelRequested();
  expect(h.facts).toHaveLength(count);
});

it("never announces a start or stop for failed or cancelled startup", async () => {
  const failed = harness();
  vi.mocked(bootLoad).mockRejectedValueOnce(new Error("unreadable save"));
  const handle = await failed.runtime.mountGameRuntime({ root: failed.root });
  expect(failed.deps.renderError).toHaveBeenCalledOnce();
  expect(failed.facts).toEqual([]);
  await handle.dispose();
  expect(failed.facts).toEqual([]);

  const cancelled = harness();
  let release!: () => void;
  cancelled.deps.requireAdultContentAcknowledgement.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const mounting = cancelled.runtime.mountGameRuntime({ root: cancelled.root });
  await vi.waitFor(() => expect(release).toBeDefined());
  await cancelled.runtime.disposeGameRuntime();
  release();
  await mounting;
  expect(cancelled.deps.renderLobby).not.toHaveBeenCalled();
  expect(cancelled.facts).toEqual([]);
});

it("keeps a failed exit live without a stopped event, then emits it once after a successful retry", async () => {
  const h = harness();
  const handle = await h.runtime.mountGameRuntime({ root: h.root });
  repository.flush.mockRejectedValueOnce(new Error("storage refused"));
  await expect(handle.dispose()).rejects.toThrow("storage refused");
  expect(h.runtime.mounted).toBe(true);
  expect(h.facts.map(fact => fact.type)).toEqual(["core.screen-entered", "core.game-started"]);
  await handle.dispose();
  expect(h.facts.filter(fact => fact.type === "core.game-stopped")).toHaveLength(1);
});

it("publishes visibility suspension and resumption only after successful state changes", async () => {
  const h = harness();
  const handle = await h.runtime.mountGameRuntime({ root: h.root });
  h.document.hidden = true;
  h.document.dispatchEvent(new Event("visibilitychange"));
  h.document.dispatchEvent(new Event("visibilitychange"));
  h.document.hidden = false;
  h.document.dispatchEvent(new Event("visibilitychange"));
  expect(h.facts.slice(2).map(fact => fact.type)).toEqual(["core.game-suspended", "core.game-resumed"]);
  expect(gameAudio.pauseBgm).toHaveBeenCalledOnce();
  expect(gameAudio.restoreBgm).toHaveBeenCalledOnce();
  await handle.dispose();
  const count = h.facts.length;
  h.document.hidden = true;
  h.document.dispatchEvent(new Event("visibilitychange"));
  expect(h.facts).toHaveLength(count);
});

it("completes startup when a plugin awaits a story from mountRuntime", async () => {
  const h = harness();
  repository.backend = new PersistenceService(new MemorySaveStorageDriver({ longTerm: createDefaultSave(), runtime: null }));
  const scene: StoryScene = { entry: "end", nodes: [{ id: "end", type: "end", result: "welcomed" }] };
  const manifest = HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "neutral", packageName: "startup", version: "1.0.0" },
    metadata: { title: "Startup story", description: "Neutral startup fixture", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [{ id: "intro", type: "story.scene", apiVersion: 1, entry: "intro.json", requires: [] }],
    files: [{ path: "intro.json", bytes: 1, sha256: "a".repeat(64), mediaType: "application/json" }], extensions: {} });
  const resource: ExtensionResource = { packageId: "neutral/startup", packageManifest: manifest, descriptor: manifest.resources[0], value: scene, resolvePath: path => `memory:/${path}` };
  const order: string[] = [], release = vi.fn();
  const plugin = bindPluginTutorialIdentity({ mountRuntime: async (context: import("../content/packages/plugin-contracts").PluginGameRuntimeContext) => {
    order.push("plugin-mount");
    const result = await context.stories!.play("intro");
    order.push(`story-${result.status}`);
    expect(result.result).toBe("welcomed");
    return release;
  } }, { packageId: "neutral/startup", apiVersion: 13 });
  h.deps.renderLobby.mockImplementation(async () => {
    order.push("first-screen");
    await h.runtime.navigateScreen(async () => ({ mount: async () => ({ dispose() {} }) }), undefined, "lobby");
  });
  let handle: Awaited<ReturnType<RuntimeController["mountGameRuntime"]>> | undefined;
  const mounting = h.runtime.mountGameRuntime({ root: h.root, contributions: [plugin], storyResources: () => ({ "story.scene": [resource] }) })
    .then(result => { handle = result; });
  await vi.waitFor(() => expect(handle).toBeDefined());
  await mounting;
  expect(order).toEqual(["plugin-mount", "first-screen", "story-completed"]);
  expect(h.deps.renderError).not.toHaveBeenCalled();
  expect(h.facts.at(-1)?.type).toBe("core.game-started");
  await handle!.dispose(); expect(release).toHaveBeenCalledOnce();
});

it("retains plugin mount failure and cleanup ownership while the first screen is prepared", async () => {
  const h = harness(), release = vi.fn(), failure = new Error("startup plugin failed");
  const handle = await h.runtime.mountGameRuntime({ root: h.root, contributions: [
    { mountRuntime: () => release }, { mountRuntime: async () => { await Promise.resolve(); throw failure; } }
  ] });
  expect(h.deps.renderLobby).toHaveBeenCalledOnce();
  expect(h.deps.renderError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(release).toHaveBeenCalledOnce();
  expect(h.facts.some(fact => fact.type === "core.game-started")).toBe(false);
  await handle.dispose(); expect(release).toHaveBeenCalledOnce();
});
