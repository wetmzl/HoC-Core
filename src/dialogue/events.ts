import type { GameEvent, MatchState } from "../core/match/types";
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
export function extractDialogueEvent(before: MatchState | undefined, after: MatchState): DialogueEvent | undefined {
  if (before === after) return undefined;
  const start = before?.history.length ?? 0;
  const history = after.history;
  let roundStart = -1;
  for (let i = history.length - 1; i >= 0; i--) if (history[i].type === "ROUND_STARTED") { roundStart = i; break; }
  const from = Math.max(0, start, roundStart);
  const find = (test: (event: GameEvent) => boolean) => {
    for (let i = history.length - 1; i >= from; i--) if (test(history[i])) return { event: history[i], index: i };
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
  if (roundStart >= start && after.round.phase !== "roulette-result" && after.round.phase !== "round-reveal") return make("core.round-start", roundStart, { roundIndex: after.roundIndex });
  return undefined;
}
export const restoreDialogueEvent = (state: MatchState) => extractDialogueEvent(undefined, state);

/** Successful ability occurrences supplement the ordinary event, without suppressing it. */
export function extractDialogueEvents(before: MatchState | undefined, after: MatchState): readonly DialogueEvent[] {
  const normal = extractDialogueEvent(before, after);
  // Restore ordinary dialogue without replaying historical ability notifications.
  if (!before || before === after) return normal ? [normal] : [];
  let from = before.history.length;
  for (let i = after.history.length - 1; i >= from; i--) {
    if (after.history[i].type === "ROUND_STARTED") { from = i; break; }
  }
  const played: DialogueEvent[] = [], triggered: DialogueEvent[] = [];
  for (let i = from; i < after.history.length; i++) {
    const event = after.history[i];
    if (event.type !== "ABILITY_PLAYED" && event.type !== "ABILITY_TRIGGERED") continue;
    const type = event.type === "ABILITY_PLAYED" ? "core.ability-played" : "core.ability-triggered";
    const data = { actor: event.owner, definitionId: event.definitionId, instanceId: event.instanceId,
      ...(event.type === "ABILITY_TRIGGERED" ? { ruleId: event.ruleId } : {}) };
    (event.type === "ABILITY_PLAYED" ? played : triggered).push({ id: `${after.id}:${after.roundIndex}:${type}:${i}`, type, apiVersion: 1, data });
  }
  const abilities = [...triggered, ...played];
  if (!normal) return abilities;
  // A played ability may also trigger other abilities; the deliberate play speaks last.
  // Final round/roulette dialogue takes precedence over the abilities that produced it.
  return ["core.round-result", "core.trigger-ready", "core.trigger-result"].includes(normal.type)
    ? [...abilities, normal] : [normal, ...abilities];
}
