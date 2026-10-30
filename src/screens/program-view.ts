import type { ProgramRun, ProgramFacts } from "../core/flow/program";
import { currentProgramNode, programChoiceOptions } from "../core/flow/program-engine";
import type { FlowRun } from "../core/flow/schema";
import { renderFlowSelection } from "./flow-view";
import { getCharacterMetadata } from "../content/characters";
import { profileDialogMarkup } from "../presentation/profile-controller";
import { escapeHtml } from "../presentation/view-helpers";

/** Compatibility is a view projection only; eligibility always comes from the program. */
export function legacyProgramView(run: ProgramRun): FlowRun | undefined {
  const definition = run.definition.legacyDefinition;
  if (!definition) return undefined;
  return { id: run.id, seed: run.seed, definition, phase: "selection", completedNodes: run.completed.filter(id => definition.nodes.some(node => node.id === id)),
    encounterIndex: run.results.length, encounter: null, result: null, playerGun: run.resources?.gun ?? definition.playerGun,
    playerComparisonBonus: run.resources?.comparisonBonus ?? 0 };
}
export function renderProgramChoice(run: ProgramRun, facts: ProgramFacts, reducedMotion = false): string {
  const legacy = legacyProgramView(run), node = currentProgramNode(run);
  if (legacy && node.type === "choice" && node.options.every(option => legacy.definition.nodes.some(item => item.id === option.id)))
    return renderFlowSelection(legacy, reducedMotion, { visibleIds: node.options.map(option => option.id), availableIds: programChoiceOptions(run, facts).map(option => option.id) });
  if (node.type !== "choice") throw new Error("当前节点不是选择");
  const available = new Set(programChoiceOptions(run, facts).map(option => option.id));
  return `<main class="challenge-shell challenge-selection"><header class="challenge-selection-heading"><h1>${escapeHtml(node.title ?? run.definition.presentation?.title ?? run.definition.id)}</h1>${node.description ? `<p>${escapeHtml(node.description)}</p>` : ""}</header><div class="challenge-choice-actions">${node.options.map(option => {
    const character = option.characterId ? getCharacterMetadata(option.characterId) : undefined;
    return `<button class="challenge-choice-action secondary-button" data-flow-node="${escapeHtml(option.id)}" ${available.has(option.id) ? "" : "disabled"}>${escapeHtml(option.label ?? character?.name ?? option.id)}</button>`;
  }).join("")}<button class="challenge-choice-action challenge-terminate" data-abandon>${escapeHtml(run.definition.presentation?.abandonLabel ?? "结束流程")}</button></div><p role="status" data-encounter-status></p>${profileDialogMarkup()}</main>`;
}
export function renderProgramPresentation(run: ProgramRun): string {
  const node = currentProgramNode(run);
  if (node.type !== "presentation") throw new Error("当前节点不是展示");
  return `<main class="challenge-shell challenge-selection"><h1>${escapeHtml(node.title ?? run.definition.presentation?.title ?? "")}</h1><div class="program-copy">${escapeHtml(node.body).replaceAll("\n", "<br>")}</div><p role="status" data-encounter-status></p><button class="primary-button" data-program-confirm>${escapeHtml(node.actionLabel ?? "继续")}</button></main>`;
}
