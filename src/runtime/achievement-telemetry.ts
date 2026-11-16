import type { AchievementCommitPort } from "../core/achievements/commit";
import type { TelemetryClient } from "../telemetry/client";

export const ACHIEVEMENT_TELEMETRY_CONSUMER = "telemetry";

/**
 * Transfer committed deliveries into the durable telemetry outbox before acknowledging them.
 * A crash or failed checkpoint acknowledgement may repeat this transfer; the outbox deduplicates it.
 * No completion is inferred from restoration, and this function never reads gameplay history.
 */
export async function flushCommittedAchievementTelemetry(
  port: AchievementCommitPort,
  telemetry: Pick<TelemetryClient, "recordAchievementUnlocks">
): Promise<readonly string[]> {
  const consumer = ACHIEVEMENT_TELEMETRY_CONSUMER;
  const pending = port.committed.pending.filter(delivery => delivery.requiredConsumers.includes(consumer)
    && !delivery.acknowledgedBy.includes(consumer));
  if (!pending.length) return [];
  const transferred = new Set(pending.map(delivery => delivery.id));
  const item = (delivery: typeof pending[number]) => ({ key: delivery.key, completion: delivery.completion, allowDebug: delivery.allowDebug });
  await telemetry.recordAchievementUnlocks(pending.map(item));
  return port.drain(consumer, async delivery => {
    // A serialized submit may have appended a delivery while the first batch was being persisted.
    if (!transferred.has(delivery.id)) await telemetry.recordAchievementUnlocks([item(delivery)]);
  });
}
