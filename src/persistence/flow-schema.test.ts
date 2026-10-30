import { describe, expect, it } from "vitest";
import trial from "../core/challenge/fixtures/legacy-challenge.json";
import { CHARACTER_CATALOG } from "../content/characters";
import { capturePlayerSkills } from "../core/abilities/carryover";
import { createChallenge } from "../core/challenge/reducer";
import { ChallengeDefinitionSchema } from "../core/challenge/schema";
import { claimFlowReward, createFlowRun, finishFlowNode, flowEncounterPlan, startFlowNode } from "../core/flow/reducer";
import { FlowDefinitionSchema, type FlowRun } from "../core/flow/schema";
import { createMatch, gameReducer } from "../core/match/reducer";
import type { MatchState } from "../core/match/types";
import { INITIAL_PLAYER_SKILL_IDS } from "../core/skills/definitions";
import { createRuntimeSave } from "./boot";
import { CURRENT_GAME_VERSION, CURRENT_RUNTIME_SCHEMA_VERSION, RUNTIME_SAVE_FORMAT, validateRuntimeSave, type FlowMemory, type RuntimeSave } from "./schema";

function initial(): FlowRun {
  const definition = FlowDefinitionSchema.parse({ id: "neutral-circuit", completionId: "neutral-complete", playerGun: { capacity: 3, bullets: 1 },
    presentation: { title: "连续牌局", continueLabel: "继续对局" }, nodes: [
      { id: "first", opponentId: "llama", opponentGun: { capacity: 2, bullets: 0 }, victoryRewards: { skillDraws: 1, pointAdvantage: 2 },
        routes: { victory: { type: "node", nodeId: "second" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "selection" } } },
      { id: "second", opponentId: "llama", requires: ["first"], opponentGun: { capacity: 5, bullets: 0 },
        routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } }
    ] });
  return createFlowRun("persisted-circuit", "seed", definition);
}
function snapshot(run: FlowRun, match: MatchState | null = null, memory: FlowMemory = { player: null }): RuntimeSave {
  const { playerGun, ...stored } = run;
  return { format: RUNTIME_SAVE_FORMAT, schemaVersion: CURRENT_RUNTIME_SCHEMA_VERSION, gameVersion: CURRENT_GAME_VERSION,
    updatedAt: "2026-10-28T00:00:00.000Z", activeMatch: match,
    ...(match ? { activeFlow: stored } : { activeFlow: { ...stored, playerGun }, flowMemory: memory }) };
}
function active() {
  const fresh = initial(), run = { ...fresh, ...startFlowNode(fresh.definition, fresh, "first") };
  const plan = flowEncounterPlan(run.definition, run, { gun: run.playerGun, comparisonBonus: 0 });
  const match = createMatch(plan.seed, { ...plan.options, opponentId: plan.opponentId, opponentAiSkills: [], unlockedPlayerSkillIds: [], talentIds: [] });
  return { run, match };
}
function victory(match: MatchState): MatchState {
  const ready: MatchState = { ...match, roulette: { ...match.roulette, opponent: { ...match.roulette.opponent, bullets: match.roulette.opponent.capacity } },
    round: { ...match.round, phase: "roulette-trigger", currentActor: null,
      outcome: { winner: "player", reason: "comparison", penaltyTarget: "opponent", bulletsAdded: 1 } } };
  return gameReducer(gameReducer(ready, { type: "TRIGGER_ROULETTE" }), { type: "ACK_TRIGGER_RESULT" });
}

describe("generic flow runtime snapshots", () => {
  it("roundtrips selection, table, claimed settlement and directed continuation without duplicating table resources", () => {
    const fresh = snapshot(initial());
    expect(validateRuntimeSave(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh);
    let { run, match } = active();
    expect(validateRuntimeSave(snapshot(run, match)).activeFlow?.playerGun).toBeUndefined();
    match = victory(match);
    ({ run, match } = claimFlowReward(run, match, "skillDraws"));
    ({ run, match } = claimFlowReward(run, match, "pointAdvantage"));
    const savedResult = snapshot(run, match);
    expect(validateRuntimeSave(JSON.parse(JSON.stringify(savedResult)))).toEqual(savedResult);
    const acknowledged = gameReducer(match, { type: "ACK_MATCH_RESULT" });
    const next = { ...run, ...finishFlowNode(run.definition, run, acknowledged), playerGun: acknowledged.roulette.player };
    const savedNext = snapshot(next, null, { player: capturePlayerSkills(acknowledged) });
    const restored = validateRuntimeSave(JSON.parse(JSON.stringify(savedNext)));
    expect(restored.activeFlow?.nextNodeId).toBe("second");
    expect(restored.activeFlow?.completedNodes).toEqual(["first"]);
    expect(restored.activeFlow?.playerComparisonBonus).toBe(2);
    expect(restored.flowMemory?.player?.inventory.drawCount).toBe(match.playerSkills.drawCount);
    expect(restored).toEqual(savedNext);
    expect(() => validateRuntimeSave({ ...savedNext, flowMemory: { player: null } })).toThrow("缺少继承技能库存");
  });

  it("rejects missing or duplicate resource owners and mismatched active tables", () => {
    const fresh = initial(), selection = snapshot(fresh), { run, match } = active(), table = snapshot(run, match);
    for (const invalid of [
      { ...selection, flowMemory: undefined },
      { ...selection, activeFlow: { ...fresh, playerGun: undefined } },
      { ...selection, activeMatch: match },
      { ...table, activeFlow: run },
      { ...table, flowMemory: { player: null } },
      { ...table, activeMatch: null },
      { ...table, activeMatch: { ...match, id: "another-table" } },
      { ...table, activeMatch: createMatch("different-opponent", { id: match.id, opponentId: "chatgpt" }) },
      { ...createRuntimeSave(match), flowMemory: { player: null } },
      { ...selection, challengeMemory: { player: null } }
    ]) expect(() => validateRuntimeSave(invalid)).toThrow();
  });

  it("rejects acknowledged intermediate tables, fabricated reward receipts and already-finished flows", () => {
    const { run, match } = active(), won = victory(match);
    const acknowledged = gameReducer(won, { type: "ACK_MATCH_RESULT" });
    expect(() => validateRuntimeSave(snapshot(run, acknowledged))).toThrow("结算必须与阶段切换");
    const claimed = { ...run, encounter: { ...run.encounter!, claimedRewards: ["skillDraws" as const] } };
    expect(() => validateRuntimeSave(snapshot(claimed, match))).toThrow("仅胜利结算");
    const escaped = gameReducer(match, { type: "ESCAPE_MATCH" });
    expect(() => validateRuntimeSave(snapshot(claimed, escaped))).toThrow("仅胜利结算");
    expect(() => validateRuntimeSave(snapshot({ ...run, phase: "finished", encounter: null, result: "defeat" }))).toThrow("运行时清理");
  });

  it("validates every future opponent and ability binding, including overrides", () => {
    const fresh = initial(), definition = fresh.definition;
    const unknownCharacter = { ...definition, nodes: definition.nodes.map((node, index) => index ? { ...node, opponentId: "uninstalled" } : node) };
    expect(() => validateRuntimeSave(snapshot({ ...fresh, definition: unknownCharacter }))).toThrow("流程角色已不可用");
    const trialDefinition = ChallengeDefinitionSchema.parse(trial), known = trialDefinition.bossAbilities[0].binding;
    const withAbility = (binding: typeof known, override = known) => ({ ...definition, nodes: definition.nodes.map((node, index) => index ? {
      ...node, abilities: [{ slot: "skill", label: "技能", binding, overrides: [{ afterAny: ["first"], binding: override }] }]
    } : node) });
    expect(() => validateRuntimeSave(snapshot({ ...fresh, definition: withAbility(known) }))).not.toThrow();
    expect(() => validateRuntimeSave(snapshot({ ...fresh, definition: withAbility({ ...known, definitionId: "uninstalled" }) }))).toThrow("流程技能已不可用");
    expect(() => validateRuntimeSave(snapshot({ ...fresh, definition: withAbility(known, { ...known, definitionId: "uninstalled" }) }))).toThrow("流程技能已不可用");
    expect(() => validateRuntimeSave(snapshot({ ...fresh, definition: withAbility({ ...known, definitionId: INITIAL_PLAYER_SKILL_IDS[0], level: 1 }) }))).toThrow("流程技能已不可用");
  });

  it("keeps existing schema-13 ordinary and challenge saves valid and rejects competing flows", () => {
    const { match } = active(), ordinary = createRuntimeSave(match);
    expect(validateRuntimeSave(ordinary)).toEqual(ordinary);
    const definition = ChallengeDefinitionSchema.parse(trial);
    const legacyRun = createChallenge("legacy", definition, definition.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-28T00:00:00Z" })), CHARACTER_CATALOG);
    const legacy = { ...snapshot(initial()), activeFlow: undefined, flowMemory: undefined,
      activeChallenge: legacyRun, challengeMemory: { player: null } };
    expect(validateRuntimeSave(legacy)).toEqual(legacy);
    expect(() => validateRuntimeSave({ ...legacy, activeFlow: initial(), flowMemory: { player: null } })).toThrow("一个流程所有者");
    expect(() => validateRuntimeSave({ ...legacy, flowMemory: { player: null } })).toThrow("flow inventory requires");
    expect(CURRENT_RUNTIME_SCHEMA_VERSION).toBe(15);
  });
});
