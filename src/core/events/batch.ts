import type { GameEvent, MatchState } from "../match/types";
import { matchFactProductionMetadata } from "./production";
import { MATCH_FACT_API_VERSION, type MatchFact, type MatchFactBatch, type MatchFactBatchOptions } from "./types";

/** Events are JSON-shaped; clone before freezing so domain/plugin objects stay untouched. */
function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as T;
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableCopy(child)]))) as T;
  }
  return value;
}

/**
 * Wrap accepted history exactly once at the owner's transition boundary.
 * Initial creation includes initialization facts. Restoration must explicitly
 * pass restored:true: there is no durable origin ledger to reconstruct/replay.
 */
export function createMatchFactBatch(before: MatchState | undefined, after: MatchState, options: MatchFactBatchOptions = {}): MatchFactBatch {
  if (before && before.id !== after.id) throw new Error("A fact batch cannot cross match identities");
  if (before && before.history.length > after.history.length) throw new Error("A fact batch cannot rewind match history");
  const restored = options.restored === true;
  const fromIndex = restored ? after.history.length : before?.history.length ?? 0;
  const toIndex = after.history.length;
  const events = Object.freeze(after.history.slice(fromIndex));
  let roundIndex = before?.roundIndex ?? 0;
  const facts: MatchFact[] = [];
  for (let index = fromIndex; index < toIndex; index++) {
    const original = after.history[index];
    if (original.type === "ROUND_STARTED") roundIndex = original.roundIndex;
    const metadata = matchFactProductionMetadata(original);
    facts.push(Object.freeze({
      apiVersion: MATCH_FACT_API_VERSION,
      id: `${after.id}:${index}`, matchId: after.id, index,
      roundIndex: metadata?.roundIndex ?? roundIndex,
      type: original.type, event: immutableCopy<GameEvent>(original),
      ...(metadata?.source ? { source: immutableCopy(metadata.source) } : {}),
      ...(metadata?.cause ? { cause: immutableCopy(metadata.cause) } : {}),
      ...(metadata?.effects ? { effects: immutableCopy(metadata.effects) } : {}),
      ...(metadata?.snapshot ? { snapshot: immutableCopy(metadata.snapshot) } : {}),
      ...(metadata?.play ? { play: immutableCopy(metadata.play) } : {}),
      ...(metadata?.voluntaryStand ? { voluntaryStand: true } : {})
    }) as MatchFact);
  }
  return Object.freeze({ apiVersion: MATCH_FACT_API_VERSION, before, after, restored, events, facts: Object.freeze(facts), fromIndex, toIndex });
}
