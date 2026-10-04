import type { AiProfile } from "../../core/ai/types";
import type { CharacterDialogue } from "../../dialogue/types";
import type { AbilityBinding } from "../../core/abilities/types";

export type Tier = "D" | "C" | "B" | "A" | "S" | "SS";

/** Data-driven prerequisites for inviting an attendee to the table. */
export type CharacterUnlockCondition =
  | { readonly type: "defeat-any" }
  | { readonly type: "defeat-count"; readonly count: number }
  | { readonly type: "defeat-any-tag"; readonly tag: string }
  | { readonly type: "defeat-character"; readonly characterId: string }
  | { readonly type: "defeat-tag-percentage"; readonly tag: string; readonly percentage: number };

export type CharacterPortraitSurface = "selection" | "table";

/** Presentation-only scales shared by every UI surface that renders attendee portrait art. */
export type CharacterPortraitScales = Readonly<Record<CharacterPortraitSurface, number>>;

/** Lightweight attendee data used to build the castle lobby and collection-history index. */
export interface CharacterMetadata {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly tier: Tier;
  /** Custom discovery tags. The tier itself is also queryable as `tier:s`, `tier:a`, etc. */
  readonly tags: readonly string[];
  readonly unlock?: CharacterUnlockCondition;
  readonly previewImage: string;
  readonly portraitScales: CharacterPortraitScales;
}

export interface CharacterAssets {
  /** Opaque 512x512 character-package cover reserved for the lobby UI. */
  readonly cover: string;
  readonly relaxed: string;
  readonly conflicted: string;
  readonly mocking: string;
  readonly threatened: string;
  readonly unconscious: string;
  readonly defeatedSummary?: string;
}

/** 左轮图层可见内容（枪口一侧）左上角距受罚与会者立绘可见区域左上角的距离；单位为立绘实体高 149.333px 时的 CSS 像素，渲染时按实际立绘尺寸成比例换算。 */
export interface RevolverPlacement {
  readonly top: number;
  readonly left: number;
}

export interface CharacterProfile {
  readonly description: string;
}

export interface CharacterMatchSummary {
  readonly playerVictory: string;
  readonly playerDefeat: string;
  readonly escaped: string;
}

/** Table art baseline: 1536×1024 canvas and scale 1 seated composition. */
export const TABLE_ART_BASELINE = Object.freeze({
  referenceCanvas: Object.freeze({ width: 1536, height: 1024 }),
  normalSittingScale: 1,
  composition: "horizontal-seated"
});

/** Full attendee definition. Load this only when a match needs AI, dialogue, or table art. */
export interface CharacterData {
  readonly assets: CharacterAssets;
  readonly profile: CharacterProfile;
  readonly matchSummary: CharacterMatchSummary;
  readonly revolverPlacement: RevolverPlacement;
  readonly ai: AiProfile;
  readonly aiSkills: readonly AbilityBinding[];
  readonly dialogue: CharacterDialogue;
}

export interface CharacterDefinition extends CharacterMetadata, CharacterData {}
