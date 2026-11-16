import { z } from "zod";
import type { AchievementCatalogItem, AchievementUnlockItem } from "./types";

export const ACHIEVEMENT_EVENT_MAX_BYTES = 48 * 1024;
export const ACHIEVEMENT_CATALOG_BATCH = 64;
export const ACHIEVEMENT_UNLOCK_BATCH = 128;
export const AchievementTelemetryKey = z.string().max(400).regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*#[a-z0-9][a-z0-9:_-]*\/[a-z0-9][a-z0-9_-]*$/);
const revision = z.number().int().positive().safe();
export const CatalogItemSchema = z.tuple([AchievementTelemetryKey, revision]);
export const UnlockItemSchema = z.tuple([AchievementTelemetryKey, revision, z.string().datetime({ offset: true }), z.boolean()]);
export const LoadedAchievementsData = z.object({
  catalog_hash: z.string().regex(/^[a-f0-9]{64}$/), part: z.number().int().nonnegative(), parts: z.number().int().positive().max(1024),
  items: z.array(CatalogItemSchema).max(ACHIEVEMENT_CATALOG_BATCH)
}).strict().refine(data => data.part < data.parts && (data.items.length > 0 || data.part === 0 && data.parts === 1)
  && new Set(data.items.map(item => item[0])).size === data.items.length, "Invalid catalog batch");
export const UnlockedAchievementsData = z.object({ items: z.array(UnlockItemSchema).min(1).max(ACHIEVEMENT_UNLOCK_BATCH) }).strict()
  .refine(data => new Set(data.items.map(item => item[0])).size === data.items.length, "Duplicate achievement keys");

export function telemetryByteLength(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
export async function achievementCatalogHash(items: readonly AchievementCatalogItem[]): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(items)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate and copy only private wire identifiers, never content metadata or rules. */
export function catalogItems(entries: readonly { readonly key: string; readonly definition: { readonly revision: number } }[]): AchievementCatalogItem[] {
  if (entries.length > 1024) throw new Error("Achievement telemetry catalog capacity exceeded");
  const items = entries.map(entry => CatalogItemSchema.parse([entry.key, entry.definition.revision]));
  items.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] - right[1]);
  if (new Set(items.map(item => item[0])).size !== items.length) throw new Error("Duplicate achievement telemetry key");
  return items;
}
export function unlockItems(entries: readonly { readonly key: string; readonly completion: { readonly revision: number; readonly at: string }; readonly allowDebug: boolean }[]): AchievementUnlockItem[] {
  if (entries.length > 1024) throw new Error("Achievement telemetry completion capacity exceeded");
  return entries.map(entry => UnlockItemSchema.parse([entry.key, entry.completion.revision, entry.completion.at, entry.allowDebug]));
}
