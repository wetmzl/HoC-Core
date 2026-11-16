import { z } from "zod";
import { advanceAchievements, createAchievementLedger } from "../core/achievements/engine";
import { AchievementCheckpointSchema, createAchievementCheckpoint, projectAchievementCheckpoint,
  type AchievementCheckpoint, type AchievementCommitReceipt } from "../core/achievements/commit";
import { createGameplayAchievementState, GameplayAchievementStateSchema, observeGameplayAchievements,
  GAMEPLAY_ACHIEVEMENT_CONTRACT, type GameplayAchievementState, type GameplayAchievementObservation } from "../core/achievements/gameplay";
import type { AchievementLedger } from "../core/achievements/types";
import { createMatchFactBatch, type MatchFactBatch } from "../core/events";
import type { CheckpointSaveRepository, SaveCheckpointContext } from "../persistence/repository";
import type { RawSaveSnapshot } from "../persistence/storage-driver";
import type { LongTermSave, RuntimeSave } from "../persistence/schema";
import { characterDefeatCount } from "../persistence/character-defeats";
import type { AchievementUiRuntime } from "./achievement-ui";
import type { TelemetryClient } from "../telemetry/client";

export interface GameplayAchievementSave {
  readonly format: "hoc-gameplay-achievements";
  readonly schemaVersion: 1;
  readonly checkpoint: AchievementCheckpoint;
  readonly gameplay: GameplayAchievementState | null;
  readonly debugUsed: boolean;
}
const GameplayAchievementSaveSchema = z.object({ format: z.literal("hoc-gameplay-achievements"), schemaVersion: z.literal(1),
  checkpoint: AchievementCheckpointSchema, gameplay: GameplayAchievementStateSchema.nullable(), debugUsed: z.boolean() }).strict();
export function restoreGameplayAchievementSave(input: unknown): GameplayAchievementSave {
  return GameplayAchievementSaveSchema.parse(input) as GameplayAchievementSave;
}
const consumers = ["presentation", "telemetry"] as const;

/** A pure repository projector owns progress; listeners only publish already committed results. */
export class AchievementGameplayRuntime {
  private ready = false;
  private closed = false;
  private readonly releases: (() => void)[] = [];
  private drain?: Promise<void>;
  private drainAgain = false;
  constructor(private readonly dependencies: {
    repository: CheckpointSaveRepository;
    ui: AchievementUiRuntime;
    debugEnabled?: (save: LongTermSave) => boolean;
    telemetry?: () => Pick<TelemetryClient, "recordAchievementUnlocks"> | undefined;
    now?: () => string;
  }) {}

  async initialize(): Promise<void> {
    if (this.ready || this.closed) return;
    const { repository, ui } = this.dependencies;
    const snapshot = await repository.readSnapshot();
    let state: GameplayAchievementSave;
    if (snapshot.achievements != null) state = restoreGameplayAchievementSave(snapshot.achievements);
    else {
      // Preserve the previously independent checkpoint, without replaying an old table.
      await ui.ready();
      const match = (snapshot.runtime as RuntimeSave | null)?.activeMatch;
      const gameplay = match ? createGameplayAchievementState(match) : null;
      if (gameplay && match) {
        const runtime = snapshot.runtime as RuntimeSave;
        const save = snapshot.longTerm as LongTermSave | null;
        gameplay.profileDefeats = save ? characterDefeatCount(save, match.opponentId) : 0;
        const program = runtime.activeProgram, flow = runtime.activeFlow;
        gameplay.flowId = program?.definition.id ?? flow?.definition.id ?? "";
        gameplay.nodeId = program?.cursor ?? flow?.encounter?.nodeId ?? "";
        gameplay.completedNodeIds = program ? program.results.filter(result => result.outcome === "victory").map(result => result.nodeId)
          : [...flow?.completedNodes ?? []];
      }
      state = { format: "hoc-gameplay-achievements", schemaVersion: 1,
        checkpoint: ui.checkpoint ?? createAchievementCheckpoint(createAchievementLedger(crypto.randomUUID())),
        gameplay, debugUsed: false };
      await repository.projectSnapshot(current => ({ ...current, achievements: state }), { achievementOnly: true, storyOnly: true });
    }
    this.releases.push(ui.connectCheckpoint(state.checkpoint, (after, before) => this.submit(after, before)));
    this.releases.push(repository.addCheckpointProjector((previous, next, context) => this.project(previous, next, context)));
    this.releases.push(repository.subscribeCheckpoints(committed => {
      if (this.closed || committed.achievements == null) return;
      try {
        const value = restoreGameplayAchievementSave(committed.achievements);
        ui.acceptCommittedCheckpoint(value.checkpoint);
        this.scheduleDrain();
      } catch { ui.reportError("无法读取成就记录，原记录已保留。"); }
    }));
    this.ready = true;
    // Existing completions are already permanent; restoring them never raises a toast.
    this.scheduleDrain();
  }

  private project(previous: RawSaveSnapshot, proposed: RawSaveSnapshot, context: SaveCheckpointContext): RawSaveSnapshot {
    if (!this.ready || this.closed || context.achievementOnly || proposed.achievements == null) return proposed;
    // A malformed additive record must not prevent otherwise valid gameplay saves.
    let saved: GameplayAchievementSave;
    try { saved = restoreGameplayAchievementSave(previous.achievements ?? proposed.achievements); } catch { return proposed; }
    const before = (previous.runtime as RuntimeSave | null)?.activeMatch;
    const runtime = proposed.runtime as RuntimeSave | null;
    const after = runtime?.activeMatch;
    const batches: MatchFactBatch[] = [...(context.matchFacts ?? [])].filter(batch => !batch.restored);
    if (after && !batches.some(batch => batch.after.id === after.id && batch.toIndex >= after.history.length)
      && (!before || before.id !== after.id || before.history.length < after.history.length)) {
      // This fallback supports hosts without action metadata. Exact effect conditions remain
      // unavailable without their production sidecars, rather than guessing from outer state.
      batches.push(createMatchFactBatch(before?.id === after.id ? before : undefined, after));
    }
    let ledger = saved.checkpoint.ledger;
    let gameplay = saved.gameplay;
    let debugUsed = saved.debugUsed;
    const save = previous.longTerm as LongTermSave | null;
    const nextSave = proposed.longTerm as LongTermSave | null;
    const at = this.dependencies.now?.() ?? new Date().toISOString();
    const consume = (observation: GameplayAchievementObservation, debug: boolean): void => {
      const boundary = observation.boundary;
      if (boundary?.phase === "begin" && ledger.windows[boundary.scope]?.id === observation.scopes[boundary.scope]) return;
      if (boundary?.phase === "end" && (ledger.windows[boundary.scope]?.status !== "active"
        || ledger.windows[boundary.scope]?.id !== observation.scopes[boundary.scope])) return;
      ledger = advanceAchievements(this.dependencies.ui.definitions, ledger, { ...observation,
        streamId: ledger.streamId, sequence: ledger.nextSequence, at, debugUsed: debug }, [GAMEPLAY_ACHIEVEMENT_CONTRACT]).ledger;
    };
    const closeWindows = (): void => {
      for (const scope of ["round", "match", "run"] as const) {
        const window = ledger.windows[scope];
        if (window?.status !== "active") continue;
        const scopes = Object.fromEntries(Object.entries(ledger.windows).map(([key, value]) => [key, value.id]));
        consume({ apiVersion: 1, topic: GAMEPLAY_ACHIEVEMENT_CONTRACT.topic, scopes,
          boundary: { scope, phase: "end", reason: "abandoned" }, values: {}, skillCards: {} }, debugUsed);
      }
    };
    for (const batch of batches) {
      if (gameplay && gameplay.matchId !== batch.after.id) { closeWindows(); gameplay = null; debugUsed = false; }
      const program = runtime?.activeProgram ?? (previous.runtime as RuntimeSave | null)?.activeProgram;
      const flow = runtime?.activeFlow ?? (previous.runtime as RuntimeSave | null)?.activeFlow;
      const metadata = {
        profileDefeats: save ? characterDefeatCount(save, batch.after.opponentId) : 0,
        ...(program ? { flowId: program.definition.id, nodeId: program.cursor,
          completedNodeIds: program.results.filter(result => result.outcome === "victory").map(result => result.nodeId) }
          : flow ? { flowId: flow.definition.id, nodeId: flow.encounter?.nodeId, completedNodeIds: flow.completedNodes } : {})
      };
      debugUsed ||= Boolean(nextSave && this.dependencies.debugEnabled?.(nextSave));
      const result = observeGameplayAchievements(gameplay ?? createGameplayAchievementState(), batch, metadata);
      gameplay = result.state;
      for (const observation of result.observations) consume(observation, debugUsed);
    }
    if (!after && before) { closeWindows(); gameplay = null; debugUsed = false; }
    if (ledger === saved.checkpoint.ledger && gameplay === saved.gameplay && debugUsed === saved.debugUsed) return proposed;
    const checkpoint = projectAchievementCheckpoint(saved.checkpoint, ledger, consumers).checkpoint;
    return { ...proposed, achievements: { ...saved, checkpoint, gameplay, debugUsed } satisfies GameplayAchievementSave };
  }

  private async submit(after: AchievementLedger, before?: AchievementLedger): Promise<AchievementCommitReceipt> {
    let receipt!: AchievementCommitReceipt;
    await this.dependencies.repository.projectSnapshot(current => {
      const saved = restoreGameplayAchievementSave(current.achievements);
      const projection = projectAchievementCheckpoint(saved.checkpoint, after, consumers, before);
      receipt = projection.receipt;
      return { ...current, achievements: { ...saved, checkpoint: projection.checkpoint } };
    }, { achievementOnly: true, storyOnly: true });
    return receipt;
  }

  private scheduleDrain(): void {
    if (this.closed) return;
    if (this.drain) { this.drainAgain = true; return; }
    this.drainAgain = false;
    this.drain = Promise.resolve().then(() => this.drainPending()).catch(() => {
      // Durable pending receipts remain available for the next checkpoint or startup.
    }).finally(() => {
      this.drain = undefined;
      if (this.drainAgain) this.scheduleDrain();
    });
  }
  private async drainPending(): Promise<void> {
    while (!this.closed) {
      const snapshot = await this.dependencies.repository.readSnapshot();
      if (snapshot.achievements == null) return;
      const saved = restoreGameplayAchievementSave(snapshot.achievements);
      const presentation = new Set(saved.checkpoint.pending.filter(item => item.requiredConsumers.includes("presentation")
        && !item.acknowledgedBy.includes("presentation")).map(item => item.id));
      const reports = saved.checkpoint.pending.filter(item => item.requiredConsumers.includes("telemetry") && !item.acknowledgedBy.includes("telemetry"));
      const telemetry = this.dependencies.telemetry?.();
      const reported = new Set<string>();
      if (telemetry && reports.length) {
        await telemetry.recordAchievementUnlocks(reports.map(item => ({ key: item.key, completion: item.completion, allowDebug: item.allowDebug })));
        reports.forEach(item => reported.add(item.id));
      }
      if (!presentation.size && !reported.size) return;
      await this.dependencies.repository.projectSnapshot(current => {
        const latest = restoreGameplayAchievementSave(current.achievements);
        const pending = latest.checkpoint.pending.map(item => ({ ...item,
          acknowledgedBy: [...new Set([...item.acknowledgedBy,
            ...(presentation.has(item.id) ? ["presentation"] : []), ...(reported.has(item.id) ? ["telemetry"] : [])])] }))
          .filter(item => !item.requiredConsumers.every(consumer => item.acknowledgedBy.includes(consumer)));
        return { ...current, achievements: { ...latest, checkpoint: { ...latest.checkpoint, pending } } };
      }, { achievementOnly: true, storyOnly: true });
    }
  }
  async flush(): Promise<void> { while (this.drain) await this.drain; }
  dispose(): void { this.closed = true; for (const release of this.releases.splice(0).reverse()) release(); }
}
