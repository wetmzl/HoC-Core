import type { HocpkgManifest } from "./schema";
export const PLUGIN_MODULE_API_VERSION = 2;
export function pluginCompatibilityError(manifest: HocpkgManifest): string | undefined {
  const incompatible = manifest.resources.find((resource) => resource.type === "plugin.module" && resource.apiVersion !== PLUGIN_MODULE_API_VERSION);
  return incompatible ? `插件接口版本不兼容：需要 API ${PLUGIN_MODULE_API_VERSION}，此包使用 API ${incompatible.apiVersion}。请导入新版插件。` : undefined;
}
