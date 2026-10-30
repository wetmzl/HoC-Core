import type { AbilityActor, CardSelector, ScalarValue, SkillCardFilter } from "./types";
import type { Suit } from "../blackjack/types";

export type DisplayActor = "owner" | "rival";
/** Stable data queries. Arithmetic and numeric queries use the ability scalar vocabulary. */
export type DisplayValue = ScalarValue
  | { readonly type: "constant"; readonly value: string | boolean }
  | { readonly type: "status-parameter"; readonly target: DisplayActor; readonly statusDefinitionId: string; readonly key: string }
  | { readonly type: "hand-card-attribute"; readonly target: DisplayActor; readonly card: CardSelector; readonly attribute: "rank" | "suit" | "source" };
export type DisplayNode =
  | { readonly type: "meter"; readonly value: DisplayValue; readonly max: DisplayValue; readonly label?: string }
  | { readonly type: "suit-record"; readonly values: Readonly<Record<Suit, DisplayValue>> }
  | { readonly type: "rank-record"; readonly target: DisplayActor; readonly statusDefinitionId: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "text-list"; readonly items: readonly { readonly text: string; readonly active: DisplayValue }[]; readonly separator?: string; readonly emptyText?: string }
  | { readonly type: "number"; readonly value: DisplayValue; readonly format?: "number" | "percent" }
  | { readonly type: "suit"; readonly value: DisplayValue }
  | { readonly type: "card"; readonly rank: DisplayValue; readonly suit: DisplayValue; readonly format?: "inline" | "compact" };
export interface SkillCardMarker {
  readonly type: string;
  readonly label: string;
  readonly appearance?: "badge" | "purple-glow";
}
export interface AbilityDisplay {
  readonly skillCardMarkers?: readonly (SkillCardMarker & { readonly targets: readonly DisplayActor[]; readonly filter?: SkillCardFilter; readonly active?: DisplayValue })[];
  readonly id: string;
  readonly target: DisplayActor;
  readonly description: string;
  readonly density?: "normal" | "compact";
  /** @deprecated Accepted only for older content; ignored by presentation. */
  readonly content: readonly DisplayNode[];
  readonly cardMarkers?: readonly { readonly targets: readonly DisplayActor[]; readonly suit: DisplayValue; readonly type: string; readonly label: string }[];
}
/** Independent match-lifetime registration; never references a live ability instance. */
export interface DisplayInstance {
  readonly level?: number;
  readonly definitionId: string;
  readonly displayId: string;
  readonly owner: AbilityActor;
  readonly target: AbilityActor;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly registeredAtSequence: number;
}
