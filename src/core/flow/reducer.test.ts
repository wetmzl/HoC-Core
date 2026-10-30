import { describe, expect, it } from "vitest";
import { capturePlayerSkills } from "../abilities/carryover";
import { createMatch, gameReducer } from "../match/reducer";
import type { MatchState } from "../match/types";
import { availableFlowNodes, claimFlowReward, createFlow, createFlowRun, finishFlowNode, flowEncounterPlan, flowNodeAbilities, flowOutcomeRoute, flowRecordsResult, flowVictoryRewards, pendingFlowRewards, startFlowNode } from "./reducer";
import { FlowDefinitionSchema, FlowProgressSchema, FlowRunSchema, StoredFlowRunSchema, type FlowDefinition, type FlowProgress } from "./schema";

function circuit(): FlowDefinition {
  return FlowDefinitionSchema.parse({ id: "three-round-circuit", playerGun: { capacity: 3, bullets: 1 }, nodes: [
    { id: "qualifier", opponentId: "llama", opponentGun: { capacity: 2, bullets: 0 }, routes: { victory: { type: "node", nodeId: "rematch" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } },
    { id: "rematch", opponentId: "llama", requires: ["qualifier"], opponentGun: { capacity: 5, bullets: 0 }, routes: { victory: { type: "node", nodeId: "final" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "selection" } } },
    { id: "final", opponentId: "chatgpt", requires: ["rematch"], opponentGun: { capacity: 9, bullets: 0 }, routes: { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "finish", result: "abandoned" } } }
  ] });
}
function acknowledged(definition: FlowDefinition, run: FlowProgress, winner: "player" | "opponent" = "player", gun = definition.playerGun): MatchState {
  const plan = flowEncounterPlan(definition, run, { gun, comparisonBonus: 0 });
  let match = createMatch(plan.seed, { ...plan.options, opponentId: plan.opponentId, opponentAiSkills: [], unlockedPlayerSkillIds: [], talentIds: [] });
  const actor = winner === "player" ? "opponent" : "player";
  match = { ...match, roulette: { ...match.roulette, [actor]: { ...match.roulette[actor], bullets: match.roulette[actor].capacity } }, round: { ...match.round, phase: "roulette-trigger", currentActor: null, outcome: { winner, reason: "comparison", penaltyTarget: actor, bulletsAdded: 1 } } };
  match = gameReducer(match, { type: "TRIGGER_ROULETTE" });
  match = gameReducer(match, { type: "ACK_TRIGGER_RESULT" });
  return gameReducer(match, { type: "ACK_MATCH_RESULT" });
}

describe("generic encounter flows", () => {
  it("runs three ordered encounters and treats two visits to the same opponent as independent nodes", () => {
    const definition = circuit(); let run = createFlow("circuit", "seed");
    expect(availableFlowNodes(definition, run).map(node => node.id)).toEqual(["qualifier"]);
    expect(startFlowNode(definition, run, "rematch")).toBe(run);
    const ids: string[] = [], seeds: string[] = [];
    for (const node of definition.nodes) {
      expect(availableFlowNodes(definition, run).map(value => value.id)).toEqual([node.id]);
      run = startFlowNode(definition, run, node.id);
      const plan = flowEncounterPlan(definition, run, { gun: definition.playerGun, comparisonBonus: 0 });
      ids.push(plan.options.id!); seeds.push(plan.seed);
      expect(plan.opponentId).toBe(node.opponentId);
      const match = acknowledged(definition, run);
      const next = finishFlowNode(definition, run, match);
      expect(finishFlowNode(definition, next, match)).toBe(next);
      expect(next.completedNodes).toContain(node.id);
      run = next;
    }
    expect(new Set(ids).size).toBe(3); expect(new Set(seeds).size).toBe(3);
    expect(run.completedNodes).toEqual(["qualifier", "rematch", "final"]);
    expect(run.phase).toBe("finished"); expect(run.result).toBe("victory");
    expect(availableFlowNodes(definition, run)).toEqual([]);
  });
  it("ends a sequential run on defeat, rejects stale results and ignores outcomes until acknowledged", () => {
    const definition = circuit(); const run = startFlowNode(definition, createFlow("loss", "seed"), "qualifier");
    const match = acknowledged(definition, run, "opponent");
    expect(finishFlowNode(definition, run, { ...match, id: "previous-table" })).toBe(run);
    expect(finishFlowNode(definition, run, { ...match, opponentId: "chatgpt" })).toBe(run);
    expect(finishFlowNode(definition, run, { ...match, scene: "match" })).toBe(run);
    const finished = finishFlowNode(definition, run, match);
    expect(finished.phase).toBe("finished"); expect(finished.result).toBe("defeat");
    expect(finished.completedNodes).toEqual([]);
    expect(startFlowNode(definition, finished, "rematch")).toBe(finished);
  });
  it("supports a single repeatable practice node and fresh table identities after an escape", () => {
    const definition = FlowDefinitionSchema.parse({ ...circuit(), nodes: [{ ...circuit().nodes[0], id: "practice", repeatable: true, routes: { victory: { type: "selection" }, defeat: { type: "selection" }, escaped: { type: "selection" } } }] });
    let run = startFlowNode(definition, createFlow("practice", "seed"), "practice");
    const won = acknowledged(definition, run); run = finishFlowNode(definition, run, won);
    expect(run.completedNodes).toEqual(["practice"]);
    run = startFlowNode(definition, run, "practice");
    expect(run.encounter!.matchId).not.toBe(won.id);
    const plan = flowEncounterPlan(definition, run, { gun: won.roulette.player, skills: capturePlayerSkills(won), comparisonBonus: 2 });
    let escaped = createMatch(plan.seed, { ...plan.options, opponentId: plan.opponentId });
    escaped = gameReducer(gameReducer(escaped, { type: "ESCAPE_MATCH" }), { type: "ACK_MATCH_RESULT" });
    const next = finishFlowNode(definition, run, escaped);
    expect(next.phase).toBe("selection"); expect(next.result).toBeNull();
    expect(next.completedNodes).toEqual(["practice"]);
    expect(availableFlowNodes(definition, next).map(node => node.id)).toEqual(["practice"]);
  });
  it("applies authored non-eight capacities before deal, preserves the carried gun and skills, and resets each opponent", () => {
    const definition = circuit(); let run = startFlowNode(definition, createFlow("guns", "seed"), "qualifier");
    const won = acknowledged(definition, run);
    expect(won.roulette.player).toEqual({ capacity: 3, bullets: 1 });
    expect(won.roulette.opponent.capacity).toBe(2);
    run = startFlowNode(definition, finishFlowNode(definition, run, won), "rematch");
    const plan = flowEncounterPlan(definition, run, { gun: won.roulette.player, skills: capturePlayerSkills(won), comparisonBonus: 3 });
    const rematch = createMatch(plan.seed, { ...plan.options, opponentId: plan.opponentId });
    expect(rematch.roulette).toEqual({ player: { capacity: 3, bullets: 1 }, opponent: { capacity: 5, bullets: 0 } });
    expect(rematch.playerSkills.cards).toEqual(won.playerSkills.cards);
    expect(rematch.playerSkills.drawCount).toBe(won.playerSkills.drawCount);
    expect(rematch.comparisonBonuses).toEqual({ player: 3, opponent: 0 });
    expect(createMatch("ordinary", { opponentId: "llama" }).roulette.player.capacity).toBe(6);
  });
  it("selects ability overrides by completed node identity rather than opponent identity", () => {
    const binding = { definitionId: "fixture", enabled: true, parameters: {}, level: 2 };
    const node = { ...circuit().nodes[2], abilities: [{ slot: "comparison", binding, overrides: [{ afterAny: ["rematch"], binding: { ...binding, level: 1 } }] }] };
    const run = { ...createFlow("slots", "seed"), completedNodes: ["qualifier"] };
    expect(flowNodeAbilities(node, run)?.[0].level).toBe(2);
    expect(flowNodeAbilities(node, { ...run, completedNodes: ["qualifier", "rematch"] })?.[0].level).toBe(1);
    expect(node.abilities[0].binding.level).toBe(2);
  });
  it("rejects duplicate nodes, broken routes/prerequisites/override references, duplicate slots and invalid guns", () => {
    const definition = circuit(), node = definition.nodes[0];
    const invalid = [
      { ...definition, nodes: [...definition.nodes, node] },
      { ...definition, nodes: [{ ...node, requires: ["missing"] }, ...definition.nodes.slice(1)] },
      { ...definition, nodes: [{ ...node, requires: [node.id] }, ...definition.nodes.slice(1)] },
      { ...definition, nodes: [{ ...node, routes: { ...node.routes, victory: { type: "node", nodeId: "missing" } } }, ...definition.nodes.slice(1)] },
      { ...definition, nodes: [{ ...node, abilities: [{ slot: "skill", binding: { definitionId: "fixture", enabled: true, parameters: {} }, overrides: [{ afterAny: ["missing"], binding: { definitionId: "fixture", enabled: false, parameters: {} } }] }] }, ...definition.nodes.slice(1)] },
      { ...definition, nodes: [{ ...node, abilities: Array(2).fill({ slot: "same", binding: { definitionId: "fixture", enabled: true, parameters: {} } }) }, ...definition.nodes.slice(1)] },
      { ...definition, playerGun: { capacity: 3, bullets: 4 } }
    ];
    for (const value of invalid) expect(FlowDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it("uses the actual outcome route when deciding whether to record a result", () => {
    const definition = circuit(), run = startFlowNode(definition, createFlow("record", "seed"), "qualifier");
    const won = acknowledged(definition, run), lost = acknowledged(definition, run, "opponent");
    expect(flowOutcomeRoute(definition, run, won)).toEqual({ type: "node", nodeId: "rematch" });
    expect(flowRecordsResult(definition, run, won)).toBe(false);
    expect(flowRecordsResult(definition, run, lost)).toBe(true);
    const always = { ...definition, nodes: definition.nodes.map(node => ({ ...node, recordResult: "always" as const })) };
    const never = { ...definition, nodes: definition.nodes.map(node => ({ ...node, recordResult: "never" as const })) };
    expect(flowRecordsResult(always, run, won)).toBe(true);
    expect(flowRecordsResult(never, run, lost)).toBe(false);
    expect(flowRecordsResult(always, run, { ...won, id: "stale" })).toBe(false);
    expect(flowOutcomeRoute(definition, run, { ...won, status: "active", outcome: undefined })).toBeUndefined();
    const escaped = { ...lost, outcome: { ...lost.outcome!, reason: "escaped" as const } };
    expect(flowOutcomeRoute(definition, run, escaped)).toEqual({ type: "finish", result: "abandoned" });
  });

  it("claims node rewards once, preserves receipts and ignores stale or losing tables", () => {
    const source = circuit();
    const definition = { ...source, nodes: source.nodes.map((node, index) => index ? node : {
      ...node, victoryRewards: { skillDraws: 2, removeBullets: 1, pointAdvantage: 3 }
    }) };
    const fresh = createFlowRun("rewards", "seed", definition);
    let run = { ...fresh, ...startFlowNode(definition, fresh, "qualifier") };
    let match = acknowledged(definition, run);
    expect(flowVictoryRewards(definition, run, match)).toEqual(definition.nodes[0].victoryRewards);
    expect(pendingFlowRewards(run, match)).toEqual(["skillDraws", "removeBullets", "pointAdvantage"]);
    const original = match;
    ({ run, match } = claimFlowReward(run, match, "skillDraws"));
    expect(match.playerSkills.drawCount).toBe(original.playerSkills.drawCount + 2);
    const claimed = claimFlowReward(run, match, "skillDraws");
    expect(claimed.run).toBe(run); expect(claimed.match).toBe(match);
    ({ run, match } = claimFlowReward(run, match, "removeBullets"));
    ({ run, match } = claimFlowReward(run, match, "pointAdvantage"));
    expect(match.roulette.player.bullets).toBe(0);
    expect(run.playerComparisonBonus).toBe(3);
    expect(run.encounter!.claimedRewards).toEqual(["skillDraws", "removeBullets", "pointAdvantage"]);
    expect(pendingFlowRewards(run, match)).toEqual([]);
    expect(FlowRunSchema.parse(run)).toEqual(run);
    expect(claimFlowReward(fresh, original, "skillDraws").run).toBe(fresh);
    const losingRun = { ...fresh, ...startFlowNode(definition, fresh, "qualifier") };
    const lost = acknowledged(definition, losingRun, "opponent");
    expect(flowVictoryRewards(definition, losingRun, lost)).toBeUndefined();
    expect(claimFlowReward(losingRun, lost, "pointAdvantage").run).toBe(losingRun);
    const overflow = { ...losingRun, playerComparisonBonus: Number.MAX_SAFE_INTEGER };
    expect(claimFlowReward(overflow, original, "pointAdvantage").run).toBe(overflow);
  });

  it("validates persisted node identity, prerequisites, phases and reward receipts", () => {
    const definition = circuit(), initial = createFlowRun("validate", "seed", definition);
    const active = { ...initial, ...startFlowNode(definition, initial, "qualifier") };
    const won = acknowledged(definition, active);
    const selection = { ...active, ...finishFlowNode(definition, active, won) };
    expect(FlowRunSchema.parse(selection)).toEqual(selection);
    const { playerGun: _gun, ...stored } = active;
    expect(StoredFlowRunSchema.parse(stored)).toEqual(stored);
    expect(FlowRunSchema.safeParse(stored).success).toBe(false);
    for (const invalid of [
      { ...active, phase: "selection" },
      { ...active, nextNodeId: "rematch" },
      { ...active, result: "victory" },
      { ...active, encounterIndex: 0 },
      { ...active, encounterIndex: Number.MAX_SAFE_INTEGER + 1 },
      { ...active, encounter: { ...active.encounter!, nodeId: "missing" } },
      { ...active, encounter: { ...active.encounter!, nodeId: "rematch" } },
      { ...active, encounter: { ...active.encounter!, claimedRewards: ["skillDraws"] } },
      { ...selection, completedNodes: ["missing"] },
      { ...selection, completedNodes: ["rematch"] },
      { ...selection, completedNodes: ["qualifier", "qualifier"], encounterIndex: 2 },
      { ...selection, nextNodeId: "qualifier" },
      { ...selection, nextNodeId: "final" },
      { ...selection, nextNodeId: "missing" }
    ]) expect(FlowRunSchema.safeParse(invalid).success).toBe(false);
    expect(FlowProgressSchema.safeParse({ ...active, definition: undefined, playerGun: undefined, playerComparisonBonus: undefined }).success).toBe(false);
    expect(FlowProgressSchema.safeParse({ ...createFlow("progress", "seed"), encounter: { nodeId: "n", matchId: "m" } }).success).toBe(false);
    const rewarded = { ...active, definition: { ...definition, nodes: definition.nodes.map((node, index) => index ? node : { ...node, victoryRewards: { skillDraws: 1 } }) },
      encounter: { ...active.encounter!, claimedRewards: ["skillDraws", "skillDraws"] } };
    expect(FlowRunSchema.safeParse(rewarded).success).toBe(false);
  });
});
