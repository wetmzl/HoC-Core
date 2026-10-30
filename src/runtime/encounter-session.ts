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
export { challengeSnapshot } from "./encounter-snapshot";

const sameRun = (left: FlowRun, right: FlowRun): boolean => JSON.stringify(FlowRunSchema.parse(left)) === JSON.stringify(FlowRunSchema.parse(right));

/** One state owner and one ordered writer for the entire run, including its table. */
export class EncounterSession {
  private current: RuntimeSave | null = null;
  private pending: Promise<void> = Promise.resolve();
  private attachment = 0;
  constructor(private readonly repository: SaveRepository, private readonly saves: {
    get(): LongTermSave;
    set(save: LongTermSave): void;
  }, private readonly telemetry?: EncounterTelemetry) {}

  get snapshot(): RuntimeSave | null { return this.current; }
  get match(): MatchState | null { return this.current?.activeMatch ?? null; }
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
    const run = runtimeFlow(snapshot), match = snapshot.activeMatch;
    if (run && match) this.pending = this.pending.catch(() => undefined).then(() => this.report(match, run, true));
  }
  private async report(match: MatchState, run: FlowRun, restored = false): Promise<void> {
    try { await this.telemetry?.observe(match, run, { restored, debugUsed: Boolean(this.saves.get().settings.debugEngineEnabled) }); }
    catch { /* Telemetry storage/network must never change a game transaction's outcome. */ }
  }

  /** Commands publish their new state only after the complete transaction succeeds. */
  private commit(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.catch(() => undefined).then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  replace(snapshot: RuntimeSave): Promise<void> {
    return this.commit(async () => { await this.repository.saveRuntime(snapshot); this.attachment++; this.current = snapshot; });
  }
  begin(run: FlowRun): Promise<void> { return this.replace(flowSnapshot(run, null)); }
  abandon(): Promise<void> {
    return this.commit(async () => {
      if (this.run && this.match?.status === "finished") await this.report(this.match, this.run);
      await this.repository.deleteRuntime(); this.attachment++; this.current = null;
    });
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
      if (this.match !== match) {
        const snapshot = flowSnapshot(opening, match);
        await this.repository.saveRuntime(snapshot);
        this.current = snapshot;
      }
      this.attachment++;
      await this.report(match, opening, expected?.activeMatch?.id === match.id);
    });
    return this.matchHandle(match.id, this.attachment);
  }
  private matchHandle(matchId: string, attachment: number): AutosaveController {
    const getState = (): MatchState => {
      const match = this.match;
      if (!match || match.id !== matchId || this.attachment !== attachment) throw new Error("牌局已结束");
      return match;
    };
    return {
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
        const snapshot = { ...this.current!, updatedAt: new Date().toISOString(), activeMatch: next };
        this.current = snapshot;
        this.pending = this.pending.catch(() => undefined).then(async () => {
          getState();
          await this.repository.saveRuntime(snapshot);
          const run = runtimeFlow(snapshot);
          if (run) await this.report(next, run);
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
      const snapshot = flowSnapshot(next.run, next.match);
      await this.repository.saveRuntime(snapshot);
      this.current = snapshot;
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
      const snapshot = next.phase === "finished" ? null : flowSnapshot(next, null, { player: capturePlayerSkills(withdraw ? match : acknowledged) });
      const records = flowRecordsResult(run.definition, run, acknowledged);
      const completionId = next.phase === "finished" && next.result === "victory" ? run.definition.completionId : undefined;
      const counted = records ? acknowledgeMatchResult(this.saves.get(), acknowledged) : recordCharacterDefeat(this.saves.get(), acknowledged);
      const completed = completionId ? { ...counted,
          completedChallenges: [...new Set([...(counted.completedChallenges ?? []), completionId])] } : counted;
      const save = grantDeclaredSkinUnlocks(completed, CHARACTER_CATALOG);
      if (records || completionId || save !== this.saves.get()) {
        await this.repository.commitMatchResult(save, snapshot);
        this.saves.set(save);
      } else if (snapshot) await this.repository.saveRuntime(snapshot);
      else await this.repository.deleteRuntime();
      // A failed withdrawal must remain playable and must not publish a fictitious escape.
      // Guards are included even when their node deliberately writes no local history.
      await this.report(acknowledged, run);
      this.attachment++;
      this.current = snapshot;
    });
  }
}
