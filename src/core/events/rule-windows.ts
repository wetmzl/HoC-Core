import type { AbilityBroadcastTrigger, AbilityEventContext } from "../abilities/types";
import type { Actor, MatchState } from "../match/types";

export interface RuleWindowOccurrence {
  readonly id: string;
  readonly trigger: AbilityBroadcastTrigger;
  readonly matchId: string;
  readonly roundIndex: number;
  /** History position at the beginning of the containing resolution. */
  readonly historyIndex: number;
  readonly sourceEventId: string;
  readonly eventActor?: Actor;
  /** Captured at this window, rather than reconstructed from the final match. */
  readonly event: AbilityEventContext;
}

function copy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(copy)) as T;
  if (value !== null && typeof value === "object")
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]))) as T;
  return value;
}

// Sidecars never change the saved match, ability result or legacy event payload.
export interface AbilityRuleWindow { readonly event: AbilityEventContext; readonly eventOffset: number }
const resolutions = new WeakMap<object, readonly AbilityRuleWindow[]>();
const matches = new WeakMap<MatchState, readonly RuleWindowOccurrence[]>();

export function withAbilityRuleWindows<T extends object>(result: T, windows: readonly AbilityRuleWindow[]): T {
  resolutions.set(result, Object.freeze(windows.map(copy)));
  return result;
}

export function abilityRuleWindows(result: object): readonly AbilityRuleWindow[] {
  return resolutions.get(result) ?? [];
}

interface CapturedWindow {
  readonly roundIndex: number;
  readonly historyIndex: number;
  readonly event: AbilityEventContext;
}
// Synchronous dynamic scope only. Nested previews explicitly suppress capture;
// thrown/rejected operations never attach their buffer to an accepted state.
let capture: CapturedWindow[] | undefined;

export function captureMatchRuleWindows(before: MatchState | undefined, operation: () => MatchState): MatchState {
  const previous = capture;
  const windows: CapturedWindow[] = [];
  capture = windows;
  try {
    const after = operation();
    if (after === before) return after;
    const inherited = before ? matches.get(before) ?? [] : [];
    matches.set(after, Object.freeze([...inherited, ...windows.map((window, offset) => Object.freeze({
      id: `${after.id}:rule:${window.historyIndex}:${inherited.length + offset}`,
      matchId: after.id, roundIndex: window.roundIndex, historyIndex: window.historyIndex,
      trigger: window.event.trigger, sourceEventId: window.event.sourceEventId,
      ...(window.event.eventActor ? { eventActor: window.event.eventActor } : {}), event: window.event
    }))]));
    return after;
  } finally { capture = previous; }
}

export function recordMatchRuleWindows(state: MatchState, resolution: object, precedingEvents = 0): void {
  if (!capture) return;
  for (const window of abilityRuleWindows(resolution))
    capture.push({ roundIndex: state.roundIndex, historyIndex: state.history.length + window.eventOffset + (window.eventOffset > 0 ? precedingEvents : 0), event: window.event });
}

export function withoutRuleWindowCapture<T>(operation: () => T): T {
  const previous = capture;
  capture = undefined;
  try { return operation(); } finally { capture = previous; }
}

/** Retry batches include all accepted windows since the last durable state. */
export function matchRuleWindows(before: MatchState | undefined, after: MatchState, restored = false): readonly RuleWindowOccurrence[] {
  if (restored) return [];
  if (before && before.id !== after.id) throw new Error("Rule windows cannot cross match identities");
  const windows = matches.get(after) ?? [];
  const offset = before ? matches.get(before)?.length ?? 0 : 0;
  return Object.freeze(windows.slice(offset));
}
