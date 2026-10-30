import { describe, expect, it } from "vitest";
import { capturePlayerSkills } from "../abilities/carryover";
import { DEFAULT_AI_PROFILE } from "../ai/types";
import { createMatch, gameReducer } from "../match/reducer";
import type { MatchState } from "../match/types";
import { INITIAL_PLAYER_SKILL_IDS, getPlayerSkillDefinition } from "../skills/definitions";
import { FlowDefinitionSchema } from "./schema";
import { resolveMatchInit } from "./initialization";
import { ProgramDefinitionSchema, ProgramRunSchema, type ProgramRun } from "./program";
import { advanceProgram, availableProgramRewards, chooseProgram, claimProgramReward, clearProgramWrites, completeProgramMatch, confirmProgramNode, createProgramRun, currentProgramNode, evaluateProgramCondition, programChoiceOptions, programMatchId, programMatchInit, programRewardClaimed } from "./program-engine";
import { compileLegacyFlow, instantiateProgramTemplate, singleMatchProgram } from "./program-templates";

function matchFor(run: ProgramRun): MatchState {
  const node = currentProgramNode(run);
  if (node.type !== "match" || !run.resources) throw new Error("Expected a prepared match");
  const plan = resolveMatchInit({ id: programMatchId(run), seed: `${run.seed}:${run.visitIndex}`, opponentId: node.opponentId,
    defaults: run.definition.defaults, init: programMatchInit(run), resources: run.resources,
    context: { profile: { talentIds: [], unlockedPlayerSkillIds: INITIAL_PLAYER_SKILL_IDS, skillDeckIds: INITIAL_PLAYER_SKILL_IDS }, character: { ai: DEFAULT_AI_PROFILE, aiSkills: [] } } });
  return createMatch(plan.seed, plan.options);
}
function won(match: MatchState): MatchState {
  const loaded: MatchState = { ...match, roulette: { ...match.roulette, opponent: { ...match.roulette.opponent, bullets: match.roulette.opponent.capacity } },
    round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } } };
  return gameReducer(gameReducer(loaded, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
}
function legacy() {
  return FlowDefinitionSchema.parse({ id: "neutral-sequence", completionId: "legacy-completion", playerGun: { capacity: 8, bullets: 2 },
    nodes: [
      { id: "preparation", opponentId: "llama", victoryRewards: { skillDraws: 2, removeBullets: 1, pointAdvantage: 3 }, recordResult: "never",
        routes: { victory: { type: "selection" }, defeat: { type: "selection" }, escaped: { type: "selection" } } },
      { id: "final", opponentId: "chatgpt", opponentGun: { capacity: 9, bullets: 0 }, recordResult: "always",
        routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } }
    ] });
}

describe("declarative flow programs", () => {
  it("initializes ordinary and multi-match play through one program and preserves independent identities", () => {
    let ordinary = createProgramRun("single", "seed", singleMatchProgram({ opponentId: "llama", playerGun: { capacity: 3, bullets: 1 } }));
    expect(ordinary.status).toBe("match"); expect(ordinary.resources?.gun).toEqual({ capacity: 3, bullets: 1 });
    const match = matchFor(ordinary);
    ordinary = completeProgramMatch({ ...ordinary, resources: null }, won(match));
    expect(ordinary.pendingWrites).toEqual([]);
    expect(ordinary.results[0].match.scene).toBe("lobby");
    ordinary = confirmProgramNode(ordinary);
    expect(ordinary.status).toBe("finished");
    expect(ordinary.pendingWrites).toEqual([{ type: "record-result", resultId: match.id }]);
    expect(clearProgramWrites(ordinary).pendingWrites).toEqual([]);
    const sequence = createProgramRun("sequence", "seed", compileLegacyFlow(legacy()));
    expect(sequence.status).toBe("waiting");
    expect(programChoiceOptions(sequence).map(option => option.id)).toEqual(["preparation", "final"]);
    expect(chooseProgram(sequence, "final").status).toBe("match");
  });

  it("persists each claimed reward exactly once and carries resource changes without rewriting the result", () => {
    let run = chooseProgram(createProgramRun("rewards", "seed", compileLegacyFlow(legacy())), "preparation");
    const match = won(matchFor(run));
    run = completeProgramMatch({ ...run, resources: null }, match);
    const receipt = run.results[0], draws = run.resources!.player!.inventory.drawCount;
    expect(availableProgramRewards(run).map(reward => reward.id)).toEqual(["skillDraws", "removeBullets", "pointAdvantage"]);
    expect(() => confirmProgramNode(run)).toThrow("请先领取");
    run = claimProgramReward(run, "skillDraws");
    expect(claimProgramReward(run, "skillDraws")).toBe(run);
    run = ProgramRunSchema.parse(JSON.parse(JSON.stringify(run)));
    expect(programRewardClaimed(run, "skillDraws")).toBe(true);
    expect(run.resources!.player!.inventory.drawCount).toBe(draws + 2);
    run = claimProgramReward(claimProgramReward(run, "removeBullets"), "pointAdvantage");
    expect(run.resources?.gun.bullets).toBe(1); expect(run.resources?.comparisonBonus).toBe(3);
    expect(run.results[0]).toEqual(receipt);
    run = confirmProgramNode(run);
    expect(run.pendingWrites).toEqual([]);
    expect(programChoiceOptions(run).map(option => option.id)).toEqual(["final"]);
    run = chooseProgram(run, "final");
    const nextMatch = matchFor(run);
    expect(nextMatch.id).not.toBe(match.id);
    expect(nextMatch.playerSkills.drawCount).toBe(draws + 2);
    expect(nextMatch.comparisonBonuses?.player).toBe(3);
    expect(nextMatch.roulette.opponent.capacity).toBe(9);
    run = confirmProgramNode(completeProgramMatch(run, won(nextMatch)));
    expect(run.pendingWrites).toEqual([{ type: "record-result", resultId: nextMatch.id }, { type: "complete-flow", flowId: "neutral-sequence", legacyChallengeId: "legacy-completion" }]);
  });

  it("preserves immediate escape and supplied pre-escape carryover without settlement or recording", () => {
    let run = chooseProgram(createProgramRun("escape", "seed", compileLegacyFlow(legacy())), "preparation");
    const node = currentProgramNode(run);
    expect(node.type === "match" && node.escapePresentation).toBe("immediate");
    const match = matchFor(run), carry = capturePlayerSkills(match);
    const preserved = { ...carry, inventory: { ...carry.inventory, drawCount: 7 } };
    run = completeProgramMatch({ ...run, resources: null }, gameReducer(match, { type: "ESCAPE_MATCH" }), {}, preserved);
    expect(currentProgramNode(run).type).toBe("choice");
    expect(run.resources!.player!.inventory.drawCount).toBe(7);
    expect(run.completed).toEqual([]); expect(run.pendingWrites).toEqual([]);
    expect(programChoiceOptions(run)).toHaveLength(2);
  });

  it("composes conditions, visits, variable effects and branch routes without arbitrary expressions", () => {
    const program = ProgramDefinitionSchema.parse({ version: 2, id: "conditions", start: "init", nodes: [
      { id: "init", type: "initialize", variables: { money: 2 }, next: "menu" },
      { id: "menu", type: "choice", options: [{ id: "buy", to: "buy", when: { type: "all", conditions: [
        { type: "variable", key: "money", operator: "gte", value: 2 },
        { type: "not", condition: { type: "visit-count", nodeId: "buy", operator: "gte", value: 1 } },
        { type: "any", conditions: [{ type: "fact", fact: "defeated", id: "llama" }, { type: "fact", fact: "completed-flow", id: "permit" }] }
      ] } }, { id: "leave", to: "end" }] },
      { id: "buy", type: "effect", effects: [{ id: "pay", type: "add-variable", key: "money", value: -2 }], next: "menu" },
      { id: "end", type: "end", result: "abandoned" }
    ] });
    let run = createProgramRun("conditions", "seed", program);
    expect(programChoiceOptions(run).map(option => option.id)).toEqual(["leave"]);
    const oldVisit = run.visitIndex;
    run = chooseProgram(run, "buy", { defeated: ["llama"] });
    expect(run.variables.money).toBe(0); expect(run.visits.buy).toBe(1);
    expect(chooseProgram(run, "buy", {}, oldVisit)).toBe(run);
    expect(evaluateProgramCondition(run, { type: "resource", resource: "bullets", operator: "eq", value: 0 })).toBe(true);
    expect(programChoiceOptions(run, { defeated: ["llama"] }).map(option => option.id)).toEqual(["leave"]);
  });

  it("allows two separate same-kind rewards, grants real skill instances, and keeps recording idempotent", () => {
    const active = INITIAL_PLAYER_SKILL_IDS.find(id => getPlayerSkillDefinition(id)?.category === "active")!;
    const base = singleMatchProgram({ opponentId: "llama", init: { playerSkills: { mode: "reset", openingCards: 0 } } });
    const program = ProgramDefinitionSchema.parse({ ...base, nodes: base.nodes.map(node => node.type === "settlement" ? { ...node, rewards: [
      { id: "one", label: "第一份", effects: [{ id: "draw", type: "resource", resource: "skillDraws", operation: "add", value: 1 }] },
      { id: "two", label: "第二份", effects: [{ id: "draw", type: "resource", resource: "skillDraws", operation: "add", value: 1 }, { id: "card", type: "grant-skill", binding: { definitionId: active, enabled: true, parameters: {} } }] }
    ], effects: [...node.effects, { id: "second-record", type: "record-result", source: "match" }] } : node) });
    let run = createProgramRun("two", "seed", program);
    run = completeProgramMatch(run, won(matchFor(run)));
    run = claimProgramReward(claimProgramReward(run, "one"), "two");
    expect(run.resources!.player!.inventory.drawCount).toBe(2);
    const card = run.resources!.player!.inventory.cards[0];
    expect(card.definitionId).toBe(active);
    expect(run.resources!.player!.instances.some(instance => instance.instanceId === card.instanceId)).toBe(true);
    expect(run.resources!.player!.inventory.acquisitionCounts?.[active]).toBe(1);
    run = confirmProgramNode(run);
    expect(run.pendingWrites.filter(write => write.type === "record-result")).toHaveLength(1);
  });

  it("supports an independent display and delayed aggregate settlement after multiple matches", () => {
    const program = ProgramDefinitionSchema.parse({ version: 2, id: "delayed", start: "first", nodes: [
      { id: "first", type: "match", opponentId: "llama", routes: { victory: "second", defeat: "second", escaped: "second" } },
      { id: "second", type: "match", opponentId: "chatgpt", routes: { victory: "story", defeat: "story", escaped: "story" } },
      { id: "story", type: "presentation", body: "两场结束", next: "settle" },
      { id: "settle", type: "settlement", effects: [{ id: "first", type: "record-result", source: "first" }, { id: "second", type: "record-result", source: "second" }], next: "end" },
      { id: "end", type: "end", result: "victory" }
    ] });
    let run = createProgramRun("delayed", "seed", program);
    run = completeProgramMatch(run, won(matchFor(run)));
    run = completeProgramMatch(run, won(matchFor(run)));
    expect(run.results).toHaveLength(2); expect(run.pendingWrites).toEqual([]);
    run = confirmProgramNode(run);
    expect(currentProgramNode(run).type).toBe("settlement");
    expect(run.pendingWrites).toEqual([]);
    run = confirmProgramNode(run);
    expect(run.pendingWrites.filter(write => write.type === "record-result")).toHaveLength(2);
  });

  it("routes using facts produced earlier in the same atomic transition", () => {
    const base = singleMatchProgram({ opponentId: "llama" });
    const program = ProgramDefinitionSchema.parse({ ...base, nodes: [
      ...base.nodes.map(node => node.type === "settlement" ? { ...node, effects: [...node.effects,
        { id: "complete", type: "complete-flow", flowId: "permit" }], next: {
        branches: [{ when: { type: "all", conditions: [{ type: "fact", fact: "defeated", id: "llama" }, { type: "fact", fact: "completed-flow", id: "permit" }] }, to: "granted" }], otherwise: "denied"
      } } : node),
      { id: "granted", type: "presentation", body: "已获得资格", next: "denied" },
      { id: "denied", type: "end", result: "abandoned" }
    ] });
    let run = createProgramRun("facts", "seed", program);
    run = completeProgramMatch(run, won(matchFor(run)));
    run = confirmProgramNode(run);
    expect(run.cursor).toBe("granted");
    expect(run.pendingWrites).toHaveLength(2);
  });

  it("rejects stale results, missing references, duplicate receipts and automatic cycles", () => {
    const base = singleMatchProgram({ opponentId: "llama" });
    const run = createProgramRun("safe", "seed", base), match = won(matchFor(run));
    expect(() => completeProgramMatch(run, { ...match, id: "old-visit" })).toThrow("不一致");
    expect(() => ProgramDefinitionSchema.parse({ ...base, start: "missing" })).toThrow();
    expect(() => ProgramDefinitionSchema.parse({ ...base, nodes: [...base.nodes, base.nodes[0]] })).toThrow();
    expect(() => ProgramRunSchema.parse({ ...run, claimed: ["duplicate", "duplicate"] })).toThrow();
    const cycle = ProgramDefinitionSchema.parse({ version: 2, id: "cycle", start: "loop", nodes: [{ id: "loop", type: "effect", effects: [], next: "loop" }] });
    expect(() => createProgramRun("cycle", "seed", cycle)).toThrow("无等待循环");
    expect(() => advanceProgram({ ...run, cursor: "missing" })).toThrow("不存在");
    const finished = completeProgramMatch(run, match);
    expect(completeProgramMatch(finished, match)).toBe(finished);
  });

  it("round-trips the two public templates and keeps prerequisite restrictions in compiled choices", () => {
    const definition = legacy(); definition.nodes[1].requires = ["preparation"];
    const program = instantiateProgramTemplate({ type: "encounter-sequence", definition });
    const run = createProgramRun("template", "seed", program);
    expect(programChoiceOptions(run).map(option => option.id)).toEqual(["preparation"]);
    const single = instantiateProgramTemplate({ type: "single-match", opponentId: "llama", init: { playerGun: { mode: "replace", value: { capacity: 2, bullets: 0 } } } });
    expect(matchFor(createProgramRun("single-template", "seed", single)).roulette.player.capacity).toBe(2);
  });

  it("retains all combinations of four independently completed preparation nodes", () => {
    const definition = legacy();
    const guard = definition.nodes[0], final = definition.nodes[1];
    const guards = ["a", "b", "c", "d"].map(id => ({ ...guard, id, victoryRewards: undefined }));
    final.abilities = guards.map(node => ({ slot: node.id, binding: { definitionId: "neutral-ability", level: 2, enabled: true, parameters: {} },
      overrides: [{ afterAny: [node.id], binding: { definitionId: "neutral-ability", level: 1, enabled: true, parameters: {} } }] }));
    const program = compileLegacyFlow({ ...definition, nodes: [...guards, final] });
    for (let mask = 0; mask < 16; mask++) {
      const run = chooseProgram(createProgramRun(`combination-${mask}`, "seed", program), "final");
      const completed = guards.filter((_, index) => mask & (1 << index)).map(node => node.id);
      expect(programMatchInit({ ...run, completed }).opponentAbilities?.map(binding => binding.level))
        .toEqual(guards.map(node => completed.includes(node.id) ? 1 : 2));
    }
  });
});
