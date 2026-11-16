import { capturePlayerSkills } from "../core/abilities/carryover";
import { gameReducer } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { FlowRunSchema, type EncounterRewardKind, type FlowRun } from "../core/flow/schema";
import { claimFlowReward, pendingFlowRewards, flowEncounterPlan, finishFlowNode, startFlowNode, ownedFlowNode, flowOutcomeRoute, flowRecordsResult } from "../core/flow/reducer";
import { acknowledgeMatchResult } from "../persistence/boot";
import { recordCharacterDefeat } from "../persistence/character-defeats";
import { grantDeclaredSkinUnlocks } from "../persistence/skin-unlocks";
import { CHARACTER_CATALOG } from "../content/characters/catalog";
import type { AutosaveController } from "../persistence/autosave";
import type { SaveRepository } from "../persistence/repository";
import type { LongTermSave, RuntimeSave } from "../persistence/schema";
import type { EncounterPlan } from "./match-owner";
import type { EncounterTelemetry } from "../telemetry/types";
import { flowSnapshot, runtimeFlow, flowMemory, singleMatchFlow } from "./encounter-snapshot";
import { createMatchFactBatch, type MatchFactBatch } from "../core/events";
import { MatchFactRuntime } from "./match-fact-runtime";
import { matchPublicEventBatch, type PublicEventScopes } from "../core/events/public-events";
import type { RuntimeEventHub } from "./public-event-hub";
import { createProgramLifecycleBatch, publishProgramLifecycle, type ProgramLifecycleChange } from "./program-events";
import { PendingMatchFacts } from "./pending-match-facts";
export { challengeSnapshot } from "./encounter-snapshot";

const sameRun = (left: FlowRun, right: FlowRun): boolean => JSON.stringify(FlowRunSchema.parse(left)) === JSON.stringify(FlowRunSchema.parse(right));

/** One state owner and one ordered writer for the entire run, including its table. */
export class EncounterSession {
  readonly events = new MatchFactRuntime();
  private current: RuntimeSave | null = null;
  private durableMatch: MatchState | null = null;
  private readonly pendingMatchFacts = new PendingMatchFacts();
  private pending: Promise<void> = Promise.resolve();
  private attachment = 0;
  constructor(private readonly repository: SaveRepository, private readonly saves: {
    get(): LongTermSave;
    set(save: LongTermSave): void;
  }, private readonly telemetry?: EncounterTelemetry, private readonly isDebugEnabled: () => boolean = () => false,
    private readonly publicEvents?: RuntimeEventHub, private readonly publicScopes: PublicEventScopes = {}) {}

  get snapshot(): RuntimeSave | null { return this.current; }
  get match(): MatchState | null { return this.current?.activeMatch ?? null; }
  closingPublicEvents() {
    const run = this.run;
    return run ? [createProgramLifecycleBatch(this.publicScopes, { id: run.id, definitionId: run.definition.id,
      nodeId: run.encounter?.nodeId, visitIndex: run.encounterIndex, status: run.phase }, [
      ...(run.encounter ? [{ type: "node-left", nodeId: run.encounter.nodeId, visitIndex: run.encounterIndex }] : []),
      { type: "abandoned", reason: "game-stopped" }], "runtime-closed")] : [];
  }
  adoptCheckpoint(snapshot: RuntimeSave | null): void {
    const next = runtimeFlow(snapshot);
    if (snapshot && !next) throw new Error("剧情命令不能把牌局流程替换为其他运行时");
    if (next && this.run && next.id !== this.run.id) throw new Error("剧情命令所属流程已改变");
    this.current = snapshot; this.durableMatch = snapshot?.activeMatch ?? null; this.pendingMatchFacts.clear(); this.attachment++;
  }
  get run(): FlowRun | null { return runtimeFlow(this.current); }
  get node() {
    const run = this.run;
    return run && this.match ? ownedFlowNode(run.definition, run, this.match) : undefined;
  }
  get recordsResult(): boolean {
    const run = this.run, match = this.match;
    return Boolean(run && match && flowRecordsResult(run.definition, run, match));
  }
  get continues(): boolean {
    const run = this.run, match = this.match;
    const route = run && match ? flowOutcomeRoute(run.definition, run, match) : undefined;
    return Boolean(route && route.type !== "finish");
  }
  get escapeContinues(): boolean { return Boolean(this.node && this.node.routes.escaped.type !== "finish"); }
  isCurrent(run: FlowRun): boolean { const current = this.run; return Boolean(current && sameRun(current, run)); }
  flush = (): Promise<void> => this.pending;
  restore(snapshot: RuntimeSave): void {
    this.attachment++; this.current = snapshot;
    this.durableMatch = snapshot.activeMatch;
    this.pendingMatchFacts.clear();
    const run = runtimeFlow(snapshot), match = snapshot.activeMatch;
    if (run) this.pending = this.pending.catch(() => undefined).then(async () => {
      this.lifecycle(run, [{ type: "restored", restored: true }], "restore");
      if (match) await this.deliverCommitted(createMatchFactBatch(undefined, match, { restored: true }), run);
    });
  }
  private lifecycle(run: FlowRun, changes: readonly ProgramLifecycleChange[], command: string): void {
    publishProgramLifecycle(this.publicEvents, this.publicScopes, { id: run.id, definitionId: run.definition.id,
      nodeId: run.encounter?.nodeId, visitIndex: run.encounterIndex, status: run.phase }, changes, command);
  }
  private checkpoint(run: FlowRun, changes: readonly ProgramLifecycleChange[], command: string, batch?: MatchFactBatch) {
    return { ...(batch ? { matchFacts: this.pendingMatchFacts.forCheckpoint(batch) } : {}), publicEvents: [...(batch ? [matchPublicEventBatch(batch, { ...this.publicScopes, program: run.id })] : []),
      createProgramLifecycleBatch(this.publicScopes, { id: run.id, definitionId: run.definition.id,
        nodeId: run.encounter?.nodeId, visitIndex: run.encounterIndex, status: run.phase }, changes, command)] };
  }
  private async deliverCommitted(batch: MatchFactBatch, run: FlowRun, report = true): Promise<void> {
    const debugUsed = this.isDebugEnabled();
    const flow = Object.freeze({ id: run.id, definition: Object.freeze({ id: run.definition.id }),
      encounter: run.encounter ? Object.freeze({ nodeId: run.encounter.nodeId, matchId: run.encounter.matchId }) : null,
      encounterIndex: run.encounterIndex });
    this.events.publish("committed", Object.freeze({ ...batch, context: Object.freeze({ flow, debugUsed }) }));
    if (this.publicEvents) this.publicEvents.publish("committed", matchPublicEventBatch(batch, { ...this.publicScopes, program: run.id }));
    if (!report) return;
    try {
      await this.telemetry?.observe(batch.after, run, { restored: batch.restored, debugUsed });
    }
    catch { /* Telemetry storage/network must never change a game transaction's outcome. */ }
  }

  /** Commands publish their new state only after the complete transaction succeeds. */
  private commit(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.catch(() => undefined).then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  replace(snapshot: RuntimeSave): Promise<void> {
    return this.commit(async () => {
      await this.repository.saveRuntime(snapshot);
      this.pendingMatchFacts.clear();
      this.attachment++; this.current = snapshot; this.durableMatch = snapshot.activeMatch;
    });
  }
  begin(run: FlowRun): Promise<void> {
    return this.commit(async () => {
      const snapshot = flowSnapshot(run, null);
      await this.repository.saveRuntime(snapshot, this.checkpoint(run, [{ type: "started" }], "begin"));
      this.attachment++; this.current = snapshot; this.durableMatch = null;
      this.lifecycle(run, [{ type: "started" }], "begin");
    });
  }
  abandon(): Promise<void> {
    return this.commit(async () => {
      const run = this.run, match = this.match;
      const batch = match ? createMatchFactBatch(this.durableMatch?.id === match.id ? this.durableMatch : undefined, match) : undefined;
      const previous = this.saves.get();
      const projected = batch ? this.events.project({ longTerm: previous, runtime: null }, batch) : { longTerm: previous, runtime: null };
      const changes: readonly ProgramLifecycleChange[] = [...(run?.encounter ? [{ type: "node-left", nodeId: run.encounter.nodeId, visitIndex: run.encounterIndex }] : []), { type: "abandoned" }];
      const checkpoint = run ? this.checkpoint(run, changes, "abandon", batch) : undefined;
      if (projected.longTerm !== previous) {
        await this.repository.commitMatchResult(projected.longTerm, null, checkpoint);
        this.saves.set(projected.longTerm);
      } else await this.repository.deleteRuntime(checkpoint);
      this.attachment++; this.current = null; this.durableMatch = null;
      this.pendingMatchFacts.clear();
      if (run) this.lifecycle(run, changes, "abandon");
      if (run && batch) await this.deliverCommitted(batch, run, match?.status === "finished");
    });
  }
  /** The host has already durably cleared this runtime; do not write a second checkpoint. */
  runtimeClosed(): void {
    const run = this.run;
    this.current = null; this.durableMatch = null; this.pendingMatchFacts.clear(); this.attachment++;
    if (run) this.lifecycle(run, [...(run.encounter ? [{ type: "node-left", nodeId: run.encounter.nodeId, visitIndex: run.encounterIndex }] : []),
      { type: "abandoned", reason: "game-stopped" }], "runtime-closed");
  }
  prepare(nodeId: string): { run: FlowRun; plan: EncounterPlan } | null {
    const run = this.run;
    if (!run) return null;
    const progress = startFlowNode(run.definition, run, nodeId);
    if (progress === run) return null;
    const next = { ...run, ...progress, nextNodeId: progress.nextNodeId };
    return { run: next, plan: flowEncounterPlan(next.definition, next, {
      gun: run.playerGun, skills: flowMemory(this.current).player ?? undefined, comparisonBonus: next.playerComparisonBonus
    }) };
  }
  async attach(run: FlowRun | undefined, match: MatchState, source: MatchState = match): Promise<AutosaveController> {
    // Undefined remains supported for callers attaching an existing ordinary table.
    const opening = run ?? this.run ?? singleMatchFlow(match);
    if (!ownedFlowNode(opening.definition, opening, match)) throw new Error("非法流程牌局");
    const expected = this.current, attachment = this.attachment;
    await this.commit(async () => {
      const current = this.run;
      if (this.current !== expected || this.attachment !== attachment) throw new Error("牌局已改变");
      if (current) {
        if (current.phase === "selection") {
          const prepared = this.prepare(opening.encounter!.nodeId);
          if (!prepared || !sameRun(prepared.run, opening)) throw new Error("牌局已改变");
        } else if (!this.isCurrent(opening) || this.match !== source) throw new Error("牌局已改变");
      } else if (run) throw new Error("牌局已改变");
      // Reattaching an unchanged durable table must work while storage is unavailable.
      const reattached = this.match === match && this.durableMatch === match;
      const batch = createMatchFactBatch(this.durableMatch?.id === match.id ? this.durableMatch : undefined, match, { restored: reattached });
      const changes: readonly ProgramLifecycleChange[] = !current || current.phase === "selection" ? [
        ...(!current ? [{ type: "started" }] : [{ type: "choice-selected", choiceId: opening.encounter!.nodeId }]),
        { type: "node-entered", nodeId: opening.encounter!.nodeId, visitIndex: opening.encounterIndex }] : [];
      const checkpoint = this.checkpoint(opening, changes, "attach", batch);
      if (!reattached) {
        const previous = this.saves.get();
        const projected = this.events.project({ longTerm: previous, runtime: flowSnapshot(opening, match) }, batch);
        if (projected.longTerm !== previous) {
          await this.repository.commitMatchResult(projected.longTerm, projected.runtime, checkpoint);
          this.saves.set(projected.longTerm);
        } else if (projected.runtime) await this.repository.saveRuntime(projected.runtime, checkpoint);
        this.current = projected.runtime;
        this.durableMatch = match;
        this.pendingMatchFacts.committed(batch);
      }
      this.attachment++;
      if (!reattached && changes.length) this.lifecycle(opening, changes, "attach");
      await this.deliverCommitted(batch, opening);
    });
    return this.matchHandle(match.id, this.attachment);
  }
  private matchHandle(matchId: string, attachment: number): AutosaveController {
    let lastFactBatch: MatchFactBatch | undefined;
    const getState = (): MatchState => {
      const match = this.match;
      if (!match || match.id !== matchId || this.attachment !== attachment) throw new Error("牌局已结束");
      return match;
    };
    return {
      factEvents: this.events,
      getLastFactBatch: () => lastFactBatch,
      getState, getSave: this.saves.get, flush: this.flush,
      updateProgress: update => this.commit(async () => {
        getState();
        const current = this.saves.get();
        const next = update(current);
        if (next === current) return;
        await this.repository.saveLongTerm(next);
        this.saves.set(next);
      }),
      updateSave: save => {
        getState();
        this.saves.set(save);
        this.pending = this.pending.catch(() => undefined).then(async () => {
          getState();
          await this.repository.saveLongTerm(save);
        });
        void this.pending.catch(() => undefined);
      },
      dispatch: action => {
        const before = getState();
        // Acknowledgement belongs to the run transaction, never to table autosave.
        if (action.type === "ACK_MATCH_RESULT") return before;
        const next = gameReducer(before, action);
        if (next === before) return before;
        const batch = createMatchFactBatch(before, next);
        this.pendingMatchFacts.retain(batch);
        lastFactBatch = batch;
        const snapshot = { ...this.current!, updatedAt: new Date().toISOString(), activeMatch: next };
        this.current = snapshot;
        this.pending = this.pending.catch(() => undefined).then(async () => {
          getState();
          // A failed earlier write leaves its facts pending. The next durable
          // checkpoint includes all accepted history since the last success.
          const durableBatch = createMatchFactBatch(this.durableMatch?.id === next.id ? this.durableMatch : undefined, next);
          const previous = this.saves.get();
          const projected = this.events.project({ longTerm: previous, runtime: snapshot }, durableBatch);
          const context = { matchFacts: this.pendingMatchFacts.forCheckpoint(durableBatch) };
          if (projected.longTerm !== previous) {
            await this.repository.commitMatchResult(projected.longTerm, projected.runtime, context);
            this.saves.set(projected.longTerm);
          } else if (projected.runtime) await this.repository.saveRuntime(projected.runtime, context);
          this.pendingMatchFacts.committed(durableBatch);
          if (this.current === snapshot) this.current = projected.runtime;
          this.durableMatch = next;
          const run = runtimeFlow(snapshot);
          if (run) await this.deliverCommitted(durableBatch, run);
        });
        void this.pending.catch(() => undefined);
        return next;
      }
    };
  }
  claim(kind: EncounterRewardKind): Promise<void> {
    return this.commit(async () => {
      const run = this.run, match = this.match;
      if (!run || !match) throw new Error("当前流程已结束");
      const next = claimFlowReward(run, match, kind);
      if (next.run === run) return;
      const batch = createMatchFactBatch(this.durableMatch?.id === match.id ? this.durableMatch : undefined, next.match);
      const previous = this.saves.get();
      const projected = this.events.project({ longTerm: previous, runtime: flowSnapshot(next.run, next.match) }, batch);
      const checkpoint = this.checkpoint(next.run, [{ type: "reward-claimed", rewardId: kind }], "claim", batch);
      if (projected.longTerm !== previous) {
        await this.repository.commitMatchResult(projected.longTerm, projected.runtime, checkpoint);
        this.saves.set(projected.longTerm);
      } else if (projected.runtime) await this.repository.saveRuntime(projected.runtime, checkpoint);
      this.current = projected.runtime;
      this.durableMatch = next.match;
      this.pendingMatchFacts.committed(batch);
      this.lifecycle(next.run, [{ type: "reward-claimed", rewardId: kind }], "claim");
      await this.deliverCommitted(batch, next.run, false);
    });
  }
  settle(withdraw = false): Promise<void> {
    return this.commit(async () => {
      const run = this.run, match = this.match;
      if (!run || !match) throw new Error("当前流程已结束");
      if (withdraw && (!this.escapeContinues || match.status !== "active" || match.playerSkills.drawOffer))
        throw new Error("请先完成技能选牌，再离开本场");
      if (!withdraw && pendingFlowRewards(run, match).length) throw new Error("请先领取本场奖励");
      const acknowledged = gameReducer(withdraw ? gameReducer(match, { type: "ESCAPE_MATCH" }) : match, { type: "ACK_MATCH_RESULT" });
      const progress = finishFlowNode(run.definition, run, acknowledged);
      if (progress === run || progress.phase === "encounter") throw new Error("本场结算尚未完成");
      const next: FlowRun = { ...run, ...progress, nextNodeId: progress.nextNodeId, playerGun: acknowledged.roulette.player };
      let snapshot = next.phase === "finished" ? null : flowSnapshot(next, null, { player: capturePlayerSkills(withdraw ? match : acknowledged) });
      const records = flowRecordsResult(run.definition, run, acknowledged);
      const completionId = next.phase === "finished" && next.result === "victory" ? run.definition.completionId : undefined;
      const counted = records ? acknowledgeMatchResult(this.saves.get(), acknowledged) : recordCharacterDefeat(this.saves.get(), acknowledged);
      const completed = completionId ? { ...counted,
          completedChallenges: [...new Set([...(counted.completedChallenges ?? []), completionId])] } : counted;
      const batch = createMatchFactBatch(this.durableMatch?.id === match.id ? this.durableMatch : undefined, acknowledged);
      const projected = this.events.project({ longTerm: grantDeclaredSkinUnlocks(completed, CHARACTER_CATALOG), runtime: snapshot }, batch);
      const save = projected.longTerm;
      snapshot = projected.runtime;
      const changes: readonly ProgramLifecycleChange[] = [{ type: "node-left", nodeId: run.encounter!.nodeId, visitIndex: run.encounterIndex },
        ...(next.phase === "finished" ? [{ type: next.result === "abandoned" ? "abandoned" : "completed", result: next.result,
          ...(next.result === "abandoned" ? { reason: "declared-end" } : {}) }] : [])];
      const checkpoint = this.checkpoint(next, changes, withdraw ? "withdraw" : "settle", batch);
      if (records || completionId || save !== this.saves.get()) {
        await this.repository.commitMatchResult(save, snapshot, checkpoint);
        this.saves.set(save);
      } else if (snapshot) await this.repository.saveRuntime(snapshot, checkpoint);
      else await this.repository.deleteRuntime(checkpoint);
      // A failed withdrawal must remain playable and must not publish a fictitious escape.
      // Guards are included even when their node deliberately writes no local history.
      this.attachment++;
      this.current = snapshot;
      this.durableMatch = null;
      this.pendingMatchFacts.committed(batch);
      if (this.publicEvents) this.publicEvents.publish("resolved", matchPublicEventBatch(batch, { ...this.publicScopes, program: run.id }));
      this.lifecycle(next, changes, withdraw ? "withdraw" : "settle");
      await this.deliverCommitted(batch, run);
    });
  }
  async dispose(): Promise<void> {
    try { await this.flush(); }
    finally { this.pendingMatchFacts.clear(); this.events.dispose(); }
  }
}
