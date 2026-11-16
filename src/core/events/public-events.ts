import type { MatchState } from "../match/types";
import type { MatchFactBatch, MatchFactCause, MatchFactSource } from "./types";
import { matchRuleWindows } from "./rule-windows";
import { capturePublicMatchReadModel, type PublicMatchReadModel } from "./public-match-read-model";

export type { PublicMatchReadModel, PublicSkillLifetime } from "./public-match-read-model";

/** An additive observation contract; independent of persisted history and plugin API versions. */
export const PUBLIC_EVENT_API_VERSION = 1 as const;
export const PUBLIC_EVENT_SCOPE_NAMES = ["game", "program", "match", "round", "rule-window"] as const;
export type PublicEventScopeName = typeof PUBLIC_EVENT_SCOPE_NAMES[number];
export type PublicEventScopes = Readonly<Partial<Record<PublicEventScopeName, string>>>;
export type PublicScalar = string | number | boolean | null;
export interface PublicPresentationContext {
  readonly skillDrawerOpen?: boolean;
  readonly inspectedSkill?: { readonly definitionId: string; readonly instanceId?: string };
}
export interface PublicEventContext {
  /** Detached accepted final batch state, never an inferred state at an individual occurrence. */
  readonly match?: MatchState;
  /** Registry-dependent semantics captured by the host alongside the final match snapshot. */
  readonly matchQueries?: PublicMatchReadModel;
  readonly program?: { readonly id: string; readonly definitionId?: string; readonly nodeId?: string; readonly visitIndex?: number; readonly status?: string };
  readonly presentation?: PublicPresentationContext;
  readonly values?: Readonly<Record<string, PublicScalar>>;
}
export interface PublicEventOrigin {
  readonly factId?: string;
  readonly matchId?: string;
  readonly historyIndex?: number;
  readonly source?: MatchFactSource;
  readonly cause?: MatchFactCause;
  readonly command?: string;
}
export interface PublicEvent {
  readonly apiVersion: typeof PUBLIC_EVENT_API_VERSION;
  readonly id: string;
  readonly type: string;
  readonly scopes: PublicEventScopes;
  readonly data: Readonly<Record<string, unknown>>;
  readonly origin?: PublicEventOrigin;
}
export interface PublicEventBatch {
  readonly id: string;
  readonly facts: readonly PublicEvent[];
  readonly restored: boolean;
  readonly context?: PublicEventContext;
}
const safeEvents = new WeakSet<PublicEvent>();
const safeBatches = new WeakSet<PublicEventBatch>();
const matchSnapshots = new WeakMap<MatchState, MatchState>();

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as T;
  if (value !== null && typeof value === "object")
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableCopy(child)]))) as T;
  return value;
}
export function createPublicEvent(input: Omit<PublicEvent, "apiVersion" | "data"> & { readonly data?: PublicEvent["data"] }): PublicEvent {
  if (safeEvents.has(input as PublicEvent)) return input as PublicEvent;
  if (!input.id || !input.type) throw new Error("公共事件必须有稳定身份与类型");
  for (const [scope, id] of Object.entries(input.scopes)) {
    if (!PUBLIC_EVENT_SCOPE_NAMES.includes(scope as PublicEventScopeName) || typeof id !== "string" || !id)
      throw new Error("公共事件范围无效");
  }
  const event = immutableCopy({ ...input, apiVersion: PUBLIC_EVENT_API_VERSION, data: input.data ?? {} });
  safeEvents.add(event);
  return event;
}
function snapshotMatch(state: MatchState): MatchState {
  let snapshot = matchSnapshots.get(state);
  if (!snapshot) {
    snapshot = immutableCopy(state);
    matchSnapshots.set(state, snapshot);
    matchSnapshots.set(snapshot, snapshot);
  }
  return snapshot;
}
export function createPublicEventBatch(input: Omit<PublicEventBatch, "restored"> & { readonly restored?: boolean }): PublicEventBatch {
  return normalizePublicEventBatch(input, true);
}
function normalizePublicEventBatch(input: Omit<PublicEventBatch, "restored"> & { readonly restored?: boolean }, captureHostQueries: boolean): PublicEventBatch {
  if (!input.id) throw new Error("公共事件批次必须有身份");
  const facts = input.restored ? [] : input.facts.map(createPublicEvent);
  if (new Set(facts.map(fact => fact.id)).size !== facts.length) throw new Error("公共事件批次包含重复身份");
  // Never expose or freeze gameplay objects at this public observation boundary.
  const matchQueries = input.context?.matchQueries ?? (captureHostQueries && !input.restored && input.context?.match
    ? capturePublicMatchReadModel(input.context.match) : undefined);
  const context = input.context ? Object.freeze({
    ...(input.context.match ? { match: snapshotMatch(input.context.match) } : {}),
    ...(matchQueries ? { matchQueries: immutableCopy(matchQueries) } : {}),
    ...(input.context.program ? { program: immutableCopy(input.context.program) } : {}),
    ...(input.context.presentation ? { presentation: immutableCopy(input.context.presentation) } : {}),
    ...(input.context.values ? { values: immutableCopy(input.context.values) } : {}) }) : undefined;
  const batch = Object.freeze({ id: input.id, facts: Object.freeze(facts), restored: input.restored === true, ...(context ? { context } : {}) });
  safeBatches.add(batch);
  return batch;
}

/** Normalize a public boundary once, reusing an already detached and immutable batch. */
export function snapshotPublicEventBatch(batch: PublicEventBatch): PublicEventBatch {
  return safeBatches.has(batch) ? batch : normalizePublicEventBatch(batch, false);
}

/** Adapts original accepted facts and actual rule invocations without replaying restored history. */
export function matchPublicEventBatch(batch: MatchFactBatch, scopes: PublicEventScopes = {}): PublicEventBatch {
  const facts: PublicEvent[] = batch.facts.map(fact => createPublicEvent({
    id: fact.id, type: `match.${fact.type}`, scopes: { ...scopes, match: fact.matchId, round: `${fact.matchId}:${fact.roundIndex}` },
    data: fact.event as unknown as Readonly<Record<string, unknown>>,
    origin: { factId: fact.id, matchId: fact.matchId, historyIndex: fact.index,
      ...(fact.source ? { source: fact.source } : {}), ...(fact.cause ? { cause: fact.cause } : {}) }
  }));
  if (!batch.before && !batch.restored) facts.unshift(createPublicEvent({
    id: `${batch.after.id}:created`, type: "match.created", scopes: { ...scopes, match: batch.after.id },
    data: { matchId: batch.after.id, opponentId: batch.after.opponentId }, origin: { matchId: batch.after.id, historyIndex: -1 }
  }));
  for (const occurrence of matchRuleWindows(batch.before, batch.after, batch.restored)) facts.push(createPublicEvent({
    id: occurrence.id, type: `rule.${occurrence.trigger}`,
    scopes: { ...scopes, match: occurrence.matchId, round: `${occurrence.matchId}:${occurrence.roundIndex}`, "rule-window": occurrence.id },
    data: { ...occurrence.event, event: occurrence.event, ...(occurrence.eventActor ? { actor: occurrence.eventActor } : {}) },
    origin: { matchId: occurrence.matchId, historyIndex: occurrence.historyIndex,
      cause: { trigger: occurrence.trigger, sourceEventId: occurrence.sourceEventId } }
  }));
  facts.sort((left, right) => (left.origin?.historyIndex ?? 0) - (right.origin?.historyIndex ?? 0)
    || Number(right.type.startsWith("rule.")) - Number(left.type.startsWith("rule.")));
  return createPublicEventBatch({ id: `${batch.after.id}:${batch.fromIndex}-${batch.toIndex}`, facts, restored: batch.restored, context: { match: batch.after } });
}
