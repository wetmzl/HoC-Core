import { Capacitor } from "@capacitor/core";
import { createAchievementLedger } from "../core/achievements/engine";
import {
  createAchievementCommitPort, restoreAchievementCheckpoint,
  type AchievementCheckpoint, type AchievementCommitPort, type AchievementCommitReceipt
} from "../core/achievements/commit";
import {
  projectAchievementList, type AchievementListPresentation, type AchievementPresentationEntry,
  type VisibleAchievementPresentation
} from "../core/achievements/presentation";
import type { AchievementLedger } from "../core/achievements/types";
import { CapacitorFileSaveStorageDriver } from "../persistence/capacitor-driver";
import { IndexedDbSaveStorageDriver } from "../persistence/dexie-repository";
import type { SaveStorageDriver } from "../persistence/storage-driver";

export type CompletedAchievementPresentation = Extract<VisibleAchievementPresentation, { readonly status: "completed" }>;
export interface AchievementUiSnapshot {
  readonly status: "loading" | "ready" | "error";
  readonly list: AchievementListPresentation;
  readonly error?: string;
}

const emptyLedger = createAchievementLedger("uninitialized");
const presentationConsumer = "presentation";

/**
 * Presentation bridge for committed checkpoints. Standalone tools retain their independent
 * storage; gameplay binds its atomic repository checkpoint after initialization.
 */
export class AchievementUiRuntime {
  private catalog: readonly AchievementPresentationEntry[] = [];
  private port?: AchievementCommitPort;
  private external?: { checkpoint: AchievementCheckpoint; submit?: (after: AchievementLedger, before?: AchievementLedger) => Promise<AchievementCommitReceipt> };
  private initialization?: Promise<void>;
  private current: AchievementUiSnapshot = Object.freeze({ status: "loading", list: projectAchievementList([], emptyLedger) });
  private readonly listeners = new Set<() => void>();
  private readonly unlockListeners = new Set<(achievement: CompletedAchievementPresentation) => void>();

  constructor(private readonly driver: SaveStorageDriver, private readonly createStreamId: () => string = () => crypto.randomUUID()) {}

  get snapshot(): AchievementUiSnapshot { return this.current; }
  /** The last committed baseline, available after ready succeeds. */
  get checkpoint(): AchievementCheckpoint | undefined { return this.external?.checkpoint ?? this.port?.committed; }
  get definitions(): readonly AchievementPresentationEntry[] { return this.catalog; }

  /** Switch presentation to the checkpoint committed atomically with gameplay. */
  connectCheckpoint(checkpoint: AchievementCheckpoint,
    submit: (after: AchievementLedger, before?: AchievementLedger) => Promise<AchievementCommitReceipt>): () => void {
    this.external = { checkpoint: restoreAchievementCheckpoint(checkpoint), submit };
    this.refresh("ready");
    const connection = this.external;
    return () => { if (this.external === connection) connection.submit = undefined; };
  }

  acceptCommittedCheckpoint(checkpoint: AchievementCheckpoint, notify = true): void {
    const before = this.checkpoint?.ledger;
    const valid = restoreAchievementCheckpoint(checkpoint);
    if (this.external) this.external.checkpoint = valid;
    else this.external = { checkpoint: valid };
    this.refresh("ready");
    if (!notify || !before || before.streamId !== valid.ledger.streamId) return;
    for (const row of this.current.list.rows) {
      if (row.status === "completed" && !before.records[row.key]?.completed)
        this.notify(this.unlockListeners, listener => listener(row));
    }
  }

  installCatalog(entries: readonly AchievementPresentationEntry[]): void {
    // Validate and detach metadata while the owning content runtime still owns its media URLs.
    const catalog = structuredClone(entries);
    projectAchievementList(catalog, this.checkpoint?.ledger ?? emptyLedger);
    this.catalog = catalog;
    this.refresh(this.current.status, this.current.error);
  }

  ready(): Promise<void> {
    if (this.external) return Promise.resolve();
    if (this.port) return this.acknowledgePresentation();
    if (this.initialization) return this.initialization;
    const initialize = async () => {
      try {
        const stored = await this.driver.readSnapshot();
        const initial = stored?.longTerm == null
          ? createAchievementLedger(this.createStreamId()) : restoreAchievementCheckpoint(stored.longTerm);
        this.port = createAchievementCommitPort({ initial, requiredConsumers: [presentationConsumer],
          save: checkpoint => this.driver.writeSnapshot({ longTerm: checkpoint, runtime: null }) });
        this.refresh("ready");
        // Restored unlocks are already permanent. Quietly clear our own previous UI receipts.
        // Other consumers' durable deliveries remain intact.
        await this.acknowledgePresentation();
      } catch (error) {
        if (!this.port) this.refresh("error", "无法读取成就记录，请重试。");
        throw error;
      }
    };
    this.initialization = Promise.resolve().then(initialize).finally(() => { this.initialization = undefined; });
    this.refresh("loading");
    return this.initialization;
  }

  /** Tools and semantic producers calculate from the last committed checkpoint. */
  async submit(afterLedger: AchievementLedger, expectedBefore?: AchievementLedger): Promise<AchievementCommitReceipt> {
    await this.ready();
    if (this.external) {
      if (!this.external.submit) throw new Error("成就写入需要正在运行的游戏事务。");
      return this.external.submit(afterLedger, expectedBefore);
    }
    const receipt = await this.port!.submit(afterLedger, expectedBefore);
    this.refresh("ready");
    if (!receipt.replayed && receipt.deliveries.length) {
      const completed = new Map(this.current.list.rows.filter((row): row is CompletedAchievementPresentation => row.status === "completed")
        .map(row => [row.key, row]));
      for (const delivery of receipt.deliveries) {
        const row = completed.get(delivery.key);
        // A disabled catalog has no live media URLs and cannot create a stale notification.
        if (row) this.notify(this.unlockListeners, listener => listener(row));
      }
    }
    await this.acknowledgePresentation();
    return receipt;
  }

  reportError(message: string): void { this.refresh("error", message); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeUnlocked(listener: (achievement: CompletedAchievementPresentation) => void): () => void {
    this.unlockListeners.add(listener);
    return () => { this.unlockListeners.delete(listener); };
  }

  private refresh(status: AchievementUiSnapshot["status"], error?: string): void {
    this.current = Object.freeze({ status, list: projectAchievementList(this.catalog, this.checkpoint?.ledger ?? emptyLedger),
      ...(error ? { error } : {}) });
    this.notify(this.listeners, listener => listener());
  }

  private notify<T>(listeners: Set<T>, invoke: (listener: T) => void): void {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { invoke(listener); } catch { /* A detached or failed UI never undoes durable progress. */ }
    }
  }

  private async acknowledgePresentation(): Promise<void> {
    // Saving an acknowledgement may fail after the unlock itself committed. Keep that receipt
    // for the next call, without turning a successful unlock into a failed gameplay operation.
    try { await this.port?.drain(presentationConsumer, () => {}); } catch { /* Retry on next ready/submit. */ }
  }
}

let active: AchievementUiRuntime | undefined;
export function gameAchievements(): AchievementUiRuntime {
  return active ??= new AchievementUiRuntime(Capacitor.isNativePlatform()
    ? new CapacitorFileSaveStorageDriver(undefined, undefined, "achievements")
    : new IndexedDbSaveStorageDriver("house-of-chances-achievements"));
}

/** Content activation owns resolved media lifetimes; teardown must replace this with an empty list. */
export function installAchievementUiCatalog(entries: readonly AchievementPresentationEntry[]): void {
  gameAchievements().installCatalog(entries);
}
