/** Public contracts consumed by separately built content plugins. */
export type { PluginStoryApi, StoryPlaybackResult } from "./runtime/story-host";
export type { StoryDirectorState } from "./runtime/story-director";
export type { CharacterPresentation, PresentationContext, PresentationReference } from "./content/packages/character-presentation";
export type { PluginDialoguePresentation } from "./content/packages/plugin-contracts";
export type { PluginCharacterSkinUnlocksApi, PluginCharacterSkinUnlockState } from "./content/packages/plugin-contracts";
export type { CharacterSkinUnlocks } from "./persistence/skin-unlocks";
export type { SkinUnlockCondition } from "./content/characters/skin-unlock";
export type { PluginCharacterPresentationApi, PluginMatchEvents, PluginSkillSelection, PluginHostApi, PluginModule, PluginRegistration, PluginRuntimeContext, PluginRuntimeContribution } from "./content/packages/plugin-contracts";
export type { HocpkgManifest } from "./content/packages/schema";
export type { ExtensionResource, HocpkgResourceHandler, ResourceHandlerContext, CharacterMatchResource } from "./content/packages/resources";
export type { CharacterAppearance, CharacterDefinition, CharacterMetadata } from "./content/characters";
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
export type { PluginGameEventsApi } from "./content/packages/plugin-contracts";
export { PUBLIC_EVENT_API_VERSION, PUBLIC_EVENT_SCOPE_NAMES, snapshotPublicEventBatch } from "./core/events/public-events";
export { PUBLIC_EVENT_CATALOG, MATCH_EVENT_TYPES, getPublicEventDeclaration } from "./core/events/public-event-catalog";
export type { PublicEventDeclaration } from "./core/events/public-event-catalog";
export type { PublicEvent, PublicEventBatch, PublicEventContext, PublicEventOrigin, PublicEventScopes, PublicEventScopeName, PublicPresentationContext, PublicScalar, PublicMatchReadModel, PublicSkillLifetime } from "./core/events/public-events";
export type { PublicEventSubscription } from "./runtime/public-event-hub";
export type { FactDeliveryStage } from "./runtime/fact-dispatcher";
export { PublicQuerySchema, readPublicQuery, createPublicQueryContext } from "./core/events/public-queries";
export type { PublicQuery, PublicQueryContext } from "./core/events/public-queries";
export { PublicValueSchema, PublicConditionSchema, PublicTriggerSpecSchema, evaluatePublicCondition, matchPublicTrigger, selectPublicTriggerEvents } from "./core/events/triggers";
export type { PublicValue, PublicCondition, TriggerSpec, PublicTriggerSpec } from "./core/events/triggers";
export type { PluginTutorialApi, PluginTutorialDefinition, PluginTutorialPage, PluginTutorialResource, PluginTutorialImageResource, PluginTutorialShowOptions } from "./content/packages/plugin-tutorials";
export type { PluginCreditsDeclaration } from "./content/packages/plugin-declarations";
export type { AbilityBinding, AbilityLevel } from "./core/abilities/types";

export type { PluginMainMenuQuote, PluginUiSlot, PluginUiAction, PluginUiPageContext } from "./content/packages/plugin-ui";
export { createDetentDrawer } from "./presentation/detent-drawer";
export type { DetentDrawerOptions } from "./presentation/detent-drawer";

export { MUSIC_PRIORITIES } from "./audio/music-contracts";
export type { MusicPriority, PluginMusicPriority, MusicScene, MusicRequest, MusicContext, PluginMusicApi, MusicStatus } from "./audio/music-contracts";
export { STORY_API_VERSION, StoryExtensions, validateStorySceneCapabilities } from "./core/story";
export type { StoryScene, StoryBinding, StoryRun, StoryAction, StoryScalar, StoryCommandIntent, StoryCommandReceipt, StoryActionExtension, StoryCommandExtension, StoryExtensionRegistry, StoryExtensionContext } from "./core/story";
