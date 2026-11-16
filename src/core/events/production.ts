import type { AbilityDomainEvent, AbilityEventContext, AbilityInstance } from "../abilities/types";
import type { GameEvent } from "../match/types";
import type { MatchEffectFact, MatchFactCause, MatchFactSource, MatchFactSnapshot, MatchAbilityPlayFact } from "./types";

interface ProductionMetadata {
  readonly roundIndex?: number;
  readonly source?: MatchFactSource;
  readonly cause?: MatchFactCause;
  readonly effects?: readonly MatchEffectFact[];
  readonly snapshot?: MatchFactSnapshot;
  readonly play?: MatchAbilityPlayFact;
  readonly voluntaryStand?: boolean;
}

// Object identity ties metadata to the actual successful result. JSON history and
// plugin payloads remain unchanged. Discarded dry runs/failed transactions expose
// none of their objects, and their metadata is collected with those objects.
// This is deliberately not a durable ledger: restored history is never replayed.
const metadata = new WeakMap<object, ProductionMetadata>();

export function captureAbilityFactOrigin(
  events: readonly AbilityDomainEvent[],
  ability: AbilityInstance,
  event: Pick<AbilityEventContext, "sourceEventId" | "trigger">,
  ruleId?: string
): void {
  const source: MatchFactSource = Object.freeze({
    instanceId: ability.instanceId, definitionId: ability.definitionId,
    owner: ability.owner, level: ability.level ?? 1, kind: ability.kind,
    ...(ruleId === undefined ? {} : { ruleId })
  });
  const cause: MatchFactCause = Object.freeze({ sourceEventId: event.sourceEventId, trigger: event.trigger });
  for (const occurrence of events) metadata.set(occurrence, Object.freeze({ ...metadata.get(occurrence), source, cause }));
}

/** append owns the occurrence's real round, including before-round-deal effects. */
export function captureMatchFactRound(events: readonly GameEvent[], roundIndex: number): void {
  for (const occurrence of events) metadata.set(occurrence, Object.freeze({ ...metadata.get(occurrence), roundIndex }));
}

export function matchFactProductionMetadata(event: GameEvent): ProductionMetadata | undefined {
  return metadata.get(event);
}

const effectEvidence = new WeakMap<object, readonly MatchEffectFact[]>();
export function captureEffectEvidence(result: object, effects: readonly MatchEffectFact[]): void { effectEvidence.set(result, effects); }
export function effectEvidenceFor(result: object): readonly MatchEffectFact[] { return effectEvidence.get(result) ?? []; }
export function captureMatchFactEffects(event: GameEvent, result: object): void {
  const effects = effectEvidenceFor(result);
  if (effects.length) metadata.set(event, Object.freeze({ ...metadata.get(event), effects }));
}

export function captureMatchFactSnapshot(events: readonly GameEvent[], snapshot: MatchFactSnapshot): void {
  for (const event of events) metadata.set(event, Object.freeze({ ...metadata.get(event), snapshot }));
}
export function captureAbilityPlayFact(event: GameEvent, play: MatchAbilityPlayFact): void {
  metadata.set(event, Object.freeze({ ...metadata.get(event), play }));
}

export function captureVoluntaryStand(event: GameEvent): void { metadata.set(event, Object.freeze({ ...metadata.get(event), voluntaryStand: true })); }

let evidenceSuppressed = 0;
export function isMatchFactEvidenceSuppressed(): boolean { return evidenceSuppressed > 0; }
export function withoutMatchFactEvidence<T>(operation: () => T): T {
  evidenceSuppressed++;
  try { return operation(); } finally { evidenceSuppressed--; }
}

interface MatchHitResolution {
  readonly snapshot: MatchFactSnapshot;
  readonly bustActors: readonly import("../match/types").Actor[];
}
const hitResolutions = new WeakMap<object, MatchHitResolution>();
/** Complete accepted action evidence, kept outside saved/public event payloads. */
export function captureMatchHitResolution(events: readonly GameEvent[], snapshot: MatchFactSnapshot): void {
  const resolution = Object.freeze({ snapshot, bustActors: Object.freeze(events.flatMap(event => event.type === "BUST" ? [event.actor] : [])) });
  for (const event of events) if (event.type === "PLAYER_HIT" || event.type === "OPPONENT_HIT") hitResolutions.set(event, resolution);
}
export function matchHitResolution(event: GameEvent | undefined): MatchHitResolution | undefined {
  return event ? hitResolutions.get(event) : undefined;
}
