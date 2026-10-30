import { profileDialogMarkup } from "../presentation/profile-controller";
import type { FlowDefinition, FlowNode, FlowProgress, FlowRun } from "../core/flow/schema";
import { availableFlowNodes, createFlow, flowNodeAbilities } from "../core/flow/reducer";
import type { AbilityBinding } from "../core/abilities/types";
import { getAbilityDefinition } from "../core/abilities/registry";
import { skillSheetMarkup } from "../presentation/skill-sheet";
import { TABLE_BACKGROUND_URL, LOBBY_BACKGROUND_URL } from "../resources/cache-policy";
import { getCharacterMetadata, type CharacterDefinition } from "../content/characters";
import { escapeHtml } from "../presentation/view-helpers";

function portrait(characterId: string, className: string): string {
  const character = getCharacterMetadata(characterId);
  return character ? `<img class="${className}" src="${escapeHtml(character.previewImage)}" alt="${escapeHtml(character.name)}" />` : "";
}
export function flowBackgrounds(character?: CharacterDefinition) {
  return character?.profile.backgrounds ?? [{ label: "牌室", image: TABLE_BACKGROUND_URL }, { label: "赌桌", image: LOBBY_BACKGROUND_URL }];
}
function sameBinding(left: AbilityBinding, right: AbilityBinding): boolean {
  if (!left.enabled && !right.enabled) return true;
  return left.definitionId === right.definitionId && left.enabled === right.enabled && (left.level ?? 1) === (right.level ?? 1)
    && Object.keys(left.parameters).length === Object.keys(right.parameters).length
    && Object.entries(left.parameters).every(([key, value]) => Object.hasOwn(right.parameters, key) && right.parameters[key] === value);
}
function changesAfterNode(definition: FlowDefinition, nodeId: string, progress: FlowProgress = createFlow("comparison", "comparison")) {
  // Completed nodes show their current contribution; pending nodes show their prospective change.
  const beforeProgress = { ...progress, completedNodes: progress.completedNodes.filter(id => id !== nodeId) };
  const afterProgress = { ...progress, completedNodes: [...new Set([...progress.completedNodes, nodeId])] };
  return definition.nodes.flatMap(node => {
    const before = flowNodeAbilities(node, beforeProgress), after = flowNodeAbilities(node, afterProgress);
    return (node.abilities ?? []).flatMap((slot, index) => sameBinding(before![index], after![index]) ? []
      : [{ slot, before: before![index], after: after![index] }]);
  });
}
export function flowSkillComparisonTitle(definition: FlowDefinition, nodeId: string, progress?: FlowProgress): string {
  return changesAfterNode(definition, nodeId, progress).map(({ slot, before }) => slot.label ?? getAbilityDefinition(before.definitionId, undefined, before.level)?.name ?? slot.slot).join("、");
}
function objective(node: FlowNode, name: string): string {
  return escapeHtml(node.presentation?.objective ?? "挑战 {name}").replaceAll("{name}", `<strong>${escapeHtml(name)}</strong>`);
}
function nodeAttributes(node: FlowNode, available: boolean): string {
  return `data-flow-node="${escapeHtml(node.id)}" data-encounter="${escapeHtml(node.opponentId)}" ${available ? "" : "disabled data-unavailable"}`;
}
export function renderFlowSelection(run: FlowRun, reducedMotion = false, projection?: { visibleIds: readonly string[]; availableIds: readonly string[] }): string {
  const definition = run.definition;
  const comparisonLabel = definition.presentation?.comparisonLabel ?? "技能说明";
  const available = new Set(projection?.availableIds ?? availableFlowNodes(definition, run).map(node => node.id));
  const visible = definition.nodes.filter(node => !projection || projection.visibleIds.includes(node.id));
  const cards = visible.filter(node => node.presentation?.layout !== "action");
  const actions = visible.filter(node => node.presentation?.layout === "action");
  const comparisonButton = (node: FlowNode): string => {
    const labels = flowSkillComparisonTitle(definition, node.id, run);
    return labels ? `<button type="button" class="challenge-guard-skill" data-flow-info="${escapeHtml(node.id)}" data-comparison-title="${escapeHtml(labels)}" data-guard-info="${escapeHtml(node.opponentId)}" aria-label="查看${escapeHtml(labels)}${escapeHtml(comparisonLabel)}"><span>${escapeHtml(labels)}</span><span class="challenge-skill-info" aria-hidden="true">i</span></button>` : "";
  };
  const cardMarkup = cards.map(node => {
    const name = getCharacterMetadata(node.opponentId)?.name ?? node.opponentId;
    const completed = run.completedNodes.includes(node.id);
    const completedLabel = node.presentation?.completedLabel ?? "已完成";
    return `<article class="challenge-guard-card ${completed ? "is-defeated" : ""}"><button class="challenge-guard ${completed ? "is-defeated" : ""}" ${nodeAttributes(node, available.has(node.id))} aria-label="${escapeHtml(name)}${available.has(node.id) ? "，查看个人档案" : completed ? `，${escapeHtml(completedLabel)}` : "，尚未开放"}">${portrait(node.opponentId, "challenge-guard-portrait")}${completed ? `<span class="challenge-guard-state">${escapeHtml(completedLabel)}</span>` : ""}</button><div class="challenge-guard-copy"><p class="challenge-guard-goal">${objective(node, name)}</p>${comparisonButton(node)}</div></article>`;
  }).join("");
  const actionMarkup = actions.map(node => {
    const name = getCharacterMetadata(node.opponentId)?.name ?? node.opponentId;
    const slots = node.abilities ?? [];
    const changed = slots.filter(slot => slot.overrides.some(override => override.afterAny.some(id => run.completedNodes.includes(id)))).length;
    const progress = node.presentation?.progressLabel ? `<span class="challenge-boss-progress">（${escapeHtml(node.presentation.progressLabel)}${changed}/${slots.length}）</span>` : "";
    return `<button class="challenge-direct challenge-choice-action challenge-boss-action" ${nodeAttributes(node, available.has(node.id))}><span class="challenge-boss-action-copy">${objective(node, name)}${progress}</span><span class="challenge-boss-action-arrow" aria-hidden="true">→</span></button>${comparisonButton(node)}`;
  }).join("");
  return `<main class="challenge-shell challenge-selection" data-reduced-motion="${reducedMotion}"><header class="challenge-selection-heading"><h1>${escapeHtml(definition.presentation?.title ?? definition.id)}</h1>${definition.presentation?.description ? `<p>${escapeHtml(definition.presentation.description)}</p>` : ""}</header>${cards.length ? `<div class="challenge-grid">${cardMarkup}</div>` : ""}<p role="status" data-encounter-status></p><div class="challenge-choice-actions">${actionMarkup}<button class="challenge-choice-action challenge-terminate" data-abandon>${escapeHtml(definition.presentation?.abandonLabel ?? "结束流程")}</button></div><dialog class="challenge-skill-dialog" aria-labelledby="challenge-compare-title"><button class="challenge-compare-close" data-compare-close aria-label="关闭${escapeHtml(comparisonLabel)}">×</button><h2 id="challenge-compare-title" class="challenge-compare-name"></h2><div data-compare-body></div></dialog>${profileDialogMarkup()}</main>`;
}
export function renderFlowSkillComparison(definition: FlowDefinition, nodeId: string, progress?: FlowProgress): string {
  return changesAfterNode(definition, nodeId, progress).map(({ slot, before: beforeBinding, after: afterBinding }) => {
    const before = getAbilityDefinition(beforeBinding.definitionId, undefined, beforeBinding.level);
    const after = afterBinding.enabled ? getAbilityDefinition(afterBinding.definitionId, undefined, afterBinding.level) : undefined;
    const copy = (enabled: boolean, skill: typeof before) => enabled && skill ? skill : { name: slot.label ?? slot.slot, description: enabled ? "效果说明尚未提供。" : "该技能停用。", profileLore: undefined, usage: undefined };
    return `<section class="challenge-skill-comparison"><div class="challenge-skill-before">${skillSheetMarkup(copy(beforeBinding.enabled, before), { showName: false, open: true })}</div><div class="challenge-skill-arrow" aria-hidden="true"><svg viewBox="0 0 240 88" fill="none"><g class="challenge-arrow-ornament" stroke="currentColor" stroke-width="1"><path d="M18 43h51l12-10 12 10-12 10-12-10M222 43h-51l-12-10-12 10 12 10 12-10"/><path d="m43 43 8-6 8 6-8 6zM197 43l-8-6-8 6 8 6zM120 4l7 8-7 8-7-8zM120 74l5 6-5 6-5-6z"/></g><path class="challenge-arrow-spine" d="M120 24v37m-14-12 14 14 14-14m-23 0 9 9 9-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path class="challenge-arrow-flow" d="M120 23v39" pathLength="100" stroke="#fff0c8" stroke-width="3" stroke-linecap="round"/><circle class="challenge-arrow-spark" cx="120" cy="12" r="2" fill="#fff0c8"/></svg></div><div class="challenge-skill-after">${skillSheetMarkup(copy(afterBinding.enabled, after), { showName: false, open: true })}</div></section>`;
  }).join("");
}
