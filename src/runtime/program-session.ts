import { capturePlayerSkills } from "../core/abilities/carryover";
import { gameReducer } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import type { ProgramFacts, ProgramRun } from "../core/flow/program";
import { advanceProgram, chooseProgram, claimProgramReward, clearProgramWrites, completeProgramMatch, confirmProgramNode, currentProgramNode, programMatchId, programTransitionTrace, programStartTrace, clearProgramStartTrace } from "../core/flow/program-engine";
import { recordMatchProgress } from "../persistence/boot";
import { projectProgramCheckpoint } from "./program-checkpoint";
import { CURRENT_GAME_VERSION, CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT, type LongTermSave, type RuntimeSave } from "../persistence/schema";
import type { SaveRepository } from "../persistence/repository";
import type { AutosaveController } from "../persistence/autosave";
import type { EncounterTelemetry } from "../telemetry/types";
import { createMatchFactBatch, type MatchFactBatch } from "../core/events";
import { MatchFactRuntime } from "./match-fact-runtime";
import { matchPublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import type { RuntimeEventHub } from "./public-event-hub";
import { createProgramLifecycleBatch, publishProgramLifecycle, type ProgramLifecycleChange } from "./program-events";
import { PendingMatchFacts } from "./pending-match-facts";

export function programSnapshot(run: ProgramRun, match: MatchState | null = null): RuntimeSave {
  return { format: RUNTIME_SAVE_FORMAT, schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION, gameVersion: CURRENT_GAME_VERSION,
    updatedAt: new Date().toISOString(), activeProgram: run, activeMatch: match };
}

/** Owns every production flow and its table. State is published after durable transitions. */
export class ProgramSession {
  readonly events = new MatchFactRuntime();
  private current: RuntimeSave | null = null;
  private durableMatch: MatchState | null = null;
  private readonly pendingMatchFacts = new PendingMatchFacts();
  private pending: Promise<void> = Promise.resolve();
  private attachment = 0;
  private effectsRevision = 0;
  constructor(private readonly repository: SaveRepository, private readonly saves: { get(): LongTermSave; set(save: LongTermSave): void },
    private readonly telemetry?: EncounterTelemetry, private readonly isDebugEnabled: () => boolean = () => false,
    private readonly publicEvents?: RuntimeEventHub, private readonly publicScopes: PublicEventScopes = {}) {}
  get snapshot(): RuntimeSave | null { return this.current; }
  /** Counts only program-owned durable effects, not unrelated deck/settings writes. */
  get durableEffectsRevision(): number { return this.effectsRevision; }
  get run(): ProgramRun | null { return this.current?.activeProgram ?? null; }
  get match(): MatchState | null { return this.current?.activeMatch ?? null; }
  closingPublicEvents() {
    const run = this.run;
    return run ? [createProgramLifecycleBatch(this.publicScopes, { id: run.id, definitionId: run.definition.id,
      nodeId: run.cursor, visitIndex: run.visitIndex, status: run.status }, [
      { type: "node-left", nodeId: run.cursor, visitIndex: run.visitIndex, nodeType: currentProgramNode(run).type },
      { type: "abandoned", reason: "game-stopped" }], "runtime-closed", this.facts)] : [];
  }
  /** Adopt a checkpoint already committed atomically by a legal story command. */
  adoptCheckpoint(snapshot: RuntimeSave | null): void {
    if (snapshot && !snapshot.activeProgram) throw new Error("剧情命令不能把声明式流程替换为其他运行时");
    if (snapshot?.activeProgram && this.run && snapshot.activeProgram.id !== this.run.id) throw new Error("剧情命令所属流程已改变");
    this.current = snapshot; this.durableMatch = snapshot?.activeMatch ?? null; this.pendingMatchFacts.clear(); this.attachment++; this.effectsRevision++;
  }
  get node() { return this.run ? currentProgramNode(this.run) : undefined; }
  get facts(): ProgramFacts {
    const save = this.saves.get();
    return { defeated: save.defeats.map(item => item.opponentId), completedFlows: [...new Set([...(save.completedFlows ?? []), ...(save.completedChallenges ?? [])])] };
  }
  isCurrent(run: ProgramRun): boolean { return this.run === run; }
  flush = (): Promise<void> => this.pending;
  private commit(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.catch(() => undefined).then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  restore(snapshot: RuntimeSave): void {
    if (!snapshot.activeProgram) throw new Error("此运行时不是声明式流程，请重新开始牌局");
    this.attachment++;
    this.current = snapshot;
    this.durableMatch = snapshot.activeMatch;
    this.pendingMatchFacts.clear();
    const run = this.run!, match = this.match;
    this.pending = this.pending.catch(() => undefined).then(async () => {
      this.lifecycle(run, [{ type: "restored", restored: true }], "restore");
      if (match) await this.deliverCommitted(createMatchFactBatch(undefined, match, { restored: true }), run);
    });
  }
  replace(snapshot: RuntimeSave): Promise<void> {
    return this.commit(async () => {
      await this.repository.saveRuntime(snapshot);
      this.pendingMatchFacts.clear();
      this.attachment++;
      this.current = snapshot;
      this.durableMatch = snapshot.activeMatch;
    });
  }
  private lifecycle(run: ProgramRun, changes: readonly ProgramLifecycleChange[], command: string): void {
    publishProgramLifecycle(this.publicEvents, this.publicScopes, { id: run.id, definitionId: run.definition.id,
      nodeId: run.cursor, visitIndex: run.visitIndex, status: run.status }, changes, command, this.facts);
  }
  private async publish(run: ProgramRun, match: MatchState | null = null, completedMatch?: MatchState,
    lifecycle?: { command: string; changes: readonly ProgramLifecycleChange[] }): Promise<void> {
    const previous = this.saves.get();
    const table = completedMatch ?? match;
    const batch = table ? createMatchFactBatch(this.durableMatch?.id === table.id ? this.durableMatch : undefined, table) : undefined;
    let save = completedMatch ? recordMatchProgress(previous, completedMatch) : previous;
    const materialized = projectProgramCheckpoint(save, run, match);
    save = materialized.longTerm;
    const durable = clearProgramWrites(run);
    let snapshot = materialized.runtime;
    if (batch) {
      const projected = this.events.project({ longTerm: save, runtime: snapshot }, batch);
      save = projected.longTerm;
      snapshot = projected.runtime;
    }
    const lifecycleChanges: readonly ProgramLifecycleChange[] = lifecycle ? [...lifecycle.changes,
      ...(durable.status === "finished" ? [{ type: durable.result === "abandoned" ? "abandoned" : "completed", result: durable.result,
        ...(durable.result === "abandoned" ? { reason: "declared-end" } : {}) }] : [])] : [];
    const checkpoint = { ...(batch ? { matchFacts: this.pendingMatchFacts.forCheckpoint(batch) } : {}), publicEvents: [
      ...(batch ? [matchPublicEventBatch(batch, { ...this.publicScopes, program: run.id })] : []),
      ...(lifecycle ? [createProgramLifecycleBatch(this.publicScopes, { id: run.id, definitionId: run.definition.id,
        nodeId: run.cursor, visitIndex: run.visitIndex, status: run.status }, lifecycleChanges, lifecycle.command, { defeated: save.defeats.map(item => item.opponentId) })] : [])
    ] };
    if (save !== previous || run.pendingWrites.length || durable.status === "finished") {
      await this.repository.commitMatchResult(save, snapshot, checkpoint);
      this.saves.set(save);
      if (save !== previous || run.pendingWrites.length) this.effectsRevision++;
    } else if (snapshot) await this.repository.saveRuntime(snapshot, checkpoint);
    this.current = snapshot;
    this.durableMatch = snapshot?.activeMatch ?? null;
    if (batch) this.pendingMatchFacts.committed(batch);
    // Withdrawal and acknowledgement can create facts outside table dispatch.
    // Publish them only after this owner transaction succeeds; the hub removes
    // occurrences already presented by the table before settlement.
    if (completedMatch && batch && this.publicEvents)
      this.publicEvents.publish("resolved", matchPublicEventBatch(batch, { ...this.publicScopes, program: run.id }));
    if (lifecycle) this.lifecycle(run, lifecycleChanges, lifecycle.command);
    if (batch) await this.deliverCommitted(batch, run);
  }
  begin(run: ProgramRun): Promise<void> {
    return this.commit(async () => {
      const initialTrace = programStartTrace(run), next = advanceProgram(run, this.facts);
      await this.publish(next, null, undefined, { command: "begin", changes: [{ type: "started" },
        ...(initialTrace.length ? initialTrace.map(item => ({ ...item })) : [{ type: "node-entered", nodeId: run.cursor, visitIndex: run.visitIndex, nodeType: currentProgramNode(run).type }]),
        ...(next === run ? [] : programTransitionTrace(next).map(item => ({ ...item })))] });
      clearProgramStartTrace(run); clearProgramStartTrace(next);
      this.attachment++;
    });
  }
  choose(optionId: string, expected: ProgramRun): Promise<void> {
    return this.commit(async () => {
      if (!this.isCurrent(expected)) throw new Error("流程已改变");
      const next = chooseProgram(expected, optionId, this.facts);
      await this.publish(next, null, undefined, { command: "choose", changes: programTransitionTrace(next).map(item => ({ ...item })) });
      this.attachment++;
    });
  }
  claim(rewardId: string): Promise<void> {
    return this.commit(async () => {
      if (!this.run) throw new Error("流程已结束");
      const before = this.run, next = claimProgramReward(before, rewardId, this.facts);
      if (next === before) return;
      await this.publish(next, null, undefined, { command: "claim", changes: programTransitionTrace(next).map(item => ({ ...item })) });
    });
  }
  confirm(): Promise<void> {
    const expected = this.run;
    return this.commit(async () => {
      if (!this.run) throw new Error("流程已结束");
      if (!expected || this.run.id !== expected.id || this.run.cursor !== expected.cursor || this.run.visitIndex !== expected.visitIndex) return;
      const next = confirmProgramNode(this.run, this.facts);
      await this.publish(next, null, undefined, { command: "confirm", changes: programTransitionTrace(next).map(item => ({ ...item })) });
      this.attachment++;
    });
  }
  abandon(): Promise<void> {
    return this.commit(async () => {
      const match = this.match, run = this.run;
      const batch = match ? createMatchFactBatch(this.durableMatch?.id === match.id ? this.durableMatch : undefined, match) : undefined;
      const previous = this.saves.get();
      const projected = batch ? this.events.project({ longTerm: previous, runtime: null }, batch) : { longTerm: previous, runtime: null };
      const changes: readonly ProgramLifecycleChange[] = run ? [{ type: "node-left", nodeId: run.cursor, visitIndex: run.visitIndex, nodeType: currentProgramNode(run).type }, { type: "abandoned" }] : [];
      const checkpoint = { ...(batch ? { matchFacts: this.pendingMatchFacts.forCheckpoint(batch) } : {}), publicEvents: [...(batch && run ? [matchPublicEventBatch(batch, { ...this.publicScopes, program: run.id })] : []),
        ...(run ? [createProgramLifecycleBatch(this.publicScopes, { id: run.id, definitionId: run.definition.id, nodeId: run.cursor,
          visitIndex: run.visitIndex, status: run.status }, changes, "abandon", this.facts)] : [])] };
      if (projected.longTerm !== previous) {
        await this.repository.commitMatchResult(projected.longTerm, null, checkpoint);
        this.saves.set(projected.longTerm);
        this.effectsRevision++;
      } else await this.repository.deleteRuntime(checkpoint);
      this.current = null;
      this.durableMatch = null;
      this.pendingMatchFacts.clear();
      this.attachment++;
      if (run) this.lifecycle(run, changes, "abandon");
      if (batch && run) await this.deliverCommitted(batch, run);
    });
  }
  /** Called only after the host has durably removed the complete runtime checkpoint. */
  runtimeClosed(): void {
    const run = this.run;
    this.current = null; this.durableMatch = null; this.pendingMatchFacts.clear(); this.attachment++;
    if (run) this.lifecycle(run, [{ type: "node-left", nodeId: run.cursor, visitIndex: run.visitIndex, nodeType: currentProgramNode(run).type },
      { type: "abandoned", reason: "game-stopped" }], "runtime-closed");
  }
  private async deliverCommitted(batch: MatchFactBatch, run: ProgramRun): Promise<void> {
    const match = batch.after;
    const receiptIndex = run.results.findIndex(item => item.id === match.id);
    const receipt = run.results[receiptIndex];
    const flow = { id: run.id, definition: run.definition,
      encounter: Object.freeze({ nodeId: receipt?.nodeId ?? run.cursor, matchId: match.id }),
      encounterIndex: receiptIndex >= 0 ? receiptIndex + 1 : run.results.length + 1 };
    const debugUsed = this.isDebugEnabled();
    const observationFlow = Object.freeze({ ...flow, definition: Object.freeze({ id: run.definition.id }) });
    this.events.publish("committed", Object.freeze({ ...batch, context: Object.freeze({ flow: observationFlow, debugUsed }) }));
    if (this.publicEvents) this.publicEvents.publish("committed", matchPublicEventBatch(batch, { ...this.publicScopes, program: run.id }));
    try {
      // The existing telemetry port retains its payload and local-checkpoint semantics.
      await this.telemetry?.observe(match, flow, { restored: batch.restored, debugUsed });
    } catch { /* Telemetry must never alter a game transaction. */ }
  }
  async attach(run: ProgramRun, match: MatchState, source: MatchState = match): Promise<AutosaveController> {
    const expected = this.current, attachment = this.attachment;
    await this.commit(async () => {
      if (this.current !== expected || this.attachment !== attachment || !this.isCurrent(run)) throw new Error("牌局已改变");
      const node = currentProgramNode(run);
      if (node.type !== "match" || run.status !== "match" || match.id !== programMatchId(run) || match.opponentId !== node.opponentId)
        throw new Error("牌局与流程节点不一致");
      if (this.match && this.match !== source) throw new Error("牌局已改变");
      const reattached = this.match === match && this.durableMatch === match;
      if (!reattached) await this.publish({ ...run, resources: null }, match);
      this.attachment++;
      if (reattached) await this.deliverCommitted(createMatchFactBatch(undefined, match, { restored: true }), run);
    });
    return this.handle(match.id, this.attachment);
  }
  completeMatch(withdraw = false): Promise<void> {
    return this.commit(async () => {
      const run = this.run, source = this.match;
      if (!run || !source) return;
      if (withdraw && (source.status !== "active" || source.playerSkills.drawOffer)) throw new Error("请先完成技能选牌，再离开本场");
      const match = withdraw ? gameReducer(source, { type: "ESCAPE_MATCH" }) : source;
      const next = completeProgramMatch(run, match, this.facts, withdraw ? capturePlayerSkills(source) : undefined);
      await this.publish(next, null, next.results.find(receipt => receipt.id === match.id)!.match,
        { command: withdraw ? "withdraw" : "complete-match", changes: programTransitionTrace(next).map(item => ({ ...item })) });
      this.attachment++;
    });
  }
  private handle(matchId: string, attachment: number): AutosaveController {
    let lastFactBatch: MatchFactBatch | undefined;
    const getState = (): MatchState => {
      if (!this.match || this.match.id !== matchId || this.attachment !== attachment) throw new Error("牌局已结束");
      return this.match;
    };
    return {
      factEvents: this.events,
      getLastFactBatch: () => lastFactBatch,
      getState, getSave: this.saves.get, flush: this.flush,
      updateProgress: update => this.commit(async () => {
        getState();
        const save = this.saves.get(), next = update(save);
        if (next !== save) { await this.repository.saveLongTerm(next); this.saves.set(next); }
      }),
      updateSave: save => {
        getState();
        this.pending = this.pending.catch(() => undefined).then(async () => { getState(); await this.repository.saveLongTerm(save); this.saves.set(save); });
        void this.pending.catch(() => undefined);
      },
      dispatch: action => {
        const before = getState();
        if (action.type === "ACK_MATCH_RESULT") return before;
        const next = gameReducer(before, action);
        if (before === next) return before;
        const batch = createMatchFactBatch(before, next);
        this.pendingMatchFacts.retain(batch);
        lastFactBatch = batch;
        const snapshot = { ...this.current!, updatedAt: new Date().toISOString(), activeMatch: next };
        this.current = snapshot;
        this.pending = this.pending.catch(() => undefined).then(async () => {
          getState();
          const committedBatch = createMatchFactBatch(this.durableMatch?.id === next.id ? this.durableMatch : undefined, next);
          const previous = this.saves.get();
          const projected = this.events.project({ longTerm: previous, runtime: snapshot }, committedBatch);
          const context = { matchFacts: this.pendingMatchFacts.forCheckpoint(committedBatch) };
          if (projected.longTerm !== previous) {
            await this.repository.commitMatchResult(projected.longTerm, projected.runtime, context);
            this.saves.set(projected.longTerm);
            this.effectsRevision++;
          } else if (projected.runtime) await this.repository.saveRuntime(projected.runtime, context);
          this.pendingMatchFacts.committed(committedBatch);
          this.durableMatch = next;
          await this.deliverCommitted(committedBatch, snapshot.activeProgram!);
        });
        void this.pending.catch(() => undefined);
        return next;
      }
    };
  }
  async dispose(): Promise<void> {
    try { await this.flush(); }
    finally { this.pendingMatchFacts.clear(); this.events.dispose(); }
  }
}
