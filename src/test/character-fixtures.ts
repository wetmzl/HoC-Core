import { existsSync, readFileSync } from "node:fs";
import type { CharacterData } from "../content/characters/types";
import { CharacterDataSchema } from "../content/characters/schema";

export type CharacterFixture = CharacterData;

export function readCharacterFixture(id: string): CharacterFixture {
  const path = new URL(`../../public/characters/${id}/resources/character-match.json`, import.meta.url);
  const resource = JSON.parse(readFileSync(path, "utf8")) as { definition: Record<string, unknown>; aiSkills: readonly { resourceId: string; enabled: boolean; parameters: Record<string, unknown> }[] };
  const resolveMedia = (value: unknown): unknown => {
    if (typeof value === "string" && /\.(?:png|webp|jpe?g)$/i.test(value)) return `/characters/${id}/${value}`;
    if (Array.isArray(value)) return value.map(resolveMedia);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveMedia(entry)]));
  };
  return CharacterDataSchema.parse({
    ...resolveMedia(resource.definition) as Record<string, unknown>,
    aiSkills: resource.aiSkills.map(({ resourceId, ...binding }) => ({ ...binding, definitionId: resourceId.slice("ai:".length) }))
  }) as CharacterFixture;
}

export function publicResourceExists(url: string): boolean {
  return url.startsWith("/") && existsSync(new URL(`../../public${url}`, import.meta.url));
}
