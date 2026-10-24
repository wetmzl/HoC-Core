export { CHARACTER_CATALOG, CHARACTER_METADATA_BY_ID, DEFAULT_CHARACTER_ID, clearCharacterCatalog, getCharacterMetadata, getCharacterTags, characterHasTag, installCharacterCatalog } from "./catalog";
export { loadCharacter, loadDefaultCharacter, clearCharacterCache, installCharacterDefinitions } from "./loader";
export { defeatedCharacterIds, defeatedCharacterIdsByFirstDefeat, isCharacterUnlocked, newlyUnlockedCharacterIds, newlyUnlockedForDefeat, unlockedCharacterIdsForDefeats } from "./unlocks";
export { TABLE_ART_BASELINE } from "./types";
export { TablePortraitSchema, tablePortraitPlacement } from "./table-portrait";
export type { TablePortrait, TablePortraitImage } from "./table-portrait";
export type { CharacterBadge, CharacterAssets, CharacterData, CharacterDefinition, CharacterMetadata, CharacterPortraitScales, CharacterPortraitSurface, CharacterUnlockCondition, RevolverPlacement, Tier } from "./types";
