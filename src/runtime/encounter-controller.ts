import { ProgramSession } from "./program-session";
import type { MatchOwner } from "./match-owner";
import type { EncounterTablePresentation } from "../presentation/encounter-table";
import { loadCharacter, type CharacterDefinition } from "../content/characters";
import { characterInvitation } from "../content/characters/invitations";
import { invitationProgram, pendingInvitationEntries } from "../content/encounters";
import type { MainMenuAction } from "../presentation/main-menu-actions";
import type { ProfileInvitation } from "../presentation/profile-controller";
import { flowBackgrounds, renderFlowSkillComparison } from "../screens/flow-view";
import { legacyProgramView, renderProgramChoice, renderProgramPresentation } from "../screens/program-view";
import type { FlowDefinition } from "../core/flow/schema";
import type { ProgramDefinition, ProgramRun } from "../core/flow/program";
import { availableProgramRewards, chooseProgram, createProgramRun, currentProgramNode, evaluateProgramCondition, programChoiceOptions, programMatchId, programMatchInit, programResult, programRewardClaimed } from "../core/flow/program-engine";
import { compileLegacyFlow } from "../core/flow/program-templates";
import { resolveMatchInit } from "../core/flow/initialization";
import { createMatch } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { escapeHtml, secureSeed } from "../presentation/view-helpers";
import type { LongTermSave, RuntimeSave } from "../persistence/schema";
import type { PersistenceService } from "../persistence/save-service";
import type { MatchSession } from "./match-session";
import type { RuntimeScreenLoader } from "./contracts";
import { gameAudio } from "../audio/game-audio";
import { standaloneCharacter } from "./standalone-encounter";
import type { SummaryDestination, SummarySettlement } from "../screens/summary-view";
import "../screens/challenge.css";
import "../lobby-screen.css";

export interface EncounterControllerDependencies {
  readonly root: HTMLDivElement;
  save: LongTermSave;
  readonly repository: PersistenceService;
  readonly session: MatchSession;
  readonly telemetry?: import("../telemetry/types").EncounterTelemetry;
  navigateScreen(loader: RuntimeScreenLoader): Promise<void>;
  renderLobby(): Promise<void>;
  showHistory(): Promise<void>;
  renderSummary(match: MatchState, settlement: SummarySettlement): void;
  openProfile(id: string, invitation?: (character: CharacterDefinition) => ProfileInvitation, isCurrent?: () => boolean): Promise<void>;
  invalidateProfile(): void;
}

/** Every invitation starts a program before any table is initialized. */
export class EncounterController {
  private sessionState: ProgramSession | undefined;
  private get state(): ProgramSession {
    return this.sessionState ??= new ProgramSession(this.deps.repository, { get: () => this.deps.save, set: save => { this.deps.save = save; } }, this.deps.telemetry);
  }
  private get run(): ProgramRun | null { return this.state.run; }
  get tablePresentation(): EncounterTablePresentation | undefined {
    const node = this.state.node, presentation = node?.type === "match" ? node.presentation : undefined;
    return presentation ? { titleSuffix: presentation.tableTitle ?? "对局", ...(presentation.exit ? { exit: { label: presentation.exit.label, title: presentation.exit.title } } : {}) } : undefined;
  }
  private busy = false;
  private disposed = false;
  private paused = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly deps: EncounterControllerDependencies) {}
  setPaused = (paused: boolean): void => { this.paused = paused; };
  flush = async (): Promise<void> => {
    // Result callbacks may enqueue a transition after the table attachment resolves.
    for (;;) {
      const pending = this.pending;
      await pending.catch(() => undefined); await this.state.flush(); await Promise.resolve();
      if (pending === this.pending) return;
    }
  };
  dispose = async (): Promise<void> => { this.disposed = true; this.deps.invalidateProfile(); await this.flush(); };
  private owner(run: ProgramRun): MatchOwner {
    return {
      attach: (match, source) => this.state.attach(this.state.run ?? run, match, source),
      character: standaloneCharacter,
      summary: match => {
        // A result transition can arrive while a restored table is being attached.
        void this.pending.catch(() => undefined).then(() => this.act(async () => {
          if (this.run?.id !== run.id || this.state.match?.id !== match.id) return;
          await this.state.completeMatch();
          this.deps.session.clearActiveMatch();
          await this.showCurrent();
        })).catch(error => {
          if (!this.disposed && this.state.match) this.deps.renderSummary(this.state.match, { recordResult: false,
            actions: [{ destination: "continue", label: "重试结算", primary: true }] });
          this.report(error);
        });
      }
    };
  }
  private act(operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed || this.paused) return Promise.resolve();
    this.busy = true;
    const buttons = [...this.deps.root.querySelectorAll<HTMLButtonElement>("button")].map(button => ({ button, disabled: button.disabled }));
    buttons.forEach(({ button }) => button.disabled = true);
    this.pending = operation().catch(error => {
      // Rollback may replace the profile dialog; report against the current screen.
      this.report(error);
      throw error;
    }).finally(() => { buttons.forEach(({ button, disabled }) => { if (button.isConnected) button.disabled = disabled; }); this.busy = false; });
    return this.pending;
  }
  private report = (error: unknown): void => {
    const status = this.deps.root.querySelector<HTMLElement>('[open] [data-encounter-status], .summary-shell [data-encounter-status], .challenge-selection [data-encounter-status], .table-actions [data-encounter-status]');
    if (status) status.textContent = error instanceof Error ? error.message : "保存失败，请重试";
  };
  private mount = async (html: string, bind: () => void): Promise<void> => {
    this.deps.invalidateProfile();
    await this.deps.navigateScreen(async () => ({ mount: async (_context, signal) => {
      if (!signal.aborted && !this.disposed) { this.deps.root.innerHTML = html; bind(); }
      return { dispose() {} };
    } }));
    gameAudio.stopHeartbeat(); gameAudio.setBgmScene("lobby");
  };
  menuEntries = (): MainMenuAction[] => pendingInvitationEntries(this.deps.save).map(({ id, character, progress, description, label, subtitle }) => ({
    id: `flow:${id}`, slot: "main-menu.secondary", className: "lobby-boss-entry", label, description,
    portraitEntry: { character, ...progress, label, subtitle }, activate: () => this.deps.openProfile(character.id, character => this.invitation(character, id))
  }));
  invitation = (character: CharacterDefinition, challengeId?: string): ProfileInvitation => {
    const invitation = characterInvitation(character, this.deps.save, challengeId);
    return { ...invitation, start: weakenedSkills => this.startMatch(character.id, weakenedSkills, challengeId) };
  };
  startMatch = (characterId: string, weakenedSkills: readonly string[] = [], challengeId?: string): Promise<void> => this.act(() => this.startInvitation(characterId, weakenedSkills, challengeId));
  private startInvitation = async (characterId: string, weakenedSkills: readonly string[] = [], challengeId?: string): Promise<void> => {
    const character = await loadCharacter(characterId);
    if (!this.disposed) await this.openFlow(invitationProgram(character, this.deps.save, weakenedSkills, challengeId).definition);
  };
  startFlow = (definition: ProgramDefinition | FlowDefinition, nodeId?: string): Promise<void> => this.act(() => this.openFlow(definition, nodeId));
  private openFlow = async (definition: ProgramDefinition | FlowDefinition, nodeId?: string): Promise<void> => {
    const previous = this.state.snapshot, previousEffects = this.state.durableEffectsRevision, seed = secureSeed();
    const program = "version" in definition ? definition : compileLegacyFlow(definition);
    let run = createProgramRun(`flow-${seed}`, seed, program, this.state.facts);
    if (nodeId) run = chooseProgram(run, nodeId, this.state.facts);
    if (currentProgramNode(run).type === "choice" && !programChoiceOptions(run, this.state.facts).length) throw new Error("所选流程没有可进入的节点");
    await this.state.begin(run);
    try { await this.showCurrent(); }
    catch (error) {
      await this.state.flush();
      if (this.state.durableEffectsRevision === previousEffects) {
        await this.rollback(previous);
        if (this.deps.session.showInitializationError?.(error)) return;
      }
      else await this.showRetry(error);
      throw error;
    }
  };
  restore = async (snapshot: RuntimeSave): Promise<void> => {
    this.state.restore(snapshot);
    if (this.state.match) await this.deps.session.resumeMatch(this.state.match, this.owner(this.run!));
    else await this.showCurrent();
  };
  private showCurrent = async (): Promise<void> => {
    if (this.disposed) return;
    const run = this.run;
    if (!run) { await this.deps.renderLobby(); return; }
    const node = currentProgramNode(run);
    if (node.type === "match") {
      if (this.state.match) await this.deps.session.resumeMatch(this.state.match, this.owner(run));
      else await this.beginEncounter(run);
      return;
    }
    if (node.type === "choice") { await this.showSelection(run); return; }
    if (node.type === "settlement") { await this.showSettlement(run); return; }
    if (node.type === "presentation") {
      await this.mount(renderProgramPresentation(run), () => {
        this.deps.root.querySelector<HTMLButtonElement>("[data-program-confirm]")!.onclick = () => void this.act(async () => { await this.state.confirm(); await this.showCurrent(); }).catch(this.report);
      });
      return;
    }
    throw new Error("流程没有推进到可显示节点");
  };
  private beginEncounter = async (run: ProgramRun): Promise<void> => {
    const node = currentProgramNode(run);
    if (node.type !== "match" || !run.resources) throw new Error("当前节点不能初始化牌局");
    const character = await loadCharacter(node.opponentId), profile = await this.deps.session.getMatchDefaults(character);
    if (this.disposed || !this.state.isCurrent(run)) return;
    const plan = resolveMatchInit({ id: programMatchId(run), seed: `${run.seed}:visit:${run.visitIndex}`, opponentId: node.opponentId,
      defaults: run.definition.defaults, init: programMatchInit(run), resources: run.resources, context: { profile, character } });
    const match = createMatch(plan.seed, plan.options);
    const started = await this.deps.session.startEncounter({ ...plan, match }, this.owner(run));
    if (!started && !this.disposed) throw new Error("牌局未能打开，请重试");
  };
  private choose = async (run: ProgramRun, optionId: string): Promise<void> => {
    const previous = this.state.snapshot!, previousEffects = this.state.durableEffectsRevision;
    await this.state.choose(optionId, run);
    try { await this.showCurrent(); }
    catch (error) {
      await this.state.flush();
      if (this.state.durableEffectsRevision === previousEffects) {
        await this.rollback(previous);
        if (this.deps.session.showInitializationError?.(error)) return;
      } else await this.showRetry(error);
      throw error;
    }
  };
  private async showRetry(error: unknown): Promise<void> {
    await this.mount(`<main class="challenge-shell challenge-selection"><h1>流程进度已保存</h1><p role="status" data-encounter-status>${escapeHtml(error instanceof Error ? error.message : "页面未能打开")}</p><button class="primary-button" data-program-retry>重试打开</button></main>`, () => {
      this.deps.root.querySelector<HTMLButtonElement>("[data-program-retry]")!.onclick = () => void this.act(() => this.showCurrent()).catch(this.report);
    });
  }
  private async rollback(previous: RuntimeSave | null): Promise<void> {
    this.deps.session.clearActiveMatch();
    try { if (previous) await this.state.replace(previous); else await this.state.abandon(); }
    catch (error) {
      if (!this.disposed && this.state.snapshot) await this.restore(this.state.snapshot);
      throw error;
    }
    if (!this.disposed) {
      if (this.state.match) await this.deps.session.resumeMatch(this.state.match, this.owner(this.run!));
      else await this.showCurrent();
    }
  }
  private showSelection = async (run: ProgramRun): Promise<void> => {
    const backgroundId = run.definition.presentation?.backgroundCharacterId;
    const background = flowBackgrounds(backgroundId ? await loadCharacter(backgroundId) : undefined)[0]?.image;
    if (this.disposed || !this.state.isCurrent(run)) return;
    const available = new Map(programChoiceOptions(run, this.state.facts).map(option => [option.id, option]));
    await this.mount(renderProgramChoice(run, this.state.facts, this.deps.save.settings.reducedMotion), () => {
      const main = this.deps.root.querySelector<HTMLElement>(".challenge-selection");
      if (main && background) main.style.backgroundImage = `linear-gradient(#0c1422b8, #0c1422e8), url(${JSON.stringify(background)})`;
      const dialog = this.deps.root.querySelector<HTMLDialogElement>(".challenge-skill-dialog"), legacy = legacyProgramView(run);
      this.deps.root.querySelectorAll<HTMLButtonElement>("[data-flow-info]").forEach(button => button.onclick = () => {
        if (!dialog || !legacy) return;
        dialog.querySelector<HTMLElement>("#challenge-compare-title")!.textContent = button.dataset.comparisonTitle ?? "效果变化";
        dialog.querySelector<HTMLElement>("[data-compare-body]")!.innerHTML = renderFlowSkillComparison(legacy.definition, button.dataset.flowInfo!, legacy); dialog.showModal();
      });
      dialog?.querySelector<HTMLButtonElement>("[data-compare-close]")?.addEventListener("click", () => dialog.close());
      this.deps.root.querySelectorAll<HTMLButtonElement>("[data-flow-node]").forEach(button => {
        const option = available.get(button.dataset.flowNode!); button.disabled = !option;
        button.onclick = () => {
          if (!option || !this.state.isCurrent(run)) return;
          const next = chooseProgram(run, option.id, this.state.facts), node = currentProgramNode(next);
          if (option.characterId && node.type === "match") void this.deps.openProfile(node.opponentId, character => ({ available: true,
            abilities: programMatchInit(next).opponentAbilities ?? character.aiSkills,
            start: () => this.act(() => this.choose(run, option.id)) }), () => !this.disposed && this.state.isCurrent(run)).catch(this.report);
          else void this.act(() => this.choose(run, option.id)).catch(this.report);
        };
      });
      this.deps.root.querySelector<HTMLButtonElement>("[data-abandon]")!.onclick = () => void this.act(async () => { await this.state.abandon(); this.deps.session.clearActiveMatch(); await this.deps.renderLobby(); }).catch(this.report);
    });
  };
  private async showSettlement(run: ProgramRun): Promise<void> {
    const node = currentProgramNode(run);
    if (node.type !== "settlement") return;
    const receipt = programResult(run, node.source);
    if (!receipt) throw new Error("结算缺少牌局结果");
    const character = await loadCharacter(receipt.match.opponentId);
    if (this.disposed || !this.state.isCurrent(run)) return;
    this.deps.session.currentCharacter = character;
    const next = typeof node.next === "string" ? run.definition.nodes.find(item => item.id === node.next) : undefined;
    const continuing = next?.type !== "end";
    const rewards = availableProgramRewards(run, this.state.facts).map(reward => {
      const resource = reward.effects.find(effect => effect.type === "resource");
      return { id: reward.id, label: reward.label, claimed: programRewardClaimed(run, reward.id),
        ...(resource?.type === "resource" ? {
          amount: `${resource.resource === "skillDraws" && resource.value > 0 ? "×" : resource.value > 0 ? "+" : resource.value < 0 ? "−" : ""}${Math.abs(resource.value)}`,
          icon: resource.resource === "skillDraws" ? "skillDraws" as const : resource.resource === "comparisonBonus" ? "pointAdvantage" as const : "removeBullets" as const,
          ...(resource.resource === "comparisonBonus" ? { detail: run.definition.legacyDefinition ? "本次挑战" : "本次流程" } : {})
        } : {}) };
    });
    this.deps.renderSummary(receipt.match, {
      recordResult: node.effects.some(effect => effect.type === "record-result" && evaluateProgramCondition(run, effect.when, this.state.facts) && programResult(run, effect.source)?.id === receipt.id), rewards,
      ...((continuing || run.definition.presentation?.resultActions === "return") ? { actions: [{ destination: continuing ? "continue" : "lobby", label: node.continueLabel ?? (continuing ? "继续" : "返回大厅"), primary: true }] } : {})
    });
  }
  exitTable = (): void => {
    const node = this.state.node;
    if (node?.type === "match" && node.escapePresentation === "immediate") void this.act(async () => {
      this.deps.session.pauseForNavigation();
      try { await this.state.completeMatch(true); this.deps.session.clearActiveMatch(); await this.showCurrent(); }
      finally { this.deps.session.resumeAfterNavigation(); }
    }).catch(this.report);
    else this.deps.session.dispatch({ type: "ESCAPE_MATCH" });
  };
  claimReward = (rewardId: string): Promise<void> => this.act(async () => { await this.state.claim(rewardId); await this.showCurrent(); });
  completeMatch = (destination: SummaryDestination): Promise<void> => this.act(async () => {
    if (this.state.match) { await this.state.completeMatch(); this.deps.session.clearActiveMatch(); await this.showCurrent(); return; }
    const run = this.run;
    if (!run) return;
    const receipt = programResult(run), match = receipt?.match;
    await this.state.confirm(); this.deps.session.clearActiveMatch();
    if (this.run) await this.showCurrent();
    else if (destination === "history" && match?.outcome?.winner === "player" && match.outcome.reason !== "escaped") await this.deps.showHistory();
    else if (destination === "rewind" && match && match.outcome?.winner !== "player" && match.outcome?.reason !== "escaped") {
      try { await this.startInvitation(match.opponentId); }
      catch (error) { if (!this.disposed && !this.state.snapshot) await this.deps.renderLobby(); throw error; }
    } else await this.deps.renderLobby();
  });
}
