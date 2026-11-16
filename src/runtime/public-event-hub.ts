import { createPublicEventBatch, snapshotPublicEventBatch, type PublicEvent, type PublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import { PublicTriggerSpecSchema, selectPublicTriggerEvents, type TriggerSpec } from "../core/events/triggers";
import { FactDispatcher, type FactDeliveryStage, type FactSubscription } from "./fact-dispatcher";

export interface PublicEventSubscription extends FactSubscription {
  /** Every supplied scope must belong to the same matching event; delivery keeps its entire atomic batch. */
  readonly scopes?: PublicEventScopes;
}
export type PublicEventListener = (batch: PublicEventBatch, signal: AbortSignal) => void | Promise<void>;
function selected(event: PublicEvent, options: PublicEventSubscription): boolean {
  return (!options.types || options.types.includes(event.type))
    && (!options.scopes || Object.entries(options.scopes).every(([scope, id]) => event.scopes[scope as keyof PublicEventScopes] === id));
}

/** One runtime owns routing, occurrence deduplication and cancellation; no global subscriptions. */
export class RuntimeEventHub extends FactDispatcher<PublicEventBatch> {
  private readonly delivered: Record<FactDeliveryStage, Set<string>> = { resolved: new Set(), committed: new Set() };
  private closed = false;
  private sequence = 0;

  nextId(prefix: string): string {
    if (this.closed || !prefix) throw new Error("公共事件运行时已结束或身份前缀无效");
    return `${prefix}:${++this.sequence}`;
  }
  override subscribe(stage: FactDeliveryStage, listener: PublicEventListener, options: PublicEventSubscription = {}): () => void {
    const selection: PublicEventSubscription = { ...options, ...(options.types ? { types: [...options.types] } : {}),
      ...(options.scopes ? { scopes: { ...options.scopes } } : {}) };
    return super.subscribe(stage, (batch, signal) => {
      if (batch.facts.some(event => selected(event, selection))) return listener(batch, signal);
    }, { signal: options.signal });
  }
  subscribeTrigger(stage: FactDeliveryStage, spec: TriggerSpec, listener: PublicEventListener, options: PublicEventSubscription = {}): () => void {
    const trigger = PublicTriggerSpecSchema.parse(spec);
    return this.subscribe(stage, (batch, signal) => {
      if (selectPublicTriggerEvents(trigger, batch).some(event => selected(event, options))) return listener(batch, signal);
    }, options);
  }
  override publish(stage: FactDeliveryStage, batch: PublicEventBatch): void {
    if (this.closed || batch.restored) return;
    const normalized = snapshotPublicEventBatch(batch);
    const seen = this.delivered[stage];
    const facts: PublicEvent[] = [];
    for (const event of normalized.facts) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      facts.push(event);
    }
    if (facts.length) super.publish(stage, facts.length === normalized.facts.length ? normalized : createPublicEventBatch({ ...normalized, facts }));
  }
  override dispose(): void {
    this.closed = true;
    this.delivered.resolved.clear();
    this.delivered.committed.clear();
    super.dispose();
  }
}
