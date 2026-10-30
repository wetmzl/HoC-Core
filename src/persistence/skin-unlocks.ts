import { z } from "zod";
import { HocpkgResourceKeySchema } from "../content/packages/schema";
import type { CharacterAppearance } from "../content/characters";
import type { LongTermSave } from "./schema";
import type { CharacterMetadata } from "../content/characters";
import { skinUnlockConditionMet } from "../content/characters/skin-unlock";

const skinId = z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/);
/** Durable progress, keyed by package/resource identity. Only the first skin is unlocked by default. */
export const CharacterSkinUnlocksSchema = z.record(HocpkgResourceKeySchema, z.record(skinId, z.boolean()));
export type CharacterSkinUnlocks = z.infer<typeof CharacterSkinUnlocksSchema>;

/** Earned access is latched; an explicit plugin lock wins over automatic rules. */
export function grantDeclaredSkinUnlocks(save: LongTermSave, catalog: readonly CharacterMetadata[]): LongTermSave {
  let next = save;
  for (const character of catalog) {
    const appearance = character.appearance;
    if (!appearance) continue;
    for (const skin of appearance.skins.slice(1)) {
      const stored = next.characterSkinUnlocks?.[appearance.key];
      if (!skin.unlock || (stored && Object.hasOwn(stored, skin.id)) || !skinUnlockConditionMet(next, character.id, skin.unlock)) continue;
      next = { ...next, characterSkinUnlocks: { ...next.characterSkinUnlocks, [appearance.key]: { ...stored, [skin.id]: true } } };
    }
  }
  return next === save ? save : { ...next, updatedAt: new Date().toISOString() };
}

export function isCharacterSkinUnlocked(save: Pick<LongTermSave, "characterSkinUnlocks">, appearance: CharacterAppearance, id: string): boolean {
  return appearance.skins.some(skin => skin.id === id)
    && (id === appearance.skins[0].id || (Object.hasOwn(save.characterSkinUnlocks ?? {}, appearance.key)
      && Object.hasOwn(save.characterSkinUnlocks![appearance.key], id)
      && save.characterSkinUnlocks![appearance.key][id] === true));
}

export function changeCharacterSkinUnlocks(save: LongTermSave, appearance: CharacterAppearance, changes: Readonly<Record<string, boolean>> | null): LongTermSave {
  if (changes !== null) {
    CharacterSkinUnlocksSchema.parse({ [appearance.key]: changes });
    for (const [id, unlocked] of Object.entries(changes)) {
      if (!appearance.skins.some(skin => skin.id === id)) throw new Error("所选服装不可用。");
      if (!unlocked && id === appearance.skins[0].id) throw new Error("初始服装始终解锁。");
      if (!unlocked && id === appearance.skinId) throw new Error("请先切换到其他服装，再锁定当前服装。");
    }
  }
  if (changes === null && appearance.skinId !== appearance.skins[0].id) throw new Error("请先切换到初始服装，再重置解锁状态。");
  const all = { ...save.characterSkinUnlocks };
  if (changes === null) delete all[appearance.key];
  else all[appearance.key] = { ...all[appearance.key], ...changes };
  if (JSON.stringify(all) === JSON.stringify(save.characterSkinUnlocks ?? {})) return save;
  return { ...save, characterSkinUnlocks: all, updatedAt: new Date().toISOString() };
}
