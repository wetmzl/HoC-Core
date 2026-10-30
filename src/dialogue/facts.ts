import { SeededRng } from "../core/rng/seeded";
import { handValue } from "../core/blackjack/hand";
import type { Card } from "../core/blackjack/types";
import type { MatchState } from "../core/match/types";
import type { DialogueAnchor, DialoguePrimitive, DialoguePrimitiveContext, DialogueScalar } from "./types";
import type { AuthoringSchema } from "../content/packages/authoring-schema";

const empty = { type: "object", properties: {}, additionalProperties: false };
const actor = { type: "string", enum: ["player", "opponent"] };
const actorArgs = { type: "object", properties: { actor }, required: ["actor"], additionalProperties: false };
const histories = new WeakMap<object, ReturnType<typeof collectHistory>>();
function collectHistory(state: DialoguePrimitiveContext["state"]) {
  const indices: Record<DialogueAnchor, number> = { "dialogue-event": -1, "round-start": -1, "last-action": -1, "last-player-action": -1, "last-opponent-action": -1, "round-result": -1, "round-acknowledged": -1, "trigger-result": -1 };
  const actions: Record<string, string | null> = { any: null, player: null, opponent: null };
  const counts: Record<string, number> = { player: 0, opponent: 0, "player:hit": 0, "player:stand": 0, "opponent:hit": 0, "opponent:stand": 0 };
  const abilityPlays: Record<string, number> = { player: 0, opponent: 0 };
  let hands: Record<string, Card[]> = { player: [], opponent: [] };
  let resultHands: Record<string, Card[]> = hands;
  for (let i = 0; i < state.history.length; i++) {
    const event = state.history[i];
    if (event.type === "ROUND_STARTED") { indices["round-start"] = i; indices["last-action"] = indices["last-player-action"] = indices["last-opponent-action"] = -1; actions.any = actions.player = actions.opponent = null; Object.keys(counts).forEach(k => counts[k] = 0); Object.keys(abilityPlays).forEach(k => delete abilityPlays[k]); abilityPlays.player = abilityPlays.opponent = 0; hands = { player: [], opponent: [] }; }
    if (event.type === "ABILITY_PLAYED") { abilityPlays[event.owner]++; const key = `${event.owner}:${event.definitionId}`; abilityPlays[key] = (abilityPlays[key] ?? 0) + 1; }
    if (event.type === "HAND_CARD_DISCARDED") hands[event.actor] = hands[event.actor].filter(card => card.id !== event.cardId);
    if (event.type === "HAND_REDEALT") hands[event.actor] = [];
    if (event.type === "CARD_DEALT") hands[event.actor].push(event.card as Card);
    if (event.type === "ROUND_RESOLVED") { indices["round-result"] = i; resultHands = { player: [...hands.player], opponent: [...hands.opponent] }; }
    if (event.type === "ROUND_RESULT_ACKNOWLEDGED") indices["round-acknowledged"] = i;
    if (event.type === "TRIGGER_PULLED") indices["trigger-result"] = i;
    const who = event.type === "PLAYER_HIT" || event.type === "PLAYER_STOOD" ? "player" : event.type === "OPPONENT_HIT" || event.type === "OPPONENT_STOOD" ? "opponent" : null;
    if (who) { const kind = event.type.endsWith("HIT") ? "hit" : "stand"; indices["last-action"] = indices[`last-${who}-action`] = i; actions.any = actions[who] = kind; counts[who]++; counts[`${who}:${kind}`]++; }
  }
  return { indices, actions, counts, resultHands, abilityPlays };
}
export function historyFacts(state: DialoguePrimitiveContext["state"]) { let h = histories.get(state); if (!h) { h = collectHistory(state); histories.set(state, h); } return h; }
export function anchorIndex(state: MatchState, anchor: DialogueAnchor = "last-action"): number {
  const h = historyFacts(state); return h.indices[anchor] >= 0 ? h.indices[anchor] : h.indices["round-start"];
}
function total(ctx: DialoguePrimitiveContext, args: Readonly<Record<string, unknown>>): number | undefined {
  const who = args.actor as "player" | "opponent";
  if (args.snapshot === "round-result") { const cards = historyFacts(ctx.state).resultHands[who]; return cards.length >= 2 ? handValue({ cards }) : undefined; }
  return handValue(ctx.state[who].hand as { cards: readonly Card[] });
}
const handArgs = { type: "object", properties: { actor, snapshot: { type: "string", enum: ["current", "round-result"] } }, required: ["actor"], additionalProperties: false };
const primitive = (id: string, returnType: DialoguePrimitive["returnType"], dependencies: DialoguePrimitive["dependencies"], parameters: AuthoringSchema, read: DialoguePrimitive["read"]): DialoguePrimitive => ({ id: `core.${id}`, apiVersion: 1, title: id, description: `只读牌局事实：${id}`, returnType, dependencies, parameters, read });
export const CORE_DIALOGUE_PRIMITIVES: readonly DialoguePrimitive[] = Object.freeze([
  primitive("event-type", "string", ["event"], empty, c => c.event?.type),
  primitive("event-actor", "string", ["event"], empty, c => c.event ? c.event.data.actor as string ?? null : undefined),
  primitive("event-action", "string", ["event"], empty, c => c.event ? c.event.data.action as string ?? null : undefined),
  primitive("event-ability-id", "string", ["event"], empty, c => c.event ? ["core.ability-played", "core.ability-triggered"].includes(c.event.type) ? c.event.data.definitionId as string : null : undefined),
  primitive("event-ability-rule-id", "string", ["event"], empty, c => c.event ? c.event.type === "core.ability-triggered" ? c.event.data.ruleId as string : null : undefined),
  primitive("ability-play-count", "number", ["history"], { type: "object", properties: { actor, definitionId: { type: "string", minLength: 1 } }, required: ["actor"], additionalProperties: false }, (c, a) => historyFacts(c.state).abilityPlays[a.definitionId === undefined ? String(a.actor) : `${a.actor}:${a.definitionId}`] ?? 0),
  primitive("random", "number", ["event"], { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 128 } }, required: ["key"], additionalProperties: false }, (c, a) => c.event ? new SeededRng(c.state.rng.dialogue.seed).derive(JSON.stringify([c.characterId, c.event.id, a.key])).next() : undefined),
  primitive("phase", "string", ["phase"], empty, c => c.state.round.phase),
  primitive("match-status", "string", ["match"], empty, c => c.state.status),
  primitive("match-winner", "string", ["match"], empty, c => c.state.outcome?.winner ?? null),
  primitive("round-number", "number", ["round"], empty, c => c.state.roundIndex + 1),
  primitive("current-actor", "string", ["round"], empty, c => c.state.round.currentActor),
  primitive("penalty-target", "string", ["round"], empty, c => c.state.round.outcome?.penaltyTarget ?? null),
  primitive("round-winner", "string", ["round"], empty, c => c.state.round.outcome?.winner ?? null),
  primitive("round-reason", "string", ["round"], empty, c => c.state.round.outcome?.reason ?? null),
  primitive("last-action", "string", ["history"], { type: "object", properties: { actor: { type: "string", enum: ["any", "player", "opponent"] } }, required: ["actor"], additionalProperties: false }, (c, a) => historyFacts(c.state).actions[String(a.actor)]),
  primitive("last-action-actor", "string", ["history"], empty, c => { const h = historyFacts(c.state); return h.indices["last-action"] < 0 ? null : h.indices["last-player-action"] === h.indices["last-action"] ? "player" : "opponent"; }),
  primitive("action-count", "number", ["history"], { type: "object", properties: { actor, kind: { type: "string", enum: ["all", "hit", "stand"] } }, required: ["actor", "kind"], additionalProperties: false }, (c, a) => historyFacts(c.state).counts[a.kind === "all" ? String(a.actor) : `${a.actor}:${a.kind}`]),
  primitive("stood", "boolean", ["hands", "round"], actorArgs, (c, a) => c.state[a.actor as "player" | "opponent"].stood),
  primitive("busted", "boolean", ["hands", "round"], actorArgs, (c, a) => c.state[a.actor as "player" | "opponent"].busted),
  primitive("hand-total", "number", ["hands", "history"], handArgs, total),
  primitive("hands-total-equal", "boolean", ["hands", "history"], { type: "object", properties: { snapshot: { type: "string", enum: ["current", "round-result"] } }, additionalProperties: false }, (c, a) => { const p = total(c, { ...a, actor: "player" }), o = total(c, { ...a, actor: "opponent" }); return p === undefined || o === undefined ? undefined : p === o; }),
  primitive("gun-bullets", "number", ["roulette"], actorArgs, (c, a) => c.state.roulette[a.actor as "player" | "opponent"].bullets),
  primitive("gun-capacity", "number", ["roulette"], actorArgs, (c, a) => c.state.roulette[a.actor as "player" | "opponent"].capacity),
  primitive("roulette-probability", "number", ["roulette", "abilities", "history", "round"], { type: "object", properties: { actor, basis: { type: "string", enum: ["base", "effective"] } }, required: ["actor", "basis"], additionalProperties: false }, (c, a) => {
    if (c.state.round.phase === "roulette-result") { const event = c.state.history[historyFacts(c.state).indices["trigger-result"]]; return event?.type === "TRIGGER_PULLED" && event.actor === a.actor ? a.basis === "base" ? event.baseProbability : event.probability : undefined; }
    const pending = c.pendingTrigger;
    if (pending && pending.actor === a.actor) return pending.cancelled ? undefined : a.basis === "base" ? pending.baseProbability : pending.probability;
    if (a.basis === "base") { const g = c.state.roulette[a.actor as "player" | "opponent"]; return g.bullets / g.capacity; }
    return undefined;
  }),
  primitive("trigger-actor", "string", ["history", "phase"], empty, c => { const event = c.state.history[historyFacts(c.state).indices["trigger-result"]]; return c.state.round.phase === "roulette-result" && event?.type === "TRIGGER_PULLED" ? event.actor : undefined; }),
  primitive("trigger-result", "string", ["history", "phase"], empty, c => { const event = c.state.history[historyFacts(c.state).indices["trigger-result"]]; return c.state.round.phase === "roulette-result" && event?.type === "TRIGGER_PULLED" ? event.result : undefined; }),
  primitive("defeat-prevented", "boolean", ["history", "phase"], actorArgs, (c, a) => {
    const index = historyFacts(c.state).indices["trigger-result"];
    const event = c.state.history[index];
    return c.state.round.phase === "roulette-result" && event?.type === "TRIGGER_PULLED" && event.actor === a.actor
      && c.state.history.slice(index + 1).some(event => event.type === "DEFEAT_PREVENTED" && event.actor === a.actor);
  }),
  primitive("status-present", "boolean", ["abilities"], { type: "object", properties: { actor, definitionId: { type: "string", minLength: 1 } }, required: ["actor", "definitionId"], additionalProperties: false }, (c, a) => c.state.abilities.statuses.some(s => s.owner === a.actor && s.statusDefinitionId === a.definitionId))
]);
export function matchesTest(value: DialogueScalar, test: import("./types").DialogueTest): boolean {
  if ("eq" in test) return value === test.eq;
  if (typeof value !== "number") return false;
  const r = test.range;
  return (r.min === undefined || (r.minInclusive === false ? value > r.min : value >= r.min)) && (r.max === undefined || (r.maxInclusive === false ? value < r.max : value <= r.max));
}
