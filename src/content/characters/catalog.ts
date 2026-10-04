import type { CharacterMetadata } from "./types";
import { CharacterCatalogSchema } from "./schema";

export let DEFAULT_CHARACTER_ID = "chatgpt";

function createCatalog(entries: readonly CharacterMetadata[]): readonly CharacterMetadata[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`角色目录 ID 重复：${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    tags: Object.freeze([...entry.tags]),
    unlock: entry.unlock ? Object.freeze({ ...entry.unlock }) : undefined,
    portraitScales: Object.freeze({ ...entry.portraitScales })
  })));
}

export let CHARACTER_CATALOG = createCatalog([]);

export let CHARACTER_METADATA_BY_ID: Readonly<Record<string, CharacterMetadata>> = Object.freeze(
  Object.fromEntries(CHARACTER_CATALOG.map((metadata) => [metadata.id, metadata]))
);

export function installCharacterCatalog(entries: readonly CharacterMetadata[], defaultCharacterId: string): void {
  const parsed = CharacterCatalogSchema.parse({ defaultCharacterId, characters: entries });
  const catalog = createCatalog(parsed.characters);
  const byId: Readonly<Record<string, CharacterMetadata>> = Object.freeze(Object.fromEntries(catalog.map((metadata) => [metadata.id, metadata])));
  if (!byId[defaultCharacterId]) throw new Error(`默认角色未注册：${defaultCharacterId}`);
  if (byId[defaultCharacterId]?.unlock) throw new Error(`默认角色必须初始解锁：${defaultCharacterId}`);
  CHARACTER_CATALOG = catalog;
  CHARACTER_METADATA_BY_ID = byId;
  DEFAULT_CHARACTER_ID = defaultCharacterId;
}

export function clearCharacterCatalog(): void {
  CHARACTER_CATALOG = createCatalog([]);
  CHARACTER_METADATA_BY_ID = Object.freeze({});
  DEFAULT_CHARACTER_ID = "chatgpt";
}

export function getCharacterMetadata(id: string): CharacterMetadata | undefined {
  return CHARACTER_METADATA_BY_ID[id];
}

/** Returns custom tags plus a namespaced, lower-case tier tag. */
export function getCharacterTags(character: Pick<CharacterMetadata, "tier" | "tags">): readonly string[] {
  return Object.freeze([...new Set([`tier:${character.tier.toLowerCase()}`, ...character.tags])]);
}

export function characterHasTag(character: Pick<CharacterMetadata, "tier" | "tags">, tag: string): boolean {
  return getCharacterTags(character).includes(tag.toLowerCase());
}
