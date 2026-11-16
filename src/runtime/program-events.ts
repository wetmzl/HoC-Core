import { createPublicEvent, createPublicEventBatch, type PublicEventScopes, type PublicEventBatch } from "../core/events/public-events";
import type { ProgramFacts } from "../core/flow/program";
import type { RuntimeEventHub } from "./public-event-hub";

export interface ProgramEventPosition {
  readonly id: string;
  readonly definitionId: string;
  readonly nodeId?: string;
  readonly visitIndex: number;
  readonly status: string;
}
export interface ProgramLifecycleChange {
  readonly type: string;
  readonly nodeId?: string;
  readonly visitIndex?: number;
  readonly [key: string]: unknown;
}

/** The caller has already committed this operation; observers cannot affect it. */
export function createProgramLifecycleBatch(scopes: PublicEventScopes,
  position: ProgramEventPosition, changes: readonly ProgramLifecycleChange[], command: string, progress?: Pick<ProgramFacts, "defeated">): PublicEventBatch {
  const ownedScopes = { ...scopes, program: position.id };
  const facts = changes.map(({ type, ...change }) => createPublicEvent({
    id: JSON.stringify([scopes.game ?? null, "program", position.id, change.visitIndex ?? position.visitIndex,
        type, change.choiceId ?? change.rewardId ?? null]),
    type: `program.${type}`,
    scopes: ownedScopes,
    data: { definitionId: position.definitionId, nodeId: position.nodeId, visitIndex: position.visitIndex, ...change },
    origin: { command }
  }));
  return createPublicEventBatch({ id: `program:${position.id}:${command}:${position.visitIndex}:${facts.map(fact => fact.id).join("|")}`, facts,
    context: { program: position, ...(progress ? { values: Object.fromEntries(
      [...new Set(progress.defeated)].map(id => [`progression.defeated.${id}`, true])) } : {}) } });
}

export function publishProgramLifecycle(hub: RuntimeEventHub | undefined, scopes: PublicEventScopes,
  position: ProgramEventPosition, changes: readonly ProgramLifecycleChange[], command: string, progress?: Pick<ProgramFacts, "defeated">): void {
  if (!hub || !changes.length) return;
  const original = createProgramLifecycleBatch(scopes, position, changes, command, progress);
  const batch = changes.some(change => change.type === "restored") ? createPublicEventBatch({ ...original,
    id: hub.nextId(`program:${position.id}`), facts: original.facts.map(event => event.type === "program.restored"
      ? createPublicEvent({ ...event, id: hub.nextId(`program:${position.id}:restored`) }) : event) }) : original;
  hub.publish("resolved", batch);
  hub.publish("committed", batch);
}
