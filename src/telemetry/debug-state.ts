import type { PluginSettingsSession } from "../content/packages/plugin-settings";
import type { LongTermSave } from "../persistence/schema";

const DEBUG_ENGINE_PACKAGE_ID = "hoc-core/debug-engine";

/** Resolve the loaded plugin's effective toggle, including its pre-migration setting. */
export function isRuntimeDebugEnabled(
  settings: LongTermSave["settings"],
  plugins?: Pick<PluginSettingsSession, "list" | "values">
): boolean {
  if (!plugins?.list().some(entry => entry.packageId === DEBUG_ENGINE_PACKAGE_ID)) return false;
  if (!settings.pluginSettings?.[DEBUG_ENGINE_PACKAGE_ID] && settings.debugEngineEnabled === true) return true;
  return plugins.values(DEBUG_ENGINE_PACKAGE_ID, true).enabled === true;
}
