import { existsSync, readFileSync } from "node:fs";
import type { CharacterData } from "../content/characters/types";
import { CharacterDataSchema } from "../content/characters/schema";
import { CharacterPresentationSchema, resolvePresentation } from "../content/packages/character-presentation";

export type CharacterFixture = CharacterData;

/** Test projections read authored defaults through the same skin resolver as runtime content. */
export function readCharacterResourceFixture(id: string, entry: string) {
  const root = new URL(`../../public/characters/${id}/`, import.meta.url);
  const read = (file: string) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
  const manifest = read("hocpkg-info.json");
  const descriptor = manifest.resources.find((resource: { type: string }) => resource.type === "presentation.character");
  return descriptor ? resolvePresentation(read(entry), CharacterPresentationSchema.parse(read(descriptor.entry))) as ReturnType<typeof JSON.parse> : read(entry);
}

export function readCharacterFixture(id: string): CharacterFixture {
  const resource = readCharacterResourceFixture(id, "resources/character-match.json") as { definition: Record<string, unknown>; aiSkills: readonly { resourceId: string; enabled: boolean; parameters: Record<string, unknown> }[] };
  const resolveMedia = (value: unknown): unknown => {
    if (typeof value === "string" && /\.(?:png|webp|jpe?g)$/i.test(value)) return `/characters/${id}/${value}`;
    if (Array.isArray(value)) return value.map(resolveMedia);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveMedia(entry)]));
  };
  return CharacterDataSchema.parse({
    ...resolveMedia(resource.definition) as Record<string, unknown>,
    dialogue: resolveMedia(readCharacterResourceFixture(id, "resources/dialogue.json")),
    aiSkills: resource.aiSkills.map(({ resourceId, ...binding }) => ({ ...binding, definitionId: resourceId.slice("ai:".length) }))
  }) as CharacterFixture;
}

export function publicResourceExists(url: string): boolean {
  return url.startsWith("/") && existsSync(new URL(`../../public${url}`, import.meta.url));
}
