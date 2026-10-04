import { DEFAULT_CHARACTER_ID, getCharacterMetadata } from "./catalog";
import type { CharacterDefinition } from "./types";

let installedDefinitions: Readonly<Record<string, CharacterDefinition>> | undefined;
let installedPromises: Readonly<Record<string, Promise<CharacterDefinition>>> = Object.freeze({});

export function installCharacterDefinitions(definitions: readonly CharacterDefinition[]): void {
  if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) throw new Error("角色定义 ID 重复");
  installedDefinitions = Object.freeze(Object.fromEntries(definitions.map((definition) => [definition.id, Object.freeze(definition)])));
  installedPromises = Object.freeze(Object.fromEntries(Object.entries(installedDefinitions).map(([id, definition]) => [id, Promise.resolve(definition)])));
}

export function clearCharacterDefinitions(): void {
  installedDefinitions = undefined;
  installedPromises = Object.freeze({});
}

export function loadCharacter(id: string): Promise<CharacterDefinition> {
  const metadata = getCharacterMetadata(id);
  if (!metadata) {
    return Promise.reject(new Error(`未知角色：${id}`));
  }
  if (!installedDefinitions?.[id]) return Promise.reject(new Error(`角色包尚未安装：${id}`));
  return installedPromises[id]!;
}

export function loadDefaultCharacter(): Promise<CharacterDefinition> {
  return loadCharacter(DEFAULT_CHARACTER_ID);
}

export function clearCharacterCache(): void {
  // Package definitions are immutable for the lifetime of one app boot.
}

export { DEFAULT_CHARACTER_ID };
