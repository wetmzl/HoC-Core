import { createMatchFactBatch, type MatchFactBatch } from "../core/events";

/** Keeps action-time snapshots until their gameplay checkpoint succeeds. */
export class PendingMatchFacts {
  private pending: MatchFactBatch[] = [];

  retain(batch: MatchFactBatch): void {
    if (!batch.restored && batch.facts.length) this.pending.push(batch);
  }

  /** Failed writes may span several actions; preserve each original observation boundary. */
  forCheckpoint(checkpoint: MatchFactBatch): readonly MatchFactBatch[] {
    if (checkpoint.restored || !checkpoint.facts.length) return [checkpoint];
    const batches: MatchFactBatch[] = [];
    let before = checkpoint.before, cursor = checkpoint.fromIndex;
    for (const batch of this.pending) {
      if (batch.after.id !== checkpoint.after.id || batch.fromIndex < cursor || batch.toIndex > checkpoint.toIndex) continue;
      if (batch.fromIndex > cursor) {
        if (!batch.before) return [checkpoint];
        batches.push(createMatchFactBatch(before, batch.before));
      }
      batches.push(batch);
      before = batch.after; cursor = batch.toIndex;
    }
    if (cursor < checkpoint.toIndex) batches.push(createMatchFactBatch(before, checkpoint.after));
    return batches.length ? batches : [checkpoint];
  }

  committed(batch: MatchFactBatch): void {
    this.pending = this.pending.filter(pending => pending.after.id !== batch.after.id || pending.toIndex > batch.toIndex);
  }

  clear(): void { this.pending = []; }
}
