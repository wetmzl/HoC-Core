/** Public contracts consumed by separately built content plugins. */
export type { PluginDialoguePresentation } from "./content/packages/plugin-contracts";
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
export type { PluginSettingsApi, PluginSettingsDeclaration, PluginSettingField, PluginSettingValue, PluginCharacterExtensionDeclaration } from "./content/packages/plugin-declarations";
export { assertAuthoringValue, validateAuthoringValue } from "./content/packages/authoring-schema";
export type { AuthoringSchema, AuthoringContext, AuthoringIssue } from "./content/packages/authoring-schema";

export type { DialoguePrimitive, DialoguePrimitiveDeclaration, DialoguePrimitiveContext, DialogueDependency, DialogueScalar } from "./dialogue/types";

export type { CharacterInteraction, DialogueSourceContext } from "./content/packages/plugin-contracts";
export type { DialogueEvent, DialogueEventDeclaration } from "./dialogue/types";

export type { PluginGameRuntimeContext } from "./content/packages/plugin-contracts";
export type { PluginTutorialApi, PluginTutorialDefinition, PluginTutorialPage, PluginTutorialResource, PluginTutorialImageResource, PluginTutorialShowOptions } from "./content/packages/plugin-tutorials";
export type { PluginCreditsDeclaration } from "./content/packages/plugin-declarations";
export type { AbilityBinding } from "./core/abilities/types";

export type { PluginUiSlot, PluginUiAction, PluginUiPageContext } from "./content/packages/plugin-ui";
export { createDetentDrawer } from "./presentation/detent-drawer";
export type { DetentDrawerOptions } from "./presentation/detent-drawer";
