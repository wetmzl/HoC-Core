export type FactDeliveryStage = "resolved" | "committed";

interface FactBatch {
  readonly facts: readonly { readonly type: string }[];
}

export interface FactSubscription {
  readonly signal?: AbortSignal;
  /** Filtering selects batches, without splitting an atomic batch into fragments. */
  readonly types?: readonly string[];
}

/** Runtime-owned observers. Rule resolution and durable projections never run here. */
export class FactDispatcher<Batch extends FactBatch> {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<{
    stage: FactDeliveryStage;
    listener: (batch: Batch, signal: AbortSignal) => void | Promise<void>;
    types?: ReadonlySet<string>;
    signal: AbortSignal;
    release: () => void;
  }>();
  private publishing = false;
  private readonly deliveries: { stage: FactDeliveryStage; batch: Batch }[] = [];

  constructor(private readonly reportError: (error: unknown, stage: FactDeliveryStage) => void =
    (error, stage) => console.warn("事实观察者执行失败", { stage, error })) {}

  subscribe(stage: FactDeliveryStage, listener: (batch: Batch, signal: AbortSignal) => void | Promise<void>,
    options: FactSubscription = {}): () => void {
    if (this.lifetime.signal.aborted || options.signal?.aborted) return () => {};
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    const entry = { stage, listener, types: options.types ? new Set(options.types) : undefined,
      signal, release: () => {} };
    const release = () => {
      this.listeners.delete(entry);
      signal.removeEventListener("abort", release);
      controller.abort();
    };
    entry.release = release;
    this.listeners.add(entry);
    signal.addEventListener("abort", release, { once: true });
    return release;
  }

  publish(stage: FactDeliveryStage, batch: Batch): void {
    if (this.lifetime.signal.aborted) return;
    this.deliveries.push({ stage, batch });
    // A callback may request a subsequent command. Deliver its facts after this whole batch.
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.deliveries.length && !this.lifetime.signal.aborted) {
        const { stage, batch } = this.deliveries.shift()!;
        // Subscription changes affect the next delivery, while cancellation takes effect immediately.
        for (const entry of [...this.listeners]) {
          if (entry.stage !== stage || entry.signal.aborted ||
            (entry.types && !batch.facts.some(fact => entry.types!.has(fact.type)))) continue;
          try {
            const pending = entry.listener(batch, entry.signal);
            if (pending) void Promise.resolve(pending).catch(error => this.report(error, stage));
          } catch (error) { this.report(error, stage); }
        }
      }
    } finally { this.publishing = false; }
  }

  private report(error: unknown, stage: FactDeliveryStage): void {
    try { this.reportError(error, stage); } catch { /* Diagnostics cannot interrupt other observers. */ }
  }

  dispose(): void {
    this.lifetime.abort();
    this.deliveries.length = 0;
    for (const entry of [...this.listeners]) entry.release();
  }
}
