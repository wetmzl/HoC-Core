import type { GameEvent, MatchState } from "../core/match/types";
import { createMatchFactBatch, type MatchFactBatch } from "../core/events";
import { assertAuthoringSchema, assertAuthoringValue } from "../content/packages/authoring-schema";
import type { DialogueEvent, DialogueEventDeclaration } from "./types";

const actor = { type: "string", enum: ["player", "opponent"] };
const nullableActor = { anyOf: [actor, { type: "null" }] };
const data = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const CORE_DIALOGUE_EVENTS: readonly DialogueEventDeclaration[] = [
  { id: "core.round-start", data: data({ roundIndex: { type: "integer", minimum: 0 } }) },
  { id: "core.action", data: data({ actor, action: { type: "string", enum: ["hit", "stand"] } }) },
  { id: "core.ability-played", data: data({ actor, definitionId: { type: "string" }, instanceId: { type: "string" } }) },
  { id: "core.ability-triggered", data: data({ actor, definitionId: { type: "string" }, instanceId: { type: "string" }, ruleId: { type: "string" } }) },
  { id: "core.round-result", data: data({ winner: nullableActor, reason: { type: "string" }, penaltyTarget: nullableActor }) },
  { id: "core.trigger-ready", data: data({ actor }) },
  { id: "core.trigger-result", data: data({ actor, result: { type: "string", enum: ["fired", "empty-chamber", "misfire"] } }) }
].map(e => ({ ...e, apiVersion: 1, title: e.id, description: `牌局对白事件：${e.id}` }));
export class DialogueEventRegistry {
  private readonly entries = new Map(CORE_DIALOGUE_EVENTS.map(e => [e.id, e]));
  get(type: string, apiVersion: number) { const e = this.entries.get(type); return e?.apiVersion === apiVersion ? e : undefined; }
  registerPackage(packageId: string, declarations: readonly DialogueEventDeclaration[]): () => void {
    const added = new Map<string, DialogueEventDeclaration>();
    for (const d of declarations) {
      if (!/^[a-z][a-z0-9-]*$/.test(d.id)) throw new Error("非法插件事件身份");
      const id = `${packageId}#${d.id}`;
      if (this.entries.has(id) || added.has(id)) throw new Error(`重复注册事件：${id}`);
      assertAuthoringSchema(d.data); added.set(id, Object.freeze({ ...d, id }));
    }
    added.forEach((d, id) => this.entries.set(id, d));
    return () => { added.forEach((_d, id) => this.entries.delete(id)); };
  }
  validate(event: DialogueEvent): void {
    const d = this.get(event.type, event.apiVersion); if (!d) throw new Error(`未声明或不支持的对白事件：${event.type}`);
    assertAuthoringValue(d.data, event.data);
  }
}
let active = new DialogueEventRegistry();
export const activeDialogueEvents = () => active;
export function installDialogueEvents(registry: DialogueEventRegistry) { active = registry; }
export function clearDialogueEvents() { active = new DialogueEventRegistry(); }

/** Coalesce a transition against its final phase; discarded rounds cannot produce dialogue. */
export function extractDialogueEventFromFacts(batch: MatchFactBatch): DialogueEvent | undefined {
  const { before, after, restored } = batch;
  if (!restored && before === after) return undefined;
  // Restoration reconstructs only the ordinary cue; it does not publish old facts.
  const facts = restored ? after.history.map((event, index) => ({ event, index })) : batch.facts;
  let roundStart = -1;
  for (let i = facts.length - 1; i >= 0; i--) if (facts[i].event.type === "ROUND_STARTED") { roundStart = i; break; }
  const from = Math.max(0, roundStart);
  const find = (test: (event: GameEvent) => boolean) => {
    for (let i = facts.length - 1; i >= from; i--) if (test(facts[i].event)) return facts[i];
    return undefined;
  };
  const make = (type: string, index: number, payload: Record<string, unknown>): DialogueEvent => ({ id: `${after.id}:${after.roundIndex}:${type}:${index}`, type, apiVersion: 1, data: payload });
  if (after.round.phase === "roulette-result") {
    const found = find(e => e.type === "TRIGGER_PULLED");
    if (found?.event.type === "TRIGGER_PULLED") return make("core.trigger-result", found.index, { actor: found.event.actor, result: found.event.result });
  }
  if (after.round.phase === "roulette-reaction" || after.round.phase === "roulette-trigger") {
    const found = find(e => e.type === "ROUND_RESULT_ACKNOWLEDGED");
    if (found && after.round.outcome?.penaltyTarget) return make("core.trigger-ready", found.index, { actor: after.round.outcome.penaltyTarget });
  }
  if (after.round.phase === "round-reveal") {
    const found = find(e => e.type === "ROUND_RESOLVED");
    if (found && after.round.outcome) return make("core.round-result", found.index, { winner: after.round.outcome.winner, reason: after.round.outcome.reason, penaltyTarget: after.round.outcome.penaltyTarget });
  }
  if (after.round.phase === "turns") {
    const found = find(e => ["PLAYER_HIT", "PLAYER_STOOD", "OPPONENT_HIT", "OPPONENT_STOOD"].includes(e.type));
    if (found) return make("core.action", found.index, { actor: found.event.type.startsWith("PLAYER") ? "player" : "opponent", action: found.event.type.endsWith("HIT") ? "hit" : "stand" });
  }
  if (roundStart >= 0 && after.round.phase !== "roulette-result" && after.round.phase !== "round-reveal") return make("core.round-start", facts[roundStart].index, { roundIndex: after.roundIndex });
  return undefined;
}
/** Compatibility adapter for callers with two snapshots. */
export function extractDialogueEvent(before: MatchState | undefined, after: MatchState): DialogueEvent | undefined {
  // Legacy snapshot queries may revisit a shorter history; they have no new cue.
  if (before && before.history.length > after.history.length) return undefined;
  return extractDialogueEventFromFacts(dialogueQueryBatch(before, after));
}
export const restoreDialogueEvent = (state: MatchState) => extractDialogueEventFromFacts(createMatchFactBatch(undefined, state, { restored: true }));

/** Successful ability occurrences supplement the ordinary event, without suppressing it. */
export function extractDialogueEventsFromFacts(batch: MatchFactBatch): readonly DialogueEvent[] {
  const { before, after } = batch;
  const normal = extractDialogueEventFromFacts(batch);
  // Restore ordinary dialogue without replaying historical ability notifications.
  if (batch.restored || !before || before === after) return normal ? [normal] : [];
  let from = 0;
  for (let i = batch.facts.length - 1; i >= 0; i--) {
    if (batch.facts[i].type === "ROUND_STARTED") { from = i; break; }
  }
  const played: DialogueEvent[] = [], triggered: DialogueEvent[] = [];
  for (const fact of batch.facts.slice(from)) {
    const event = fact.event;
    if (event.type !== "ABILITY_PLAYED" && event.type !== "ABILITY_TRIGGERED") continue;
    const type = event.type === "ABILITY_PLAYED" ? "core.ability-played" : "core.ability-triggered";
    const data = { actor: event.owner, definitionId: event.definitionId, instanceId: event.instanceId,
      ...(event.type === "ABILITY_TRIGGERED" ? { ruleId: event.ruleId } : {}) };
    (event.type === "ABILITY_PLAYED" ? played : triggered).push({ id: `${after.id}:${after.roundIndex}:${type}:${fact.index}`, type, apiVersion: 1, data });
  }
  const abilities = [...triggered, ...played];
  if (!normal) return abilities;
  // A played ability may also trigger other abilities; the deliberate play speaks last.
  // Final round/roulette dialogue takes precedence over the abilities that produced it.
  return ["core.round-result", "core.trigger-ready", "core.trigger-result"].includes(normal.type)
    ? [...abilities, normal] : [normal, ...abilities];
}
/** Compatibility adapter for callers with two snapshots. */
export function extractDialogueEvents(before: MatchState | undefined, after: MatchState): readonly DialogueEvent[] {
  if (before && before.history.length > after.history.length) return [];
  return extractDialogueEventsFromFacts(dialogueQueryBatch(before, after));
}

/** Old snapshot queries compare history cursors even when a caller changes matches. */
function dialogueQueryBatch(before: MatchState | undefined, after: MatchState): MatchFactBatch {
  if (!before || before.id === after.id) return createMatchFactBatch(before, after);
  const initial = createMatchFactBatch(undefined, after), fromIndex = before.history.length;
  return Object.freeze({ ...initial, before, fromIndex,
    facts: Object.freeze(initial.facts.slice(fromIndex)), events: Object.freeze(initial.events.slice(fromIndex)) });
}
