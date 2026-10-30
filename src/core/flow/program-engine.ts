import { capturePlayerSkills, type PlayerSkillCarryover } from "../abilities/carryover";
import { instantiateAbility, validateAbilityBinding } from "../abilities/registry";
import { gameReducer } from "../match/reducer";
import type { MatchState } from "../match/types";
import { getPlayerSkillDefinition } from "../skills/definitions";
import { canAcquirePlayerSkill, recordPlayerSkillAcquisition } from "../skills/acquisition";
import { PLAYER_SKILL_INVENTORY_CAPACITY } from "../skills/skills";
import type { MatchInitSpec } from "./initialization";
import { ProgramDefinitionSchema, type ProgramCondition, type ProgramDefinition, type ProgramEffect, type ProgramFacts, type ProgramNode, type ProgramResources, type ProgramResult, type ProgramReward, type ProgramRun, type ProgramScalar, type ProgramTransition } from "./program";

export const MAX_PROGRAM_AUTOMATIC_STEPS = 128;
export function currentProgramNode(run: ProgramRun): ProgramNode {
  const node = run.definition.nodes.find(node => node.id === run.cursor);
  if (!node) throw new Error("当前流程节点不存在");
  return node;
}
export function programMatchId(run: ProgramRun): string { return `${run.id}:visit:${run.visitIndex}`; }
export function programResult(run: ProgramRun, source = "latest"): ProgramResult | undefined {
  return [...run.results].reverse().find(result => source === "latest" || result.nodeId === source || result.id === source);
}
function compare(left: ProgramScalar | undefined, operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte", right: ProgramScalar): boolean {
  if (operator === "eq") return left === right;
  if (operator === "ne") return left !== right;
  if (typeof left !== "number" || typeof right !== "number") return false;
  return operator === "gt" ? left > right : operator === "gte" ? left >= right : operator === "lt" ? left < right : left <= right;
}
function resourceValue(resources: ProgramResources | null, resource: "bullets" | "gunCapacity" | "skillDraws" | "comparisonBonus"): number | undefined {
  if (!resources) return undefined;
  return resource === "bullets" ? resources.gun.bullets : resource === "gunCapacity" ? resources.gun.capacity
    : resource === "comparisonBonus" ? resources.comparisonBonus : resources.player?.inventory.drawCount;
}
export function evaluateProgramCondition(run: ProgramRun, condition: ProgramCondition | undefined, facts: ProgramFacts = {}): boolean {
  if (!condition || condition.type === "always") return true;
  switch (condition.type) {
    case "all": return condition.conditions.every(item => evaluateProgramCondition(run, item, facts));
    case "any": return condition.conditions.some(item => evaluateProgramCondition(run, item, facts));
    case "not": return !evaluateProgramCondition(run, condition.condition, facts);
    case "completed": return run.completed.includes(condition.nodeId);
    case "visit-count": return compare(run.visits[condition.nodeId] ?? 0, condition.operator, condition.value);
    case "result": return programResult(run, condition.source)?.outcome === condition.outcome;
    case "variable": return compare(run.variables[condition.key], condition.operator, condition.value);
    case "resource": return compare(resourceValue(run.resources, condition.resource), condition.operator, condition.value);
    case "fact": {
      if ((condition.fact === "defeated" ? facts.defeated : facts.completedFlows)?.includes(condition.id)) return true;
      return run.pendingWrites.some(write => {
        if (condition.fact === "completed-flow") return write.type === "complete-flow" && (write.flowId === condition.id || write.legacyChallengeId === condition.id);
        if (write.type !== "record-result") return false;
        const result = run.results.find(item => item.id === write.resultId);
        return result?.match.opponentId === condition.id && result.match.outcome?.winner === "player" && result.match.outcome.reason !== "escaped";
      });
    }
  }
}
function nextId(run: ProgramRun, transition: ProgramTransition, facts: ProgramFacts): string {
  return typeof transition === "string" ? transition : transition.branches.find(branch => evaluateProgramCondition(run, branch.when, facts))?.to ?? transition.otherwise;
}
function move(run: ProgramRun, transition: ProgramTransition, facts: ProgramFacts): ProgramRun {
  const cursor = nextId(run, transition, facts), visitIndex = run.visitIndex + 1, visits = (run.visits[cursor] ?? 0) + 1;
  if (!Number.isSafeInteger(visitIndex) || !Number.isSafeInteger(visits)) throw new RangeError("流程访问次数溢出");
  return { ...run, cursor, visitIndex, visits: { ...run.visits, [cursor]: visits }, status: "waiting" };
}
function safeInteger(value: number): number { if (!Number.isSafeInteger(value)) throw new RangeError("流程资源数值溢出"); return value; }
function withResource(run: ProgramRun, effect: Extract<ProgramEffect, { type: "resource" }>): ProgramRun {
  const resources = run.resources;
  if (!resources) throw new Error("牌局持有资源时不能执行流程资源效果");
  const current = resourceValue(resources, effect.resource);
  if (current === undefined) throw new Error("玩家技能资源尚未初始化");
  let value = safeInteger(effect.operation === "add" ? current + effect.value : effect.value);
  if (effect.resource === "comparisonBonus") return { ...run, resources: { ...resources, comparisonBonus: value } };
  if (effect.clamp) value = Math.max(effect.resource === "gunCapacity" ? 1 : 0, effect.resource === "bullets" ? Math.min(resources.gun.capacity, value) : value);
  if (value < (effect.resource === "gunCapacity" ? 1 : 0)) throw new RangeError("流程资源低于允许范围");
  if (effect.resource === "skillDraws") return { ...run, resources: { ...resources, player: { ...resources.player!, inventory: { ...resources.player!.inventory, drawCount: value } } } };
  const gun = effect.resource === "bullets" ? { ...resources.gun, bullets: value }
    : { capacity: value, bullets: effect.clamp ? Math.min(value, resources.gun.bullets) : resources.gun.bullets };
  if (gun.bullets > gun.capacity) throw new RangeError("装填不能超过容量");
  return { ...run, resources: { ...resources, gun } };
}
function grantSkill(run: ProgramRun, effect: Extract<ProgramEffect, { type: "grant-skill" }>, receipt: string): ProgramRun {
  const resources = run.resources, player = resources?.player;
  if (!resources || !player) throw new Error("玩家技能资源尚未初始化");
  const binding = validateAbilityBinding(effect.binding);
  if (!binding.enabled) return run;
  const definition = getPlayerSkillDefinition(binding.definitionId, binding.level);
  const heldIds = player.inventory.cards.map(card => card.definitionId);
  if (!definition || player.inventory.cards.length >= PLAYER_SKILL_INVENTORY_CAPACITY
    || !canAcquirePlayerSkill(definition, player.inventory.acquisitionCounts, heldIds)
    || (!definition.stackable && heldIds.includes(definition.id))) throw new Error(`无法授予玩家技能：${binding.definitionId}`);
  const sequence = safeInteger(player.sequence + 1), instanceId = `flow-card:${receipt}`;
  const instance = instantiateAbility(binding, "player", instanceId, sequence, undefined, "player-skill");
  return { ...run, resources: { ...resources, player: { ...player, sequence, instances: [...player.instances, instance], inventory: {
    ...player.inventory, cards: [...player.inventory.cards, { kind: "player-skill", owner: "player", definitionId: binding.definitionId, level: binding.level ?? 1, instanceId }],
    acquisitionCounts: recordPlayerSkillAcquisition(definition, player.inventory.acquisitionCounts, heldIds)
  } } } };
}
function applyEffects(run: ProgramRun, effects: readonly ProgramEffect[], group: string, facts: ProgramFacts): ProgramRun {
  let next = run;
  for (const effect of effects) {
    const receipt = JSON.stringify([run.id, run.visitIndex, group, effect.id]);
    if (next.claimed.includes(receipt) || !evaluateProgramCondition(next, effect.when, facts)) continue;
    switch (effect.type) {
      case "set-variable": next = { ...next, variables: { ...next.variables, [effect.key]: effect.value } }; break;
      case "add-variable": {
        const current = next.variables[effect.key] ?? 0;
        if (typeof current !== "number") throw new Error("非数值变量不能累加");
        next = { ...next, variables: { ...next.variables, [effect.key]: safeInteger(current + effect.value) } }; break;
      }
      case "resource": next = withResource(next, effect); break;
      case "grant-skill": next = grantSkill(next, effect, receipt); break;
      case "record-result": {
        const node = currentProgramNode(next);
        const result = programResult(next, effect.source ?? (node.type === "settlement" ? node.source : undefined));
        if (!result) throw new Error("结算缺少牌局结果");
        const recordReceipt = JSON.stringify([run.id, "record", result.id]);
        if (!next.claimed.includes(recordReceipt)) next = { ...next, claimed: [...next.claimed, recordReceipt], pendingWrites: [...next.pendingWrites, { type: "record-result", resultId: result.id }] };
        break;
      }
      case "complete-flow": next = { ...next, pendingWrites: [...next.pendingWrites, { type: "complete-flow", flowId: effect.flowId ?? run.definition.id, ...(effect.legacyChallengeId ? { legacyChallengeId: effect.legacyChallengeId } : {}) }] }; break;
    }
    next = { ...next, claimed: [...next.claimed, receipt] };
  }
  return next;
}
export function programChoiceOptions(run: ProgramRun, facts: ProgramFacts = {}) {
  const node = currentProgramNode(run);
  return node.type === "choice" ? node.options.filter(option => evaluateProgramCondition(run, option.when, facts)) : [];
}
export function availableProgramRewards(run: ProgramRun, facts: ProgramFacts = {}): readonly ProgramReward[] {
  const node = currentProgramNode(run);
  return node.type === "settlement" ? node.rewards.filter(reward => evaluateProgramCondition(run, reward.when, facts)) : [];
}
export function programRewardClaimed(run: ProgramRun, rewardId: string): boolean { return run.claimed.includes(JSON.stringify([run.id, run.visitIndex, "reward", rewardId])); }
export function claimProgramReward(run: ProgramRun, rewardId: string, facts: ProgramFacts = {}): ProgramRun {
  if (programRewardClaimed(run, rewardId)) return run;
  const reward = availableProgramRewards(run, facts).find(reward => reward.id === rewardId);
  if (run.status !== "waiting" || !reward) throw new Error("当前奖励不可领取");
  const next = applyEffects(run, reward.effects, `reward:${reward.id}`, facts);
  return { ...next, claimed: [...next.claimed, JSON.stringify([run.id, run.visitIndex, "reward", rewardId])] };
}
/** Stops at a player decision or table; automatic cycles fail before any partial state is committed. */
export function advanceProgram(run: ProgramRun, facts: ProgramFacts = {}, maxSteps = MAX_PROGRAM_AUTOMATIC_STEPS): ProgramRun {
  let next = run;
  for (let step = 0; step < maxSteps; step++) {
    if (next.status === "finished") return next;
    const node = currentProgramNode(next);
    if (node.type === "match") return { ...next, status: "match" };
    if (node.type === "choice" || node.type === "presentation" || (node.type === "settlement" && node.confirmation === "required")) return { ...next, status: "waiting" };
    if (node.type === "initialize") {
      if (!next.resources) throw new Error("不能重置活动牌局资源");
      next = { ...next, resources: { gun: node.resources?.gun ? { ...node.resources.gun } : next.resources.gun,
        player: node.resources?.player === "clear" ? null : next.resources.player,
        comparisonBonus: node.resources?.comparisonBonus ?? next.resources.comparisonBonus }, variables: { ...next.variables, ...node.variables } };
    } else if (node.type === "effect" || node.type === "end") next = applyEffects(next, node.effects, "effects", facts);
    else if (node.type === "settlement") {
      for (const reward of availableProgramRewards(next, facts)) next = claimProgramReward(next, reward.id, facts);
      next = applyEffects(next, node.effects, "effects", facts);
    }
    if (node.type === "end") return { ...next, status: "finished", result: node.result };
    next = move(next, node.next, facts);
  }
  throw new Error(`流程自动执行超过 ${maxSteps} 步，请检查无等待循环`);
}
export function createProgramRun(id: string, seed: string, definition: ProgramDefinition, facts: ProgramFacts = {}): ProgramRun {
  const parsed = ProgramDefinitionSchema.parse(definition);
  return advanceProgram({ id, seed, definition: parsed, cursor: parsed.start, visitIndex: 1, visits: { [parsed.start]: 1 }, status: "waiting", completed: [], variables: {},
    resources: { gun: { capacity: 6, bullets: 0 }, player: null, comparisonBonus: 0 }, results: [], claimed: [], pendingWrites: [], result: null }, facts);
}
export function chooseProgram(run: ProgramRun, optionId: string, facts: ProgramFacts = {}, expectedVisitIndex = run.visitIndex): ProgramRun {
  if (expectedVisitIndex !== run.visitIndex) return run;
  const option = programChoiceOptions(run, facts).find(option => option.id === optionId);
  if (run.status !== "waiting" || !option) throw new Error("流程选项不可用");
  return advanceProgram(move(run, option.to, facts), facts);
}
export function confirmProgramNode(run: ProgramRun, facts: ProgramFacts = {}, expectedVisitIndex = run.visitIndex): ProgramRun {
  if (expectedVisitIndex !== run.visitIndex) return run;
  const node = currentProgramNode(run);
  if (run.status !== "waiting" || (node.type !== "settlement" && node.type !== "presentation")) throw new Error("当前节点不能确认");
  if (node.type === "settlement" && availableProgramRewards(run, facts).some(reward => !programRewardClaimed(run, reward.id))) throw new Error("请先领取本场奖励");
  const next = node.type === "settlement" ? applyEffects(run, node.effects, "effects", facts) : run;
  return advanceProgram(move(next, node.next, facts), facts);
}
export function completeProgramMatch(run: ProgramRun, match: MatchState, facts: ProgramFacts = {}, carryoverOverride?: PlayerSkillCarryover): ProgramRun {
  const node = currentProgramNode(run);
  if (run.results.some(result => result.id === match.id)) return run;
  if (run.status !== "match" || node.type !== "match" || match.id !== programMatchId(run) || match.opponentId !== node.opponentId || match.status !== "finished" || !match.outcome) throw new Error("牌局结果与当前流程不一致");
  const acknowledged = gameReducer(match, { type: "ACK_MATCH_RESULT" });
  if (acknowledged.scene !== "lobby") throw new Error("牌局结果尚不能确认");
  const outcome = match.outcome.reason === "escaped" ? "escaped" : match.outcome.winner === "player" && match.outcome.reason === "opponent-killed" ? "victory" : "defeat";
  const next: ProgramRun = { ...run, status: "waiting", resources: { gun: { ...acknowledged.roulette.player }, player: carryoverOverride ?? capturePlayerSkills(acknowledged), comparisonBonus: acknowledged.comparisonBonuses?.player ?? 0 },
    completed: outcome === "victory" ? [...new Set([...run.completed, node.id])] : run.completed,
    results: [...run.results, { id: match.id, nodeId: node.id, visitIndex: run.visitIndex, outcome, match: acknowledged }] };
  return advanceProgram(move(next, node.routes[outcome], facts), facts);
}
export function programMatchInit(run: ProgramRun): MatchInitSpec {
  const node = currentProgramNode(run);
  if (node.type !== "match") throw new Error("当前节点不是牌局");
  return { ...node.init, ...(node.abilities ? { opponentAbilities: node.abilities.map(slot => slot.overrides.find(override => override.afterAny.some(id => run.completed.includes(id)))?.binding ?? slot.binding) } : {}) };
}
export function clearProgramWrites(run: ProgramRun): ProgramRun { return run.pendingWrites.length ? { ...run, pendingWrites: [] } : run; }
