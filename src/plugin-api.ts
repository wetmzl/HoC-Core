/** Public contracts consumed by separately built content plugins. */
export type { PluginMatchEvents, PluginSkillSelection, PluginHostApi, PluginModule, PluginRegistration, PluginRuntimeContext, PluginRuntimeContribution } from "./content/packages/plugin-contracts";
export type { HocpkgManifest } from "./content/packages/schema";
export type { ExtensionResource, HocpkgResourceHandler, ResourceHandlerContext, CharacterMatchResource } from "./content/packages/resources";
export type { CharacterDefinition, CharacterMetadata } from "./content/characters";
export type { PluginAudio, PluginSound, PluginSoundOptions, PluginSoundFactory } from "./audio/plugin-audio";
export type { HapticsApi, HapticOptions } from "./presentation/haptic-service";
export type { MatchHistoryRecord } from "./core/match/history";
export type { LongTermSave } from "./persistence/schema";
export type { ResourceLoader } from "./resources/resource-loader";
export type { MountedScreen } from "./runtime/contracts";
export { SKILL_TAGS, type SkillTag } from "./core/skills/types";
