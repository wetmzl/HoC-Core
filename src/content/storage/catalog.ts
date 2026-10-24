import { z } from "zod";
import type { ContentFileSystem } from "./contracts";
import { decodeText, encodeText, sha256Json, stableJson } from "./encoding";

export const CONTENT_STORAGE_VERSION = 3 as const;
export const CONTENT_ROOT = "content/v1";
export const CONTENT_CATALOG_PATHS = [`${CONTENT_ROOT}/catalog-a.json`, `${CONTENT_ROOT}/catalog-b.json`] as const;

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const packageId = z.string().regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/);

const installedPackageSchema = z.object({
  currentRevision: revision,
  enabled: z.boolean()
}).strict();

export const ContentCatalogSchema = z.object({
  packages: z.record(packageId, installedPackageSchema),
  pluginOrder: z.array(packageId).refine((order) => new Set(order).size === order.length)
}).strict();

const PreviousContentCatalogSchema = z.object({ packages: z.record(packageId, installedPackageSchema) }).strict();

const LegacyContentCatalogSchema = z.object({
  packages: z.record(packageId, revision)
}).strict();

const envelopeBodySchema = z.object({
  storageVersion: z.literal(CONTENT_STORAGE_VERSION),
  generation: z.number().int().nonnegative(),
  writtenAt: z.string().min(1),
  state: z.enum(["prepared", "committed"]),
  catalog: ContentCatalogSchema
}).strict();

const envelopeSchema = envelopeBodySchema.extend({ checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

const legacyEnvelopeBodySchema = z.object({
  storageVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  writtenAt: z.string().min(1),
  state: z.enum(["prepared", "committed"]),
  catalog: LegacyContentCatalogSchema
}).strict();
const legacyEnvelopeSchema = legacyEnvelopeBodySchema.extend({ checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const previousEnvelopeSchema = envelopeBodySchema.extend({
  storageVersion: z.literal(2), catalog: PreviousContentCatalogSchema
}).extend({ checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export type ContentCatalog = z.infer<typeof ContentCatalogSchema>;
type CatalogEnvelopeBody = z.infer<typeof envelopeBodySchema>;
export type CatalogEnvelope = z.infer<typeof envelopeSchema>;

export interface LoadedCatalogSlot {
  readonly path: typeof CONTENT_CATALOG_PATHS[number];
  readonly envelope: CatalogEnvelope;
  readonly requiresMigration: boolean;
}

export class ContentCatalogCorruptionError extends Error {
  constructor(readonly paths: readonly string[]) {
    super("内容仓库的 catalog 槽均已损坏。");
    this.name = "ContentCatalogCorruptionError";
  }
}

export function emptyContentCatalog(): ContentCatalog {
  return { packages: {}, pluginOrder: [] };
}

async function createEnvelope(body: CatalogEnvelopeBody): Promise<CatalogEnvelope> {
  return { ...body, checksum: await sha256Json(body) };
}

async function parseEnvelope(bytes: Uint8Array): Promise<CatalogEnvelope | null> {
  try {
    const parsed = envelopeSchema.parse(JSON.parse(decodeText(bytes)));
    const { checksum, ...body } = parsed;
    if (await sha256Json(body) === checksum) return parsed;
  } catch {
    // Try older catalog shapes below.
  }
  try {
    const parsed = previousEnvelopeSchema.parse(JSON.parse(decodeText(bytes)));
    const { checksum, ...body } = parsed;
    if (await sha256Json(body) !== checksum) return null;
    return { ...parsed, storageVersion: CONTENT_STORAGE_VERSION, catalog: { ...parsed.catalog, pluginOrder: [] } };
  } catch {
    // Try the v1 shape below.
  }
  try {
    const parsed = legacyEnvelopeSchema.parse(JSON.parse(decodeText(bytes)));
    const { checksum, ...body } = parsed;
    if (await sha256Json(body) !== checksum) return null;
    return {
      storageVersion: CONTENT_STORAGE_VERSION,
      generation: parsed.generation,
      writtenAt: parsed.writtenAt,
      state: parsed.state,
      catalog: {
        packages: Object.fromEntries(Object.entries(parsed.catalog.packages).map(([id, currentRevision]) => [id, { currentRevision, enabled: true }])),
        pluginOrder: []
      },
      checksum
    };
  } catch {
    return null;
  }
}

async function envelopeNeedsMigration(bytes: Uint8Array): Promise<boolean> {
  try {
    const value = JSON.parse(decodeText(bytes));
    return legacyEnvelopeSchema.safeParse(value).success || previousEnvelopeSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export async function readCatalogSlots(fileSystem: ContentFileSystem): Promise<{
  readonly committed: readonly LoadedCatalogSlot[];
  readonly occupied: readonly string[];
}> {
  const committed: LoadedCatalogSlot[] = [];
  const occupied: string[] = [];
  for (const path of CONTENT_CATALOG_PATHS) {
    const bytes = await fileSystem.read(path);
    if (!bytes) continue;
    occupied.push(path);
    const envelope = await parseEnvelope(bytes);
    if (envelope?.state === "committed") committed.push({ path, envelope, requiresMigration: await envelopeNeedsMigration(bytes) });
  }
  committed.sort((left, right) => right.envelope.generation - left.envelope.generation);
  return { committed, occupied };
}

export async function readCurrentCatalog(fileSystem: ContentFileSystem): Promise<LoadedCatalogSlot | null> {
  const slots = await readCatalogSlots(fileSystem);
  if (slots.committed[0]) return slots.committed[0];
  if (slots.occupied.length === CONTENT_CATALOG_PATHS.length) throw new ContentCatalogCorruptionError(slots.occupied);
  return null;
}

async function writeEnvelope(
  fileSystem: ContentFileSystem,
  path: typeof CONTENT_CATALOG_PATHS[number],
  body: CatalogEnvelopeBody
): Promise<LoadedCatalogSlot> {
  const envelope = await createEnvelope(body);
  await fileSystem.write(path, encodeText(stableJson(envelope)));
  const stored = await fileSystem.read(path);
  const verified = stored ? await parseEnvelope(stored) : null;
  if (!verified || verified.generation !== body.generation || verified.state !== body.state) {
    throw new Error(`Catalog 写入后校验失败：${path}`);
  }
  return { path, envelope: verified, requiresMigration: false };
}

export async function commitCatalog(
  fileSystem: ContentFileSystem,
  catalog: ContentCatalog,
  now: () => string
): Promise<{ readonly mirrored: boolean; readonly generation: number }> {
  const slots = await readCatalogSlots(fileSystem);
  const current = slots.committed[0];
  const firstPath = current?.path === CONTENT_CATALOG_PATHS[0] ? CONTENT_CATALOG_PATHS[1] : CONTENT_CATALOG_PATHS[0];
  const secondPath = firstPath === CONTENT_CATALOG_PATHS[0] ? CONTENT_CATALOG_PATHS[1] : CONTENT_CATALOG_PATHS[0];
  const baseGeneration = Math.max(0, ...slots.committed.map((slot) => slot.envelope.generation));
  await writeEnvelope(fileSystem, firstPath, {
    storageVersion: CONTENT_STORAGE_VERSION,
    generation: baseGeneration + 1,
    writtenAt: now(),
    state: "prepared",
    catalog
  });
  await writeEnvelope(fileSystem, secondPath, {
    storageVersion: CONTENT_STORAGE_VERSION,
    generation: baseGeneration + 2,
    writtenAt: now(),
    state: "committed",
    catalog
  });
  try {
    await writeEnvelope(fileSystem, firstPath, {
      storageVersion: CONTENT_STORAGE_VERSION,
      generation: baseGeneration + 3,
      writtenAt: now(),
      state: "committed",
      catalog
    });
    return { mirrored: true, generation: baseGeneration + 3 };
  } catch {
    return { mirrored: false, generation: baseGeneration + 2 };
  }
}
