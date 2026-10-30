import { z } from "zod";
import type { GunState } from "../roulette/types";
import { FlowDefinitionSchema, type FlowDefinition, type FlowNode, type FlowRoute } from "./schema";
import { singleEncounterFlow } from "./single";
import { MatchInitSpecSchema, type MatchInitSpec } from "./initialization";
import { ProgramDefinitionSchema, type ProgramCondition, type ProgramDefinition, type ProgramEffect, type ProgramNode, type ProgramReward } from "./program";

function eligible(node: FlowNode): ProgramCondition {
  return { type: "all", conditions: [...node.requires.map(nodeId => ({ type: "completed" as const, nodeId })),
    ...(node.repeatable ? [] : [{ type: "not" as const, condition: { type: "completed" as const, nodeId: node.id } }])] };
}
function rewards(node: FlowNode): ProgramReward[] {
  const authored = node.victoryRewards;
  if (!authored) return [];
  const result: ProgramReward[] = [];
  if (authored.skillDraws) result.push({ id: "skillDraws", label: "技能抽数", effects: [{ id: "grant", type: "resource", resource: "skillDraws", operation: "add", value: authored.skillDraws }] });
  if (authored.removeBullets) result.push({ id: "removeBullets", label: "左轮子弹", effects: [{ id: "remove", type: "resource", resource: "bullets", operation: "add", value: -authored.removeBullets, clamp: true }] });
  if (authored.pointAdvantage) result.push({ id: "pointAdvantage", label: "点数优势", effects: [{ id: "grant", type: "resource", resource: "comparisonBonus", operation: "add", value: authored.pointAdvantage }] });
  return result;
}
/** Old content is translated at the boundary; all execution thereafter uses the same program graph. */
export function compileLegacyFlow(input: FlowDefinition): ProgramDefinition {
  const definition = FlowDefinitionSchema.parse(input);
  let prefix = "__program:";
  while (definition.nodes.some(node => node.id.startsWith(prefix))) prefix = `_${prefix}`;
  const start = `${prefix}initialize`, selection = `${prefix}selection`;
  const nodes: ProgramNode[] = [{ id: start, type: "initialize", resources: { gun: definition.playerGun, player: "clear", comparisonBonus: 0 }, next: selection }];
  const option = (node: FlowNode) => ({ id: node.id, characterId: node.opponentId, to: node.id, when: eligible(node), ...(node.presentation ? { presentation: node.presentation } : {}) });
  nodes.push({ id: selection, type: "choice", ...(definition.presentation?.title ? { title: definition.presentation.title } : {}),
    ...(definition.presentation?.description ? { description: definition.presentation.description } : {}), options: definition.nodes.map(option) });
  const routeTarget = (route: FlowRoute): string => route.type === "selection" ? selection : route.type === "finish" ? `${prefix}end:${route.result}` : `${prefix}route:${route.nodeId}`;
  const targeted = new Set(definition.nodes.flatMap(node => Object.values(node.routes).flatMap(route => route.type === "node" ? [route.nodeId] : [])));
  for (const target of targeted) {
    const node = definition.nodes.find(node => node.id === target)!;
    nodes.push({ id: `${prefix}route:${target}`, type: "choice", options: [option(node)] });
  }
  for (const node of definition.nodes) {
    const route = (outcome: "victory" | "defeat" | "escaped"): string => {
      const authored = node.routes[outcome];
      if (outcome === "escaped" && authored.type !== "finish") {
        if (node.recordResult !== "always") return routeTarget(authored);
        const id = `${prefix}escape:${node.id}`;
        nodes.push({ id, type: "effect", effects: [{ id: "record", type: "record-result", source: node.id }], next: routeTarget(authored) });
        return id;
      }
      const id = `${prefix}settle:${node.id}:${outcome}`;
      const effects: ProgramEffect[] = node.recordResult === "always" || (node.recordResult !== "never" && authored.type === "finish")
        ? [{ id: "record", type: "record-result", source: node.id }] : [];
      nodes.push({ id, type: "settlement", source: node.id, rewards: outcome === "victory" ? rewards(node) : [], effects,
        confirmation: "required", ...(definition.presentation?.continueLabel && authored.type !== "finish" ? { continueLabel: definition.presentation.continueLabel } : {}), next: routeTarget(authored) });
      return id;
    };
    nodes.push({ id: node.id, type: "match", opponentId: node.opponentId,
      init: { playerGun: { mode: "inherit" }, playerSkills: { mode: "inherit" }, ...(node.opponentGun ? { opponentGun: { mode: "replace", value: node.opponentGun } } : {}) },
      ...(node.abilities ? { abilities: node.abilities } : {}), ...(node.presentation ? { presentation: node.presentation } : {}),
      escapePresentation: node.routes.escaped.type === "finish" ? "summary" : "immediate",
      routes: { victory: route("victory"), defeat: route("defeat"), escaped: route("escaped") } });
  }
  for (const result of ["victory", "defeat", "abandoned"] as const) nodes.push({ id: `${prefix}end:${result}`, type: "end", result,
    effects: result === "victory" && definition.completionId ? [{ id: "complete", type: "complete-flow", flowId: definition.id, legacyChallengeId: definition.completionId }] : [] });
  return ProgramDefinitionSchema.parse({ version: 2, id: definition.id, start, ...(definition.presentation ? { presentation: definition.presentation } : {}), nodes, legacyDefinition: definition });
}

export function encounterSequenceProgram(definition: FlowDefinition): ProgramDefinition { return compileLegacyFlow(definition); }
export function singleMatchProgram(options: { id?: string; opponentId: string; init?: MatchInitSpec; playerGun?: GunState; opponentGun?: GunState; presentation?: FlowDefinition["presentation"] }): ProgramDefinition {
  const legacy = singleEncounterFlow(options.opponentId, options.playerGun, options.opponentGun);
  const definition = compileLegacyFlow({ ...legacy, ...(options.id ? { id: options.id } : {}), ...(options.presentation ? { presentation: options.presentation } : {}) });
  return ProgramDefinitionSchema.parse({ ...definition, nodes: definition.nodes.map(node => node.id === definition.start && node.type === "initialize" ? { ...node, next: "match" }
    : node.type === "match" ? { ...node, init: { ...node.init, ...options.init } } : node) });
}
export const ProgramTemplateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single-match"), id: z.string().min(1).optional(), opponentId: z.string().min(1), init: MatchInitSpecSchema.optional() }).strict(),
  z.object({ type: z.literal("encounter-sequence"), definition: FlowDefinitionSchema }).strict()
]);
export type ProgramTemplate = z.input<typeof ProgramTemplateSchema>;
export function instantiateProgramTemplate(value: ProgramTemplate): ProgramDefinition {
  const template = ProgramTemplateSchema.parse(value);
  return template.type === "single-match" ? singleMatchProgram(template) : encounterSequenceProgram(template.definition);
}
