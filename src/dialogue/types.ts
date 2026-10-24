import type { MatchState } from "../core/match/types";
import type { AuthoringSchema } from "../content/packages/authoring-schema";

export type DialogueScalar = string | number | boolean | null;
export type DialogueDependency = "phase" | "round" | "history" | "hands" | "roulette" | "abilities" | "match" | "event";
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export interface DialoguePrimitiveContext {
  readonly state: DeepReadonly<MatchState>;
  readonly event?: DialogueEvent;
  readonly characterId?: string;
  readonly presentation?: Readonly<Record<string, unknown>>;
  /** Non-committing preview, present only in a pending trigger window. */
  readonly pendingTrigger?: { readonly actor: "player" | "opponent"; readonly probability: number; readonly baseProbability: number; readonly cancelled: boolean };
}
export interface DialoguePrimitiveDeclaration {
  readonly id: string;
  readonly apiVersion: number;
  readonly title: string;
  readonly description: string;
  readonly returnType: "string" | "number" | "boolean";
  readonly parameters: AuthoringSchema;
  readonly dependencies: readonly DialogueDependency[];
}
export interface DialoguePrimitive extends DialoguePrimitiveDeclaration {
  /** undefined means unavailable; null is an available scalar (e.g. no winner). */
  read(context: DialoguePrimitiveContext, args: Readonly<Record<string, unknown>>): DialogueScalar | undefined;
}
export type DialogueTest = { readonly eq: DialogueScalar } | { readonly range: { readonly min?: number; readonly max?: number; readonly minInclusive?: boolean; readonly maxInclusive?: boolean } };
export interface DialogueAtom { readonly primitive: string; readonly apiVersion: number; readonly args: Readonly<Record<string, unknown>>; readonly test: DialogueTest }
export type DialogueCondition = DialogueAtom | { readonly all: readonly DialogueCondition[] } | { readonly any: readonly DialogueCondition[] } | { readonly not: DialogueCondition };
export interface DialogueEvent {
  readonly id: string; readonly type: string; readonly apiVersion: number; readonly data: Readonly<Record<string, unknown>>;
}
export interface DialogueEventDeclaration {
  readonly id: string; readonly apiVersion: number; readonly title: string; readonly description: string; readonly data: AuthoringSchema;
}
export type DialogueAnchor = "dialogue-event" | "round-start" | "last-action" | "last-player-action" | "last-opponent-action" | "round-result" | "round-acknowledged" | "trigger-result";
export interface DialoguePortrait {
  readonly image: string;
  readonly alt?: string;
  readonly scale?: number;
  readonly revolverPlacement?: { readonly top: number; readonly left: number };
}
export interface DialogueRule {
  readonly id: string;
  readonly on: readonly { readonly type: string; readonly apiVersion: number }[];
  readonly when: DialogueCondition;
  readonly poolId: string;
  readonly anchor?: DialogueAnchor;
  readonly portrait?: DialoguePortrait;
}
export type DialoguePoolExtensions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export interface CharacterDialogue {
  readonly pools: Readonly<Record<string, readonly string[]>>;
  readonly rules: readonly DialogueRule[];
  readonly fallbackPoolId: string;
  /** Opaque, package-qualified data from authored pool objects; ignored by the engine. */
  readonly poolExtensions?: Readonly<Record<string, DialoguePoolExtensions>>;
}
export interface DialogueDiagnostic { readonly characterId: string; readonly ruleId: string; readonly primitive?: string; readonly reason: string }
export interface DialogueSelection { readonly ruleId: string | null; readonly poolId: string; readonly key: string; readonly line: string; readonly portrait?: DialoguePortrait }
