import type { AbilityActor, CardSelector, ScalarValue } from "./types";

export type DisplayActor = "owner" | "rival";
/** Stable data queries. Arithmetic and numeric queries use the ability scalar vocabulary. */
export type DisplayValue = ScalarValue
  | { readonly type: "constant"; readonly value: string | boolean }
  | { readonly type: "status-parameter"; readonly target: DisplayActor; readonly statusDefinitionId: string; readonly key: string }
  | { readonly type: "hand-card-attribute"; readonly target: DisplayActor; readonly card: CardSelector; readonly attribute: "rank" | "suit" | "source" };
export type DisplayNode =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "number"; readonly value: DisplayValue; readonly format?: "number" | "percent" }
  | { readonly type: "suit"; readonly value: DisplayValue }
  | { readonly type: "card"; readonly rank: DisplayValue; readonly suit: DisplayValue; readonly format?: "inline" | "compact" };
export interface AbilityDisplay {
  readonly id: string;
  readonly target: DisplayActor;
  readonly description: string;
  readonly content: readonly DisplayNode[];
  readonly cardMarkers?: readonly { readonly targets: readonly DisplayActor[]; readonly suit: DisplayValue; readonly type: string; readonly label: string }[];
}
/** Independent match-lifetime registration; never references a live ability instance. */
export interface DisplayInstance {
  readonly definitionId: string;
  readonly displayId: string;
  readonly owner: AbilityActor;
  readonly target: AbilityActor;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly registeredAtSequence: number;
}
