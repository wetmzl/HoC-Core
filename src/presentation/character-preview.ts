import type { CharacterMetadata } from "../content/characters/types";

/** Shared by portrait crops and narrow locked-opponent previews. */
export function characterPreviewStyle(character: Pick<CharacterMetadata, "previewFocus">): string {
  const focus = character.previewFocus;
  return focus ? `--character-preview-x:${focus.x * 100}%;--character-preview-y:${focus.y * 100}%;` : "";
}
