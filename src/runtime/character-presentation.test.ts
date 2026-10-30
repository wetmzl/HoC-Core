import { afterEach, expect, it, vi } from "vitest";
import { clearCharacterCatalog, getCharacterMetadata, installCharacterCatalog, type CharacterDefinition, type CharacterMetadata } from "../content/characters";
import type { LongTermSave } from "../persistence/schema";
import { createDefaultSave } from "../persistence/boot";
import { resourceLoader } from "../resources/resource-loader";
import { RuntimeController, type RuntimeControllerDependencies } from "./game-runtime";
import { RuntimeExtensions } from "./runtime-extensions";
import type { PluginRuntimeContribution } from "../content/packages/plugin-contracts";
import { SettingsController, type SettingsControllerDependencies } from "./save-settings";

const key = "neutral/example#character";
const metadata = (skinId = "original"): CharacterMetadata => ({
  id: "example", name: "Example", subtitle: "Fixture", tier: "D", tags: [], previewImage: `${skinId}.png`,
  portraitScales: { selection: 1, table: 1 },
  appearance: { key, skinId, skins: [{ id: "original", name: "Original" }, { id: "blue", name: "Blue" }] }
});

afterEach(() => { clearCharacterCatalog(); vi.restoreAllMocks(); });

function fixture(contributions: readonly PluginRuntimeContribution[] = []) {
  installCharacterCatalog([metadata()], "example");
  const redraw = vi.fn();
  const runtime = new RuntimeController({
    clearAiSchedule() {}, scheduleAiTurn() {}, dispatch() {}, redrawLobbyCharacters: redraw,
    flushSettings: async () => {}, flushTutorials: async () => {}
  } as unknown as RuntimeControllerDependencies);
  runtime.root = new EventTarget() as HTMLDivElement;
  runtime.save = createDefaultSave();
  runtime.save.characterSkinUnlocks = { [key]: { blue: true } };
  runtime.mounted = true;
  const save = vi.fn(async (_save: LongTermSave) => {});
  runtime.repository = { saveLongTerm: save } as unknown as RuntimeController["repository"];
  const settings = new SettingsController({
    get save() { return runtime.save; }, set save(value) { runtime.save = value; },
    get autosave() { return Reflect.get(runtime, "deps").autosave; },
    repository: runtime.repository
  } as SettingsControllerDependencies);
  Reflect.get(runtime, "deps").writeCharacterSkinUnlocks = settings.writeCharacterSkinUnlocks;
  const release = vi.fn();
  const activate = vi.fn(() => installCharacterCatalog([metadata("blue")], "example"));
  const rollback = vi.fn(() => installCharacterCatalog([metadata()], "example"));
  const dispose = vi.fn();
  const prepare = vi.fn(async () => ({
    characters: [{ ...metadata("blue"), dialogue: { fallbackPoolId: "opening", poolPortraits: { opening: { image: "blue.png" } } } } as unknown as CharacterDefinition],
    contributions, activate, rollback, dispose, retirePrevious: release
  }));
  Reflect.set(runtime, "preparePresentation", prepare);
  const images = vi.spyOn(resourceLoader, "enqueue").mockResolvedValue([true, true]);
  return { runtime, save, prepare, activate, rollback, dispose, release, redraw, images, api: runtime.pluginContext().characterPresentation! };
}

it("reads detached skin catalogs and omits the capability when preparation is unavailable", () => {
  const { runtime, api } = fixture();
  const result = api.get("example")!;
  expect(result).toEqual(metadata().appearance);
  expect(api.get("missing")).toBeUndefined();
  (result.skins[0] as { name: string }).name = "Changed";
  expect(api.get("example")!.skins[0].name).toBe("Original");
  Reflect.set(runtime, "preparePresentation", undefined);
  expect(runtime.pluginContext().characterPresentation).toBeUndefined();
});

it("persists the selected skin and rebuilds contributions before resolving, retaining old page media until its signal ends", async () => {
  const mount = vi.fn();
  const f = fixture([{ mountRuntime: mount }]);
  const route = new AbortController();
  await f.api.select("example", "blue", route.signal);
  expect(f.runtime.save.settings.characterSkins).toEqual({ [key]: "blue" });
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith({ [key]: "blue" }, { [key]: { blue: true } });
  expect(f.activate).toHaveBeenCalledOnce();
  expect(mount).toHaveBeenCalledOnce();
  expect(f.api.get("example")?.skinId).toBe("blue");
  expect(f.release).not.toHaveBeenCalled();
  route.abort(); route.abort();
  expect(f.release).toHaveBeenCalledOnce();
  f.runtime.extensions?.dispose();
});

it("resolves a committed selection even when rebuilding subscriptions aborts the initiating subscription", async () => {
  const f = fixture();
  let sourceSignal!: AbortSignal;
  const oldRelease = vi.fn();
  f.runtime.extensions = new RuntimeExtensions({
    context: f.runtime.pluginContext(), contributions: [{ mountRuntime(_context, signal) { sourceSignal = signal; return oldRelease; } }],
    getMatch: () => undefined, dispatch() {}, autoActionsChanged() {}
  });
  await f.runtime.extensions.mount();
  await expect(f.api.select("example", "blue", sourceSignal)).resolves.toBeUndefined();
  expect(sourceSignal.aborted).toBe(true);
  expect(oldRelease).toHaveBeenCalledOnce();
  expect(f.runtime.save.settings.characterSkins).toEqual({ [key]: "blue" });
  expect(f.release).toHaveBeenCalledOnce();
  f.runtime.extensions?.dispose();
});

it("keeps the old skin and save when preparing media fails", async () => {
  const f = fixture();
  const before = f.runtime.save;
  f.images.mockResolvedValue([true, false]);
  await expect(f.api.select("example", "blue", new AbortController().signal)).rejects.toThrow("加载失败");
  expect(f.runtime.save).toBe(before);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  expect(f.dispose).toHaveBeenCalledOnce();
});

it("restores the old save and appearance when persistence fails and permits a retry", async () => {
  const f = fixture();
  const before = f.runtime.save;
  f.save.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(f.api.select("example", "blue", new AbortController().signal)).rejects.toThrow("storage unavailable");
  expect(f.runtime.save).toBe(before);
  expect(getCharacterMetadata("example")?.appearance?.skinId).toBe("original");
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  const route = new AbortController();
  await f.api.select("example", "blue", route.signal);
  route.abort();
  f.runtime.extensions?.dispose();
});

it("rolls back persistence and restores previous subscriptions if a replacement plugin cannot mount", async () => {
  const f = fixture([{ mountRuntime() { throw new Error("mount failed"); } }]);
  const before = f.runtime.save;
  const oldMount = vi.fn();
  f.runtime.runtimeContributions = [{ mountRuntime: oldMount }];
  await expect(f.api.select("example", "blue", new AbortController().signal)).rejects.toThrow("mount failed");
  expect(f.save.mock.calls.map(([value]) => value)).toEqual([
    expect.objectContaining({ settings: expect.objectContaining({ characterSkins: { [key]: "blue" } }) }), before
  ]);
  expect(f.runtime.save).toBe(before);
  expect(oldMount).toHaveBeenCalledOnce();
  expect(f.api.get("example")?.skinId).toBe("original");
  expect(f.release).not.toHaveBeenCalled();
  f.runtime.extensions?.dispose();
});

it("cancels a selection while persistence is pending without keeping its new preference", async () => {
  const f = fixture();
  const before = f.runtime.save;
  const route = new AbortController();
  let finish!: () => void;
  f.save.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const selection = f.api.select("example", "blue", route.signal);
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  route.abort(); finish();
  await expect(selection).rejects.toThrow("已取消");
  expect(f.runtime.save).toBe(before);
  expect(f.save).toHaveBeenLastCalledWith(before);
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  f.runtime.extensions?.dispose();
});

it("settles a pending skin rollback before runtime exit can close its save", async () => {
  const f = fixture();
  const before = f.runtime.save;
  const deps = Reflect.get(f.runtime, "deps");
  deps.pauseMatch = vi.fn();
  const close = vi.fn();
  Reflect.set(f.runtime.repository, "closeGameRuntime", close);
  deps.flushEncounters = async () => { throw new Error("stop fixture exit"); };
  let finish!: () => void;
  f.save.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const selection = f.api.select("example", "blue", new AbortController().signal);
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  const selectionResult = expect(selection).rejects.toThrow("已取消");
  const exit = f.runtime.disposeGameRuntime();
  expect(close).not.toHaveBeenCalled();
  finish();
  await selectionResult;
  await expect(exit).rejects.toThrow("stop fixture exit");
  expect(f.save).toHaveBeenLastCalledWith(before);
  expect(f.runtime.save).toBe(before);
  expect(f.activate).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("rejects cancelled, unavailable and concurrent changes without committing", async () => {
  const f = fixture();
  await expect(f.api.select("example", "blue", AbortSignal.abort())).rejects.toThrow("已取消");
  await expect(f.api.select("example", "missing", new AbortController().signal)).rejects.toThrow("不可用");
  let finish!: () => void;
  f.images.mockImplementationOnce(() => new Promise<boolean[]>(resolve => { finish = () => resolve([true, true]); }));
  const route = new AbortController();
  const first = f.api.select("example", "blue", route.signal);
  await vi.waitFor(() => expect(f.images).toHaveBeenCalledOnce());
  await f.runtime.syncCharacterSkins();
  expect(f.prepare).toHaveBeenCalledOnce();
  await expect(f.api.select("example", "blue", new AbortController().signal)).rejects.toThrow("稍后重试");
  finish(); await first; route.abort();
  expect(f.save).toHaveBeenCalledOnce();
  f.runtime.extensions?.dispose();
});


it("keeps current matches fixed and does not persist a no-op selection", async () => {
  const f = fixture();
  await f.api.select("example", "original", new AbortController().signal);
  expect(f.prepare).not.toHaveBeenCalled();
  Reflect.get(f.runtime, "deps").autosave = {};
  await expect(f.api.select("example", "blue", new AbortController().signal)).rejects.toThrow("稍后重试");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});


it("keeps a committed selection successful when refreshing a visible list fails", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  f.redraw.mockImplementation(() => { throw new Error("list unavailable"); });
  const route = new AbortController();
  await expect(f.api.select("example", "blue", route.signal)).resolves.toBeUndefined();
  expect(f.api.get("example")?.skinId).toBe("blue");
  expect(f.runtime.save.settings.characterSkins).toEqual({ [key]: "blue" });
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.rollback).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("刷新失败"), expect.any(Error));
  route.abort();
  f.runtime.extensions?.dispose();
});

it("does not roll back an activated selection when old media cleanup fails", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  f.release.mockImplementation(() => { throw new Error("release unavailable"); });
  let sourceSignal!: AbortSignal;
  f.runtime.extensions = new RuntimeExtensions({
    context: f.runtime.pluginContext(), contributions: [{ mountRuntime(_context, signal) { sourceSignal = signal; } }],
    getMatch: () => undefined, dispatch() {}, autoActionsChanged() {}
  });
  await f.runtime.extensions.mount();
  await expect(f.api.select("example", "blue", sourceSignal)).resolves.toBeUndefined();
  expect(f.api.get("example")?.skinId).toBe("blue");
  expect(f.runtime.save.settings.characterSkins).toEqual({ [key]: "blue" });
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.rollback).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("清理失败"), expect.any(Error));
  f.runtime.extensions?.dispose();
});

it("defaults to the initial skin, rejects locked selection, and exposes detached unlock snapshots", async () => {
  const f = fixture(); f.runtime.save.characterSkinUnlocks = {};
  const api = f.runtime.pluginContext().characterSkinUnlocks!;
  expect(api.get("example")).toEqual([{ id: "original", name: "Original", unlocked: true }, { id: "blue", name: "Blue", unlocked: false }]);
  expect(api.get("missing")).toBeUndefined();
  expect(api.isUnlocked("example", "missing")).toBe(false);
  expect(api.isUnlocked("missing", "blue")).toBe(false);
  const snapshot = api.get("example")!;
  (snapshot[1] as { unlocked: boolean }).unlocked = true;
  await expect(f.api.select("example", "blue", new AbortController().signal)).rejects.toThrow("尚未解锁");
  expect(f.save).not.toHaveBeenCalled();
  await api.unlock("example", "blue");
  expect(api.isUnlocked("example", "blue")).toBe(true);
  const signal = new AbortController();
  await f.api.select("example", "blue", signal.signal);
  expect(f.runtime.save.characterSkinUnlocks).toEqual({ [key]: { blue: true } });
  await expect(api.lock("example", "blue")).rejects.toThrow("先切换");
  signal.abort(); f.runtime.extensions?.dispose();
});

it("serializes concurrent unlock writes, rejects atomic invalid batches and resets to initial-only access", async () => {
  const f = fixture(); f.runtime.save.characterSkinUnlocks = {};
  const api = f.runtime.pluginContext().characterSkinUnlocks!;
  await Promise.all([api.unlock("example", "blue"), api.lock("example", "blue"), api.setUnlocked("example", "blue", true)]);
  expect(f.runtime.save.characterSkinUnlocks).toEqual({ [key]: { blue: true } });
  const before = f.runtime.save;
  await expect(api.setMany("example", { blue: false, missing: true })).rejects.toThrow("不可用");
  await expect(api.setMany("example", { blue: "yes" } as never)).rejects.toThrow();
  await expect(api.lock("example", "original")).rejects.toThrow("初始服装");
  expect(f.runtime.save).toBe(before);
  await api.reset("example");
  expect(api.isUnlocked("example", "original")).toBe(true);
  expect(api.isUnlocked("example", "blue")).toBe(false);
  const writes = f.save.mock.calls.length;
  await api.reset("example");
  expect(f.save).toHaveBeenCalledTimes(writes);
});

it("does not publish failed unlock writes and permits retry during an active match", async () => {
  const f = fixture(); f.runtime.save.characterSkinUnlocks = {};
  const api = f.runtime.pluginContext().characterSkinUnlocks!;
  let activeSave = f.runtime.save;
  Reflect.get(f.runtime, "deps").autosave = {
    getSave: () => activeSave, flush: vi.fn(async () => {}), updateSave: (save: LongTermSave) => { activeSave = save; }
  };
  const changed = vi.fn(); f.runtime.root.addEventListener("character-skin-unlocks-changed", changed);
  f.save.mockRejectedValueOnce(new Error("disk full"));
  await expect(api.unlock("example", "blue")).rejects.toThrow("disk full");
  expect(api.isUnlocked("example", "blue")).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(activeSave.characterSkinUnlocks).toEqual({});
  await api.unlock("example", "blue");
  expect(activeSave.characterSkinUnlocks).toEqual({ [key]: { blue: true } });
  expect(changed).toHaveBeenCalledOnce();
  await expect(f.api.select("example", "blue", new AbortController().signal)).rejects.toThrow("稍后重试");
  f.runtime.mounted = false;
  await expect(api.lock("example", "blue")).rejects.toThrow("已退出");
});
