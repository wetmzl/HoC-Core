import { ABILITY_CATALOG_VERSION } from "./core/abilities/registry";
import { SUPPORTED_PLUGIN_MODULE_API_VERSIONS } from "./content/packages/plugin-version";
import { createHocpkgResourceHandlers } from "./content/packages/resources";

/** Build-time compatibility data. Package versions remain independent of resource APIs. */
export const capabilities = Object.freeze({
  abilityCatalogVersion: ABILITY_CATALOG_VERSION,
  pluginModuleApiVersions: [...SUPPORTED_PLUGIN_MODULE_API_VERSIONS],
  resourceApiVersions: Object.fromEntries(createHocpkgResourceHandlers().map(handler => [handler.type, [...handler.apiVersions]])),
  authoringApiVersion: 1,
  maxInputMiB: 512
});
