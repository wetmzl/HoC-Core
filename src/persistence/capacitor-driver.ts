import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { RawSaveSnapshot, SaveStorageDriver } from "./storage-driver";

const STORAGE_VERSION = 1 as const;
const SAVE_DIRECTORY = "saves";
const SLOT_PATHS = [`${SAVE_DIRECTORY}/slot-a.json`, `${SAVE_DIRECTORY}/slot-b.json`] as const;

interface FileSystemPort {
  readFile(options: { readonly path: string; readonly directory: Directory; readonly encoding: Encoding }): Promise<{ readonly data: string | Blob }>;
  writeFile(options: { readonly path: string; readonly data: string; readonly directory: Directory; readonly encoding: Encoding; readonly recursive: boolean }): Promise<unknown>;
}

interface EnvelopeBody {
  readonly storageVersion: typeof STORAGE_VERSION;
  readonly generation: number;
  readonly writtenAt: string;
  readonly snapshot: RawSaveSnapshot;
}

interface StoredEnvelope extends EnvelopeBody {
  readonly checksum: string;
}

interface LoadedSlot {
  readonly path: typeof SLOT_PATHS[number];
  readonly envelope: StoredEnvelope;
}

export class NativeSaveStorageCorruptionError extends Error {
  constructor(readonly rawSlots: readonly string[]) {
    super("Android 原生存档的两个恢复槽均不可读取。");
    this.name = "NativeSaveStorageCorruptionError";
  }
}

function checksum(text: string): string {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function envelopeBody(value: EnvelopeBody): EnvelopeBody {
  return {
    storageVersion: value.storageVersion,
    generation: value.generation,
    writtenAt: value.writtenAt,
    snapshot: value.snapshot
  };
}

function parseEnvelope(text: string): StoredEnvelope | null {
  try {
    const value = JSON.parse(text) as Partial<StoredEnvelope>;
    if (value.storageVersion !== STORAGE_VERSION
      || !Number.isSafeInteger(value.generation) || (value.generation ?? -1) < 0
      || typeof value.writtenAt !== "string"
      || !value.snapshot || typeof value.snapshot !== "object"
      || !("longTerm" in value.snapshot) || !("runtime" in value.snapshot)
      || typeof value.checksum !== "string") return null;
    const body = envelopeBody(value as EnvelopeBody);
    if (checksum(JSON.stringify(body)) !== value.checksum) return null;
    return { ...body, checksum: value.checksum };
  } catch {
    return null;
  }
}

function createEnvelope(generation: number, snapshot: RawSaveSnapshot, writtenAt: string): StoredEnvelope {
  const body: EnvelopeBody = { storageVersion: STORAGE_VERSION, generation, writtenAt, snapshot };
  return { ...body, checksum: checksum(JSON.stringify(body)) };
}

function isMissingFile(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  return candidate.code === "OS-PLUG-FILE-0008"
    || (typeof candidate.message === "string" && /not found|does not exist|no such file/i.test(candidate.message));
}

/** Crash-recoverable native driver. The highest valid A/B generation is the committed snapshot. */
export class CapacitorFileSaveStorageDriver implements SaveStorageDriver {
  constructor(
    private readonly files: FileSystemPort = Filesystem,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  private async readSlot(path: typeof SLOT_PATHS[number]): Promise<{ readonly loaded?: LoadedSlot; readonly invalid?: string }> {
    try {
      const result = await this.files.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      if (typeof result.data !== "string") return { invalid: "[binary data]" };
      const envelope = parseEnvelope(result.data);
      return envelope ? { loaded: { path, envelope } } : { invalid: result.data };
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
  }

  private async currentSlot(): Promise<LoadedSlot | null> {
    const results = await Promise.all(SLOT_PATHS.map((path) => this.readSlot(path)));
    const valid = results.flatMap((result) => result.loaded ? [result.loaded] : [])
      .sort((left, right) => right.envelope.generation - left.envelope.generation);
    if (valid[0]) return valid[0];
    const invalid = results.flatMap((result) => result.invalid === undefined ? [] : [result.invalid]);
    if (invalid.length > 0) throw new NativeSaveStorageCorruptionError(invalid);
    return null;
  }

  async readSnapshot(): Promise<RawSaveSnapshot | null> {
    return (await this.currentSlot())?.envelope.snapshot ?? null;
  }

  async writeSnapshot(snapshot: RawSaveSnapshot): Promise<void> {
    const current = await this.currentSlot();
    const target = current?.path === SLOT_PATHS[0] ? SLOT_PATHS[1] : SLOT_PATHS[0];
    const envelope = createEnvelope((current?.envelope.generation ?? 0) + 1, snapshot, this.now());
    await this.files.writeFile({
      path: target,
      data: JSON.stringify(envelope),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true
    });
    const verified = await this.readSlot(target);
    if (!verified.loaded || verified.loaded.envelope.generation !== envelope.generation) {
      throw new Error("Android 原生存档写入后校验失败，上一代存档仍被保留。");
    }
  }
}

/** Copies an existing WebView IndexedDB snapshot only when native storage has never been initialized. */
export class LegacyCopyingSaveStorageDriver implements SaveStorageDriver {
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly native: SaveStorageDriver,
    private readonly legacy: SaveStorageDriver
  ) {}

  private ensureInitialized(): Promise<void> {
    this.initialization ??= (async () => {
      if (await this.native.readSnapshot() !== null) return;
      const legacySnapshot = await this.legacy.readSnapshot();
      if (legacySnapshot !== null) await this.native.writeSnapshot(legacySnapshot);
    })();
    return this.initialization;
  }

  async readSnapshot(): Promise<RawSaveSnapshot | null> {
    await this.ensureInitialized();
    return this.native.readSnapshot();
  }

  async writeSnapshot(snapshot: RawSaveSnapshot): Promise<void> {
    await this.ensureInitialized();
    await this.native.writeSnapshot(snapshot);
  }
}
