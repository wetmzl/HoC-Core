import { afterEach, expect, it, vi } from "vitest";
import { SettingsController, type SettingsControllerDependencies } from "./save-settings";
import { PluginSettingsSession } from "../content/packages/plugin-settings";
import { createDefaultSave } from "../persistence/boot";
import { gameAudio } from "../audio/game-audio";
import { changeCharacterSkinUnlocks } from "../persistence/skin-unlocks";
import { hapticPreferences } from "../presentation/haptic-preferences";
import { haptics } from "../presentation/haptic-service";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("serializes durable skin progress with other settings and preserves both concurrent updates", async () => {
  vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
  vi.spyOn(gameAudio, "setMusicVolume").mockImplementation(() => {});
  const appearance = { key: "neutral/character#match", skinId: "original", skins: [{ id: "original", name: "初始" }, { id: "blue", name: "蓝色" }] };
  const deps = { save: createDefaultSave(), autosave: null, repository: { saveLongTerm: vi.fn(async () => {}) }, root: { querySelector: () => null } } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  await Promise.all([
    controller.writeCharacterSkinUnlocks(save => changeCharacterSkinUnlocks(save, appearance, { blue: true })),
    controller.updateSettings({ target: { dataset: { setting: "musicVolume" }, valueAsNumber: .4 } } as unknown as Event)
  ]);
  expect(deps.save.characterSkinUnlocks).toEqual({ [appearance.key]: { blue: true } });
  expect(deps.save.settings.musicVolume).toBe(.4);
  expect(deps.repository.saveLongTerm).toHaveBeenLastCalledWith(deps.save);
});

it("saves the Stand preference without changing sound and ignores unknown setting names", async () => {
  vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
  const unlock = vi.spyOn(gameAudio, "unlock").mockImplementation(() => undefined);
  const configure = vi.spyOn(gameAudio, "configure").mockImplementation(() => undefined);
  const saveLongTerm = vi.fn(async () => undefined);
  const deps = { save: createDefaultSave(), repository: { saveLongTerm }, root: { querySelector: () => null } } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  await controller.updateSettings({ target: { dataset: { setting: "autoSkipAfterStand" }, checked: false } } as unknown as Event);
  expect(deps.save.settings).toMatchObject({ autoSkipAfterStand: false, soundEnabled: true, reducedMotion: false });
  expect(saveLongTerm).toHaveBeenCalledWith(deps.save);
  expect(unlock).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
  await controller.updateSettings({ target: { dataset: { setting: "unknown" }, checked: false } } as unknown as Event);
  expect(saveLongTerm).toHaveBeenCalledOnce();
  expect(deps.save.settings.soundEnabled).toBe(true);
});

it("persists package settings before notifying and recovers after a failed write", async () => {
  const session = new PluginSettingsSession();
  session.register({ packageId: "neutral/plugin", title: "示例", declaration: { version: 1, fields: [{ id: "enabled", label: "开关", description: "示例", hidden: true, apply: "immediate", default: false, schema: { type: "boolean" } }] } });
  let finish!: () => void;
  const saveLongTerm = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const deps = { save: createDefaultSave(), autosave: null, pluginSettingsSession: session, repository: { saveLongTerm } } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  const listener = vi.fn(); session.forPackage("neutral/plugin").subscribe(listener);
  const first = controller.writePluginSettings("neutral/plugin", { enabled: true });
  await vi.waitFor(() => expect(saveLongTerm).toHaveBeenCalledOnce());
  expect(session.values("neutral/plugin").enabled).toBe(false);
  expect(listener).not.toHaveBeenCalled();
  finish(); await first;
  expect(session.values("neutral/plugin").enabled).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
  saveLongTerm.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(controller.writePluginSettings("neutral/plugin", { enabled: false })).rejects.toThrow("storage unavailable");
  expect(session.values("neutral/plugin").enabled).toBe(true);
  saveLongTerm.mockResolvedValueOnce();
  await controller.writePluginSettings("neutral/plugin", { enabled: false });
  expect(session.values("neutral/plugin").enabled).toBe(false);
});

it("persists music volume after preview, restores a failed write, and allows retry", async () => {
  vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
  const volume = vi.spyOn(gameAudio, "setMusicVolume").mockImplementation(() => {});
  const status = { textContent: "" }, readout = { textContent: "37%" };
  let finish!: () => void;
  const saveLongTerm = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const deps = { save: createDefaultSave(), repository: { saveLongTerm }, root: { querySelector: (selector: string) => selector === "#lobby-status" ? status : readout } } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  const input = { dataset: { setting: "musicVolume" }, valueAsNumber: .37, value: "0.37", disabled: false, closest: vi.fn() };
  const button = { disabled: false }, alreadyDisabled = { disabled: true };
  input.closest.mockReturnValue({ querySelectorAll: () => [input, button, alreadyDisabled] });
  const update = controller.updateSettings({ target: input } as unknown as Event);
  await vi.waitFor(() => expect(saveLongTerm).toHaveBeenCalledOnce());
  expect(input.disabled).toBe(true); expect(status.textContent).toContain("正在保存");
  expect(button.disabled).toBe(true);
  expect(deps.save.settings.musicVolume).toBe(.18); expect(volume).toHaveBeenLastCalledWith(.37);
  finish(); await update;
  expect(deps.save.settings.musicVolume).toBe(.37); expect(input.disabled).toBe(false);
  expect(button.disabled).toBe(false); expect(alreadyDisabled.disabled).toBe(true);
  expect(status.textContent).toContain("已保存");
  saveLongTerm.mockRejectedValueOnce(new Error("storage unavailable"));
  input.valueAsNumber = .8; input.value = "0.8";
  await controller.updateSettings({ target: input } as unknown as Event);
  expect(deps.save.settings.musicVolume).toBe(.37); expect(input.value).toBe("0.37");
  expect(readout.textContent).toBe("37%"); expect(volume).toHaveBeenLastCalledWith(.37);
  expect(status.textContent).toContain("保存失败"); expect(input.disabled).toBe(false);
  saveLongTerm.mockResolvedValueOnce(); input.valueAsNumber = .2;
  await controller.updateSettings({ target: input } as unknown as Event);
  expect(deps.save.settings.musicVolume).toBe(.2);
});

it("serializes music and plugin writes without dropping either preference", async () => {
  vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
  vi.spyOn(gameAudio, "setMusicVolume").mockImplementation(() => {});
  const session = new PluginSettingsSession();
  session.register({ packageId: "neutral/plugin", title: "示例", declaration: { version: 1, fields: [{ id: "enabled", label: "开关", description: "示例", apply: "immediate", default: false, schema: { type: "boolean" } }] } });
  const deps = { save: createDefaultSave(), autosave: null, pluginSettingsSession: session, repository: { saveLongTerm: vi.fn(async () => {}) }, root: { querySelector: () => null } } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  await Promise.all([
    controller.updateSettings({ target: { dataset: { setting: "musicVolume" }, valueAsNumber: .4 } } as unknown as Event),
    controller.writePluginSettings("neutral/plugin", { enabled: true })
  ]);
  expect(deps.save.settings.musicVolume).toBe(.4);
  expect(deps.save.settings.pluginSettings?.["neutral/plugin"].values.enabled).toBe(true);
  expect(session.values("neutral/plugin").enabled).toBe(true);
});

it("applies imported music settings and restores the original level for a legacy save", async () => {
  vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
  const configure = vi.spyOn(gameAudio, "configure").mockImplementation(() => {});
  const deps = { save: createDefaultSave(), repository: { projectSnapshot: vi.fn(async () => {}) }, clearActiveMatch: vi.fn(), renderLobby: vi.fn(async () => {}) } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  const save = createDefaultSave(); save.settings.musicVolume = .71;
  await controller.applyImportedSave(save); expect(configure).toHaveBeenLastCalledWith(true, .71);
  delete save.settings.musicVolume;
  await controller.applyImportedSave(save); expect(configure).toHaveBeenLastCalledWith(true, .18);
});

function importHarness(arrayBuffer: () => Promise<ArrayBuffer>, saveLongTerm = vi.fn(async (_save: ReturnType<typeof createDefaultSave>) => {})) {
  const loading = {
    classList: { add: vi.fn(), toggle: vi.fn() }, open: false, className: "", innerHTML: "", setAttribute: vi.fn(), addEventListener: vi.fn(),
    showModal: vi.fn(() => { loading.open = true; }), close: vi.fn(() => { loading.open = false; }), remove: vi.fn()
  };
  const status = { textContent: "" }, errorCopy = { textContent: "" };
  const errorDialog = { classList: { add: vi.fn(), toggle: vi.fn() }, querySelector: () => errorCopy, showModal: vi.fn(() => { expect(loading.open).toBe(false); }) };
  const button = { disabled: false }, previouslyDisabled = { disabled: true };
  const file = { arrayBuffer: vi.fn(arrayBuffer) };
  const settings = { querySelectorAll: () => [input, button, previouslyDisabled] };
  const input = { disabled: false, value: "selected.json", files: [file], closest: () => settings, click: vi.fn() };
  const root = {
    append: vi.fn(), querySelector: (selector: string) => selector === "#save-import-error" ? errorDialog : selector === "#save-file" ? input : status
  };
  vi.stubGlobal("document", { createElement: () => loading, body: { classList: { toggle: vi.fn() } } });
  vi.spyOn(gameAudio, "configure").mockImplementation(() => {});
  const deps = { save: createDefaultSave(), repository: { saveLongTerm, projectSnapshot: async (project: (snapshot: { longTerm: unknown; runtime: null }) => { longTerm: unknown }) => { await saveLongTerm(project({ longTerm: null, runtime: null }).longTerm as ReturnType<typeof createDefaultSave>); } }, clearActiveMatch: vi.fn(), renderLobby: vi.fn(async () => {}), root } as unknown as SettingsControllerDependencies;
  return { controller: new SettingsController(deps), input, file, loading, button, previouslyDisabled, status, errorDialog, deps, event: { target: input } as unknown as Event };
}

it("keeps save-import feedback visible through reading and persistence and prevents duplicate imports", async () => {
  let finishRead!: (bytes: ArrayBuffer) => void, finishWrite!: () => void;
  const reading = new Promise<ArrayBuffer>(resolve => { finishRead = resolve; });
  const writing = new Promise<void>(resolve => { finishWrite = resolve; });
  const saveLongTerm = vi.fn(async (_save: ReturnType<typeof createDefaultSave>) => writing);
  const h = importHarness(() => reading, saveLongTerm);
  h.controller.importFile(h.event);
  expect(h.loading.open).toBe(true);
  expect(h.loading.innerHTML).toContain("导入存档");
  expect(h.input.disabled).toBe(true); expect(h.button.disabled).toBe(true);
  h.controller.importFile(h.event); h.controller.requestImport();
  expect(h.file.arrayBuffer).toHaveBeenCalledOnce(); expect(h.input.click).not.toHaveBeenCalled();
  finishRead(new TextEncoder().encode(JSON.stringify(createDefaultSave())).buffer as ArrayBuffer);
  await vi.waitFor(() => expect(saveLongTerm).toHaveBeenCalledOnce());
  expect(h.loading.open).toBe(true);
  finishWrite();
  await vi.waitFor(() => expect(h.loading.remove).toHaveBeenCalledOnce());
  expect(h.deps.renderLobby).toHaveBeenCalledOnce();
  expect(h.input.disabled).toBe(false); expect(h.button.disabled).toBe(false); expect(h.previouslyDisabled.disabled).toBe(true);
  expect(h.input.value).toBe("");
  h.controller.requestImport(); expect(h.input.click).toHaveBeenCalledOnce();
});

it("removes save-import feedback before showing the existing validation-error dialog and permits retry", async () => {
  const h = importHarness(async () => new TextEncoder().encode("not a save").buffer as ArrayBuffer);
  h.controller.importFile(h.event);
  await vi.waitFor(() => expect(h.errorDialog.showModal).toHaveBeenCalledOnce());
  expect(h.loading.remove).toHaveBeenCalledOnce();
  expect(h.input.disabled).toBe(false); expect(h.button.disabled).toBe(false); expect(h.previouslyDisabled.disabled).toBe(true);
  expect(h.input.value).toBe("");
  expect(h.status.textContent).toContain("导入失败");
  expect(h.controller.pendingImportedSave).toBe("not a save");
  expect(h.deps.repository.saveLongTerm).not.toHaveBeenCalled();
  h.controller.importFile(h.event);
  await vi.waitFor(() => expect(h.file.arrayBuffer).toHaveBeenCalledTimes(2));
});

it("saves music ordering atomically, preserves absent packages, and leaves failed writes unapplied", async () => {
  const order = vi.spyOn(gameAudio.musicDirector, "setOrder").mockImplementation(() => {});
  const save = createDefaultSave(); save.settings.musicPackageOrder = ["absent/music", "example/one"];
  const deps = { save, autosave: null, repository: { saveLongTerm: vi.fn(async () => {}) } } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  await controller.writeMusicOrder(["example/two", "example/one"]);
  expect(deps.save.settings.musicPackageOrder).toEqual(["example/two", "example/one", "absent/music"]);
  expect(order).toHaveBeenCalledWith(deps.save.settings.musicPackageOrder);
  vi.mocked(deps.repository.saveLongTerm).mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(controller.writeMusicOrder(["example/one", "example/two"])).rejects.toThrow("disk unavailable");
  expect(order).toHaveBeenCalledOnce(); expect(deps.save.settings.musicPackageOrder?.[0]).toBe("example/two");
});

it("keeps the current save owners intact when replacement fails, then retires them after commit", async () => {
  vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
  vi.spyOn(gameAudio, "configure").mockImplementation(() => {});
  const calls: string[] = [];
  const previous = createDefaultSave("2026-01-01T00:00:00.000Z");
  const next = createDefaultSave("2026-02-01T00:00:00.000Z");
  const deckQueue = { flush: async () => { calls.push("deck"); } };
  const commit = vi.fn(async (): Promise<void> => { calls.push("commit"); throw new Error("storage unavailable"); });
  const deps = { save: previous, deckQueue, repository: { projectSnapshot: commit },
    autosave: { flush: async () => { calls.push("match"); } },
    flushEncounters: async () => { calls.push("encounters"); },
    saveReplaced: vi.fn(() => { calls.push("retire"); }), clearActiveMatch: vi.fn(),
    renderLobby: vi.fn(async () => {}) } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  await expect(controller.applyImportedSave(next)).rejects.toThrow("storage unavailable");
  expect(calls).toEqual(["deck", "encounters", "match", "commit"]);
  expect(deps.save).toBe(previous);
  expect(deps.deckQueue).toBe(deckQueue);
  expect(deps.saveReplaced).not.toHaveBeenCalled();
  expect(deps.clearActiveMatch).not.toHaveBeenCalled();
  expect(deps.renderLobby).not.toHaveBeenCalled();
  commit.mockImplementationOnce(async () => { calls.push("commit"); });
  await controller.applyImportedSave(next);
  expect(calls.slice(-2)).toEqual(["commit", "retire"]);
  expect(deps.save).toBe(next);
  expect(deps.deckQueue).toBeUndefined();
  expect(deps.clearActiveMatch).toHaveBeenCalledOnce();
  expect(deps.renderLobby).toHaveBeenCalledOnce();
});


it("applies device feedback switches without writing or replacing player progress", async () => {
  const preferences = hapticPreferences.get();
  const stop = vi.spyOn(haptics, "stop").mockResolvedValue();
  const status = { textContent: "" }, save = createDefaultSave();
  const saveLongTerm = vi.fn();
  const deps = { save, repository: { saveLongTerm }, root: { querySelector: () => status } } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  try {
    await controller.updateSettings({ target: { dataset: { setting: "outputHapticsEnabled" }, checked: false } } as unknown as Event);
    expect(hapticPreferences.get()).toEqual({ enabled: preferences.enabled, output: false });
    await controller.updateSettings({ target: { dataset: { setting: "hapticsEnabled" }, checked: false } } as unknown as Event);
    expect(hapticPreferences.get()).toEqual({ enabled: false, output: false });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(saveLongTerm).not.toHaveBeenCalled(); expect(deps.save).toBe(save);
    expect(status.textContent).toContain("已应用");
  } finally { hapticPreferences.update(preferences); }
});
