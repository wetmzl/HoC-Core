import { SKILL_TAGS, type SkillTag } from "../core/skills/types";

export type SkillArchetypeArt = Partial<Record<SkillTag, { readonly default?: string; readonly selected?: string }>>;

export function mergeSkillArchetypeArt(layers: readonly SkillArchetypeArt[]): SkillArchetypeArt {
  const result: SkillArchetypeArt = {};
  for (const layer of layers) for (const tag of SKILL_TAGS) if (layer[tag]) result[tag] = { ...result[tag], ...layer[tag] };
  return result;
}

export function skillArchetypeArtUrls(art: SkillArchetypeArt): readonly string[] {
  return [...new Set(SKILL_TAGS.flatMap((tag) => [art[tag]?.default, art[tag]?.selected]).filter((url): url is string => Boolean(url)))];
}
