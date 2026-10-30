import { afterEach, expect, it, vi } from "vitest";
import { SettingsController, type SettingsControllerDependencies } from "./save-settings";
import { PluginSettingsSession } from "../content/packages/plugin-settings";
import { createDefaultSave } from "../persistence/boot";
import { gameAudio } from "../audio/game-audio";
import { changeCharacterSkinUnlocks } from "../persistence/skin-unlocks";

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
  const deps = { save: createDefaultSave(), repository: { saveLongTerm: vi.fn(async () => {}) }, renderLobby: vi.fn(async () => {}) } as unknown as SettingsControllerDependencies;
  const controller = new SettingsController(deps);
  const save = createDefaultSave(); save.settings.musicVolume = .71;
  await controller.applyImportedSave(save); expect(configure).toHaveBeenLastCalledWith(true, .71);
  delete save.settings.musicVolume;
  await controller.applyImportedSave(save); expect(configure).toHaveBeenLastCalledWith(true, .18);
});
