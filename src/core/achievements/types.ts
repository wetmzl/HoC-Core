import type { BinaryArithmeticExpression, UnaryArithmeticExpression } from "../expressions/arithmetic";
import type { ComparisonOperator } from "../expressions/comparison";
import type { SkillCardFilter } from "../abilities/types";
import type { SkillCardFilterSubject } from "../abilities/skill-card-selection";

export const ACHIEVEMENT_API_VERSION = 1 as const;
export const ACHIEVEMENT_LEDGER_VERSION = 1 as const;
export type AchievementScalarValue = string | number | boolean | null;
export type AchievementScalarType = "string" | "number" | "boolean" | "null";
export type AchievementScope = "profile" | "run" | "match" | "round";
export type AchievementWindowScope = Exclude<AchievementScope, "profile">;
export interface AchievementTopic { readonly type: string; readonly apiVersion: number }

/** Stable semantic names are supplied by an observation provider, not raw history paths. */
export type AchievementNumber = number | BinaryArithmeticExpression<AchievementNumber> | UnaryArithmeticExpression<AchievementNumber>
  | { readonly type: "constant"; readonly value: number }
  | { readonly type: "observation"; readonly key: string }
  | { readonly type: "metric"; readonly id: string }
  | { readonly type: "skill-card-count"; readonly collection: string; readonly filter?: SkillCardFilter };
export type AchievementValue =
  | { readonly type: "literal"; readonly value: AchievementScalarValue }
  | { readonly type: "numeric"; readonly value: AchievementNumber }
  | { readonly type: "observation"; readonly key: string };
export type AchievementCondition =
  | { readonly type: "all" | "any"; readonly conditions: readonly AchievementCondition[] }
  | { readonly type: "not"; readonly condition: AchievementCondition }
  | { readonly type: "scalar-compare"; readonly left: AchievementNumber; readonly operator: ComparisonOperator; readonly right: AchievementNumber }
  | { readonly type: "value-compare"; readonly left: AchievementValue; readonly operator: "eq" | "neq"; readonly right: AchievementValue }
  | { readonly type: "available"; readonly key: string }
  | { readonly type: "topic-is"; readonly topic: AchievementTopic };
export type AchievementAggregation =
  | { readonly type: "count" }
  | { readonly type: "sum" | "max"; readonly value: AchievementNumber }
  | { readonly type: "distinct"; readonly value: AchievementValue; readonly limit: number };
export interface AchievementTrack {
  readonly id: string;
  /** Omitted means every supported observation while this window is active. */
  readonly on?: readonly AchievementTopic[];
  readonly when?: AchievementCondition;
  readonly progress: AchievementAggregation;
}
export interface AchievementTracking {
  readonly scope: AchievementScope;
  readonly completion: "immediate" | "scope-end";
  /** Cumulative profile totals may resume across disabled intervals; continuous attempts may not. */
  readonly continuity: "continuous" | "cumulative";
  readonly allowDebug: boolean;
  readonly tracks: readonly AchievementTrack[];
  readonly completeWhen: AchievementCondition;
  readonly resetWhen?: AchievementCondition;
  readonly invalidateWhen?: AchievementCondition;
}
export interface AchievementDefinition {
  readonly id: string;
  /** New tracking semantics require a new revision; completed identities remain completed. */
  readonly revision: number;
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  /** Standard authoring requires a cover; legacy API 1 definitions may omit it. */
  readonly cover?: string;
  readonly icon?: string;
  readonly hidden?: boolean;
  /** A view hint only; completion always uses tracking.completeWhen. */
  readonly progressDisplay?: { readonly metric: string; readonly target: number };
  readonly tracking: AchievementTracking;
}
export interface AchievementCatalog { readonly achievements: readonly AchievementDefinition[] }
export interface StandardAchievementDefinition extends AchievementDefinition { readonly cover: string }
export interface StandardAchievementCatalog extends AchievementCatalog { readonly achievements: readonly StandardAchievementDefinition[] }
export interface AchievementDefinitionEntry { readonly key: string; readonly definition: AchievementDefinition }

/** Provider declarations let authoring tools detect misspelled names and incompatible types. */
export interface AchievementObservationContract {
  readonly topic: AchievementTopic;
  readonly values: Readonly<Record<string, AchievementScalarType | readonly AchievementScalarType[]>>;
  readonly skillCollections: readonly string[];
}
export type AchievementBoundary =
  | { readonly scope: AchievementWindowScope; readonly phase: "begin" }
  | { readonly scope: AchievementWindowScope; readonly phase: "end"; readonly reason: "completed" | "abandoned" | "aborted" };
export interface AchievementObservation {
  readonly apiVersion: typeof ACHIEVEMENT_API_VERSION;
  /** One durable stream per profile; never reset this counter on a new match. */
  readonly streamId: string;
  readonly sequence: number;
  readonly at: string;
  readonly topic: AchievementTopic;
  readonly scopes: Readonly<Partial<Record<AchievementWindowScope, string>>>;
  readonly boundary?: AchievementBoundary;
  readonly debugUsed: boolean;
  readonly values: Readonly<Record<string, AchievementScalarValue>>;
  /** Entities/definition metadata captured by the provider, including already removed cards. */
  readonly skillCards: Readonly<Record<string, readonly SkillCardFilterSubject[]>>;
}
export type AchievementMetric =
  | { readonly type: "count" | "sum"; readonly value: number }
  | { readonly type: "max"; readonly value: number | null }
  | { readonly type: "distinct"; readonly values: readonly AchievementScalarValue[] };
export interface AchievementCompletion {
  readonly at: string;
  readonly sequence: number;
  readonly revision: number;
}
export interface AchievementRecord {
  readonly revision: number;
  readonly tracking: AchievementTracking;
  readonly scopeId: string;
  readonly metrics: Readonly<Record<string, AchievementMetric>>;
  readonly invalidated: boolean;
  readonly suspended: boolean;
  readonly completed?: AchievementCompletion;
}
export interface AchievementWindow {
  readonly id: string;
  readonly status: "active" | "completed" | "abandoned" | "aborted";
}
/** Independent storage contract; not yet a field in the player save schemas. */
export interface AchievementLedger {
  readonly schemaVersion: typeof ACHIEVEMENT_LEDGER_VERSION;
  readonly streamId: string;
  readonly nextSequence: number;
  readonly windows: Readonly<Partial<Record<AchievementWindowScope, AchievementWindow>>>;
  readonly records: Readonly<Record<string, AchievementRecord>>;
}
export interface AchievementDiagnostic { readonly key?: string; readonly code: string; readonly message: string }
export interface AchievementEvaluation {
  readonly ledger: AchievementLedger;
  readonly completed: readonly { readonly key: string; readonly completion: AchievementCompletion }[];
  readonly diagnostics: readonly AchievementDiagnostic[];
  readonly replayed: boolean;
}
