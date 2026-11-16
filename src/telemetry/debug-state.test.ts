import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PluginSettingsDeclarationSchema, type PluginSettingsData } from "../content/packages/plugin-declarations";
import { PluginSettingsSession } from "../content/packages/plugin-settings";
import { createDefaultSave } from "../persistence/boot";
import { isRuntimeDebugEnabled } from "./debug-state";

const packageId = "hoc-core/debug-engine";
const resource = JSON.parse(readFileSync(new URL("../../public/characters/debug-engine/resources.json", import.meta.url), "utf8"));
const declaration = PluginSettingsDeclarationSchema.parse(resource.settings);
const registration = { packageId, title: "官方调试引擎", declaration };

function settings(stored?: PluginSettingsData[string], legacy?: boolean) {
  return {
    ...createDefaultSave().settings,
    ...(stored ? { pluginSettings: { [packageId]: stored } } : {}),
    ...(legacy !== undefined ? { debugEngineEnabled: legacy } : {})
  };
}

describe("effective runtime debug telemetry state", () => {
  it.each<{ name: string; stored?: PluginSettingsData[string]; legacy?: boolean; expected: boolean }>([
    { name: "default off", stored: undefined, legacy: undefined, expected: false },
    { name: "pre-migration legacy toggle", stored: undefined, legacy: true, expected: true },
    { name: "disabled legacy toggle", stored: undefined, legacy: false, expected: false },
    { name: "current enabled setting", stored: { version: declaration.version, values: { enabled: true } }, legacy: false, expected: true },
    { name: "explicit off supersedes legacy on", stored: { version: declaration.version, values: { enabled: false } }, legacy: true, expected: false },
    { name: "missing field uses declaration default", stored: { version: declaration.version, values: {} }, legacy: true, expected: false },
    { name: "incompatible version uses declaration default", stored: { version: declaration.version + 1, values: { enabled: true } }, legacy: true, expected: false },
    { name: "incompatible value uses declaration default", stored: { version: declaration.version, values: { enabled: "true" } }, legacy: true, expected: false }
  ])("$name", ({ stored, legacy, expected }) => {
    const saveSettings = settings(stored, legacy);
    const plugins = new PluginSettingsSession(saveSettings.pluginSettings);
    plugins.register(registration);

    expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(expected);
  });

  it("does not infer a loaded debug plugin from retained current or legacy settings", () => {
    const saveSettings = settings({ version: declaration.version, values: { enabled: true } }, true);
    const plugins = new PluginSettingsSession(saveSettings.pluginSettings);
    plugins.register({ ...registration, packageId: "example/other-plugin" });

    expect(isRuntimeDebugEnabled(saveSettings)).toBe(false);
    expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(false);
    expect(isRuntimeDebugEnabled(settings(undefined, true), plugins)).toBe(false);
  });

  it("stops marking new matches when the plugin is unloaded without deleting its stored toggle", () => {
    const saveSettings = settings({ version: declaration.version, values: { enabled: true } });
    const plugins = new PluginSettingsSession(saveSettings.pluginSettings);
    const unregister = plugins.register(registration);
    expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(true);

    unregister();
    expect(saveSettings.pluginSettings?.[packageId].values.enabled).toBe(true);
    expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(false);

    plugins.register(registration);
    expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(true);
  });

  it("tracks immediate runtime setting changes and stops falling back after legacy migration", () => {
    const saveSettings = settings(undefined, true);
    const plugins = new PluginSettingsSession();
    plugins.register(registration);
    expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(true);

    for (const enabled of [true, false, true]) {
      saveSettings.pluginSettings = plugins.updated(saveSettings.pluginSettings ?? {}, packageId, { enabled });
      plugins.sync(saveSettings.pluginSettings);
      expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(enabled);
    }
  });

  it("reads the effective runtime value instead of duplicating persisted field validation", () => {
    const saveSettings = settings({ version: declaration.version, values: { enabled: true } });
    const plugins = new PluginSettingsSession({ [packageId]: { version: declaration.version, values: { enabled: false } } });
    plugins.register(registration);

    expect(isRuntimeDebugEnabled(saveSettings, plugins)).toBe(false);
  });
});
