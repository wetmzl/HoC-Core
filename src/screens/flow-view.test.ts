import { describe, expect, it } from "vitest";
import { FlowDefinitionSchema } from "../core/flow/schema";
import { createFlowRun } from "../core/flow/reducer";
import { flowSkillComparisonTitle, renderFlowSelection, renderFlowSkillComparison } from "./flow-view";
import { challengeFlow, challengeProgress } from "../core/challenge/flow";
import { createChallenge } from "../core/challenge/reducer";
import legacyTrial from "../core/challenge/fixtures/legacy-challenge.json";
import { ChallengeDefinitionSchema as LegacyChallengeSchema } from "../core/challenge/schema";
const getChallenges = () => [LegacyChallengeSchema.parse(legacyTrial)];
import { CHARACTER_CATALOG } from "../content/characters";
import { getAbilityDefinition } from "../core/abilities/registry";
import { skillSheetMarkup } from "../presentation/skill-sheet";

describe("flow selection projection", () => {
  it("addresses repeated opponents by node and renders plain flows without challenge metadata", () => {
    const routes = { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "selection" } };
    const definition = FlowDefinitionSchema.parse({ id: "practice", playerGun: { capacity: 3, bullets: 0 }, nodes: [
      { id: "first", opponentId: "llama", routes },
      { id: "again", opponentId: "llama", requires: ["first"], routes }
    ] });
    const run = createFlowRun("practice-run", "practice-seed", definition);
    const markup = renderFlowSelection(run);
    expect(markup).toContain('data-flow-node="first" data-encounter="llama"  aria-label=');
    expect(markup).toContain('data-flow-node="again" data-encounter="llama" disabled data-unavailable');
    expect(markup).not.toContain("data-flow-info=");
    expect(markup).not.toContain("削弱阶段");
    const next = renderFlowSelection({ ...run, encounterIndex: 1, completedNodes: ["first"], nextNodeId: "again" });
    expect(next).toContain('data-flow-node="first" data-encounter="llama" disabled data-unavailable');
    expect(next).toContain('data-flow-node="again" data-encounter="llama"  aria-label=');
  });
  it("derives change comparisons from dependency node identities and preserves existing challenge layout", () => {
    const source = getChallenges()[0];
    const legacy = createChallenge("render", source, source.guards.map(guard => ({ opponentId: guard.characterId, timestamp: "2026-10-27T00:00:00Z" })), CHARACTER_CATALOG);
    const definition = challengeFlow(source);
    const run = { ...challengeProgress(legacy), definition, playerGun: legacy.playerGun, playerComparisonBonus: 0 };
    const guard = definition.nodes[0];
    const title = flowSkillComparisonTitle(definition, guard.id);
    expect(title).toBe(source.bossAbilities.filter(ability => source.guards[0].suppresses.includes(ability.slot)).map(ability => ability.label).join("、"));
    expect(renderFlowSkillComparison(definition, guard.id)).toContain("challenge-skill-before");
    expect(renderFlowSkillComparison(definition, guard.id)).toContain("challenge-skill-after");
    expect(renderFlowSkillComparison(definition, guard.opponentId)).toBe("");
    const markup = renderFlowSelection({ ...run, encounterIndex: 1, completedNodes: [guard.id] });
    expect(markup.match(/class="challenge-guard-card /g)).toHaveLength(4);
    expect(markup).toContain(`data-flow-info="${guard.id}"`);
    expect(markup).toContain(`（已削弱${source.guards[0].suppresses.length}/${source.bossAbilities.length}）`);
    expect(markup).toContain("终止挑战");
    expect(markup).toContain('aria-label="关闭削弱说明"');
    expect(markup).toContain(`aria-label="查看${title}削弱说明"`);
  });
  it("compares effective bindings in override order and exposes action-node changes only while they contribute", () => {
    const ability = getChallenges()[0].bossAbilities.find(slot => slot.weakenedBinding?.enabled)!;
    const routes = { victory: { type: "selection" }, defeat: { type: "selection" }, escaped: { type: "selection" } };
    const definition = FlowDefinitionSchema.parse({ id: "ordered-overrides", playerGun: { capacity: 6, bullets: 0 }, nodes: [
      { id: "strong", opponentId: "llama", routes },
      { id: "mild", opponentId: "llama", presentation: { layout: "action" }, routes },
      { id: "target", opponentId: "chatgpt", abilities: [{ slot: "effect", label: "Effect", binding: ability.binding, overrides: [
        { afterAny: ["strong"], binding: { ...ability.binding, enabled: false } },
        { afterAny: ["mild"], binding: ability.weakenedBinding }
      ] }], routes }
    ] });
    const run = createFlowRun("compare-run", "compare-seed", definition);
    expect(renderFlowSelection(run)).toContain('data-flow-info="mild"');
    const mild = { ...run, encounterIndex: 1, completedNodes: ["mild"] };
    const weaker = getAbilityDefinition(ability.weakenedBinding!.definitionId, undefined, ability.weakenedBinding!.level)!;
    const comparison = renderFlowSkillComparison(definition, "strong", mild);
    expect(comparison).toContain(`<div class="challenge-skill-before">${skillSheetMarkup(weaker, { showName: false, open: true })}</div>`);
    expect(comparison).toContain("该技能停用。");
    expect(renderFlowSelection(mild)).toContain('data-flow-info="mild"');
    const strong = { ...run, encounterIndex: 1, completedNodes: ["strong"] };
    expect(flowSkillComparisonTitle(definition, "mild", strong)).toBe("");
    expect(renderFlowSkillComparison(definition, "mild", strong)).toBe("");
    expect(renderFlowSelection(strong)).not.toContain('data-flow-info="mild"');
    const both = { ...strong, encounterIndex: 2, completedNodes: ["mild", "strong"] };
    expect(renderFlowSkillComparison(definition, "strong", both)).toBe(comparison);
    expect(renderFlowSelection(both)).toContain('data-flow-info="strong"');
    expect(renderFlowSelection(both)).not.toContain('data-flow-info="mild"');
  });
});
