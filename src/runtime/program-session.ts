import { capturePlayerSkills } from "../core/abilities/carryover";
import { gameReducer } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import type { ProgramFacts, ProgramRun } from "../core/flow/program";
import { advanceProgram, chooseProgram, claimProgramReward, clearProgramWrites, completeProgramMatch, confirmProgramNode, currentProgramNode, programMatchId } from "../core/flow/program-engine";
import { acknowledgeMatchResult, recordMatchProgress } from "../persistence/boot";
import { grantDeclaredSkinUnlocks } from "../persistence/skin-unlocks";
import { CHARACTER_CATALOG } from "../content/characters/catalog";
import { CURRENT_GAME_VERSION, CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT, type LongTermSave, type RuntimeSave } from "../persistence/schema";
import type { SaveRepository } from "../persistence/repository";
import type { AutosaveController } from "../persistence/autosave";
import type { EncounterTelemetry } from "../telemetry/types";

export function programSnapshot(run: ProgramRun, match: MatchState | null = null): RuntimeSave {
  return { format: RUNTIME_SAVE_FORMAT, schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION, gameVersion: CURRENT_GAME_VERSION,
    updatedAt: new Date().toISOString(), activeProgram: run, activeMatch: match };
}

/** Owns every production flow and its table. State is published after durable transitions. */
export class ProgramSession {
  private current: RuntimeSave | null = null;
  private pending: Promise<void> = Promise.resolve();
  private attachment = 0;
  private effectsRevision = 0;
  constructor(private readonly repository: SaveRepository, private readonly saves: { get(): LongTermSave; set(save: LongTermSave): void },
    private readonly telemetry?: EncounterTelemetry) {}
  get snapshot(): RuntimeSave | null { return this.current; }
  /** Counts only program-owned durable effects, not unrelated deck/settings writes. */
  get durableEffectsRevision(): number { return this.effectsRevision; }
  get run(): ProgramRun | null { return this.current?.activeProgram ?? null; }
  get match(): MatchState | null { return this.current?.activeMatch ?? null; }
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
    if (this.match) void this.report(this.match, this.run!, true);
  }
  replace(snapshot: RuntimeSave): Promise<void> {
    return this.commit(async () => { await this.repository.saveRuntime(snapshot); this.attachment++; this.current = snapshot; });
  }
  private async publish(run: ProgramRun, match: MatchState | null = null, completedMatch?: MatchState): Promise<void> {
    const previous = this.saves.get();
    let save = completedMatch ? recordMatchProgress(previous, completedMatch) : previous;
    for (const write of run.pendingWrites) {
      if (write.type === "record-result") {
        const receipt = run.results.find(item => item.id === write.resultId);
        if (!receipt) throw new Error("结算结果不存在");
        save = acknowledgeMatchResult(save, receipt.match);
      } else {
        save = { ...save, completedFlows: [...new Set([...(save.completedFlows ?? []), write.flowId])],
          ...(write.legacyChallengeId ? { completedChallenges: [...new Set([...(save.completedChallenges ?? []), write.legacyChallengeId])] } : {}) };
      }
    }
    if (run.pendingWrites.length) save = grantDeclaredSkinUnlocks(save, CHARACTER_CATALOG);
    const durable = clearProgramWrites(run);
    const snapshot = durable.status === "finished" ? null : programSnapshot(durable, match);
    if (save !== previous || run.pendingWrites.length || durable.status === "finished") {
      await this.repository.commitMatchResult(save, snapshot);
      this.saves.set(save);
      if (save !== previous || run.pendingWrites.length) this.effectsRevision++;
    } else if (snapshot) await this.repository.saveRuntime(snapshot);
    this.current = snapshot;
  }
  begin(run: ProgramRun): Promise<void> {
    return this.commit(async () => { await this.publish(advanceProgram(run, this.facts)); this.attachment++; });
  }
  choose(optionId: string, expected: ProgramRun): Promise<void> {
    return this.commit(async () => {
      if (!this.isCurrent(expected)) throw new Error("流程已改变");
      await this.publish(chooseProgram(expected, optionId, this.facts));
      this.attachment++;
    });
  }
  claim(rewardId: string): Promise<void> {
    return this.commit(async () => {
      if (!this.run) throw new Error("流程已结束");
      await this.publish(claimProgramReward(this.run, rewardId, this.facts));
    });
  }
  confirm(): Promise<void> {
    return this.commit(async () => {
      if (!this.run) throw new Error("流程已结束");
      await this.publish(confirmProgramNode(this.run, this.facts));
      this.attachment++;
    });
  }
  abandon(): Promise<void> {
    return this.commit(async () => { await this.repository.deleteRuntime(); this.current = null; this.attachment++; });
  }
  private async report(match: MatchState, run: ProgramRun, restored = false): Promise<void> {
    try {
      const receiptIndex = run.results.findIndex(item => item.id === match.id);
      const receipt = run.results[receiptIndex];
      await this.telemetry?.observe(match, { id: run.id, definition: run.definition,
        encounter: { nodeId: receipt?.nodeId ?? run.cursor, matchId: match.id }, encounterIndex: receiptIndex >= 0 ? receiptIndex + 1 : run.results.length + 1 },
      { restored, debugUsed: Boolean(this.saves.get().settings.debugEngineEnabled) });
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
      if (this.match !== match) await this.publish({ ...run, resources: null }, match);
      this.attachment++;
      await this.report(match, run, Boolean(expected?.activeMatch));
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
      await this.publish(next, null, next.results.find(receipt => receipt.id === match.id)!.match);
      this.attachment++;
      await this.report(match, run);
    });
  }
  private handle(matchId: string, attachment: number): AutosaveController {
    const getState = (): MatchState => {
      if (!this.match || this.match.id !== matchId || this.attachment !== attachment) throw new Error("牌局已结束");
      return this.match;
    };
    return {
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
        const snapshot = { ...this.current!, updatedAt: new Date().toISOString(), activeMatch: next };
        this.current = snapshot;
        this.pending = this.pending.catch(() => undefined).then(async () => {
          getState(); await this.repository.saveRuntime(snapshot);
          await this.report(next, snapshot.activeProgram!);
        });
        void this.pending.catch(() => undefined);
        return next;
      }
    };
  }
}
