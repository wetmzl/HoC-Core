import { afterEach, expect, it, vi } from "vitest";
import { SettingsController, type SettingsControllerDependencies } from "./save-settings";
import { PluginSettingsSession } from "../content/packages/plugin-settings";
import { createDefaultSave } from "../persistence/boot";
import { gameAudio } from "../audio/game-audio";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
