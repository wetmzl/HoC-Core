import type { HocpkgManifest } from "./schema";
export const PLUGIN_MODULE_API_VERSION = 2;
export const PLUGIN_DECLARATIONS_API_VERSION = 3;
export const PLUGIN_DIALOGUE_API_VERSION = 4;
export const PLUGIN_EVENTS_API_VERSION = 5;
export const PLUGIN_RUNTIME_API_VERSION = 6;
export const PLUGIN_CREDITS_API_VERSION = 7;
export const PLUGIN_UI_API_VERSION = 8;
export const PLUGIN_DIALOGUE_PRESENTATION_API_VERSION = 9;
export const PLUGIN_TUTORIAL_API_VERSION = 10;
export const SUPPORTED_PLUGIN_MODULE_API_VERSIONS = [PLUGIN_MODULE_API_VERSION, PLUGIN_DECLARATIONS_API_VERSION, PLUGIN_DIALOGUE_API_VERSION, PLUGIN_EVENTS_API_VERSION, PLUGIN_RUNTIME_API_VERSION, PLUGIN_CREDITS_API_VERSION, PLUGIN_UI_API_VERSION, PLUGIN_DIALOGUE_PRESENTATION_API_VERSION, PLUGIN_TUTORIAL_API_VERSION] as const;
export function pluginCompatibilityError(manifest: HocpkgManifest): string | undefined {
  const incompatible = manifest.resources.find((resource) => resource.type === "plugin.module" && !SUPPORTED_PLUGIN_MODULE_API_VERSIONS.some(version => version === resource.apiVersion));
  return incompatible ? `插件接口版本不兼容：需要 API 2、3、4、5、6、7、8、9 或 10，此包使用 API ${incompatible.apiVersion}。请导入新版插件。` : undefined;
}
