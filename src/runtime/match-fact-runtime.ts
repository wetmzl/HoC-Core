import type { MatchFactBatch } from "../core/events";
import type { LongTermSave, RuntimeSave } from "../persistence/schema";
import type { TelemetryFlow } from "../telemetry/types";
import { FactDispatcher } from "./fact-dispatcher";

export interface MatchFactDelivery extends MatchFactBatch {
  readonly context?: {
    readonly flow: TelemetryFlow;
    readonly debugUsed: boolean;
  };
}

export interface FactCheckpoint {
  readonly longTerm: LongTermSave;
  readonly runtime: RuntimeSave | null;
}

/** Pure, synchronous long-term projection, committed with its unchanged gameplay checkpoint. */
export type FactProjector = (checkpoint: FactCheckpoint, batch: MatchFactBatch) => FactCheckpoint;

/** One flow owns its event routing and transactional consumers. No global subscriptions. */
export class MatchFactRuntime extends FactDispatcher<MatchFactDelivery> {
  private readonly projectors = new Set<FactProjector>();

  registerProjector(projector: FactProjector): () => void {
    this.projectors.add(projector);
    return () => { this.projectors.delete(projector); };
  }

  project(checkpoint: FactCheckpoint, batch: MatchFactBatch): FactCheckpoint {
    if (batch.restored) return checkpoint;
    let projected = checkpoint;
    for (const projector of this.projectors) {
      const next = projector(projected, batch);
      if (!next || typeof next !== "object" || "then" in next || !next.longTerm || !("runtime" in next))
        throw new Error("事实投影必须同步返回完整存档检查点");
      // Runtime progress needs an explicit schema-owned slot, not an arbitrary snapshot writer.
      if (next.runtime !== projected.runtime)
        throw new Error("事实投影不得替换运行时存档；玩法状态由流程会话维护");
      projected = next;
    }
    return projected;
  }

  override dispose(): void {
    this.projectors.clear();
    super.dispose();
  }
}
