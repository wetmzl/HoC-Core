import { afterEach, expect, it, vi } from "vitest";
import { createMatch, gameReducer } from "../core/match/reducer";
import type { GameEvent, MatchState } from "../core/match/types";
import { extractDialogueEvent, restoreDialogueEvent, DialogueEventRegistry } from "./events";
import { CORE_DIALOGUE_PRIMITIVES } from "./facts";
import { DialogueEngine } from "./engine";
import { DialoguePrimitiveRegistry } from "./registry";
import type { CharacterDialogue, DialogueAtom, DialogueEvent } from "./types";
const atom = (primitive: string, test: DialogueAtom["test"], args = {}): DialogueAtom => ({ primitive, apiVersion: 1, args, test });
const s = () => createMatch("event-layer");
const event = (id: string, type = "core.action"): DialogueEvent => ({ id, type, apiVersion: 1, data: type === "core.action" ? { actor: "player", action: "hit" } : { roundIndex: 0 } });
const appended = (state: MatchState, events: GameEvent[], phase = state.round.phase): MatchState => ({ ...state, history: [...state.history, ...events], round: { ...state.round, phase } });
afterEach(() => vi.restoreAllMocks());
it("coalesces actual actions against final result, round and phase", () => {
  const before = s();
  expect(extractDialogueEvent(before, before)).toBeUndefined();
  expect(extractDialogueEvent(before, appended(before, [{ type: "TURN_SKIPPED", actor: "opponent", sourceInstanceId: "neutral" }]))).toBeUndefined();
  expect(extractDialogueEvent(before, appended(before, [{ type: "ABILITY_EXPIRED", instanceId: "neutral", definitionId: "neutral", owner: "player", reason: "rounds" }]))).toBeUndefined();
  const forced = appended(before, [{ type: "PLAYER_HIT", value: 12 }, { type: "PLAYER_STOOD" }, { type: "OPPONENT_HIT", value: 14 }], "turns");
  expect(extractDialogueEvent(before, forced)).toMatchObject({ type: "core.action", data: { actor: "opponent", action: "hit" } });
  const outcome = { winner: "player", penaltyTarget: "opponent", reason: "comparison", bulletsAdded: 1 } as const;
  const result = { ...appended(forced, [{ type: "ROUND_RESOLVED", outcome }], "round-reveal"), round: { ...forced.round, phase: "round-reveal" as const, outcome } };
  expect(extractDialogueEvent(before, result)).toMatchObject({ type: "core.round-result", data: { winner: "player" } });
  const ready = { ...appended(result, [{ type: "ROUND_RESULT_ACKNOWLEDGED" }], "roulette-trigger"), round: { ...result.round, phase: "roulette-trigger" as const } };
  expect(extractDialogueEvent(result, ready)).toMatchObject({ type: "core.trigger-ready", data: { actor: "opponent" } });
  const trigger = appended(ready, [{ type: "TRIGGER_PULLED", actor: "opponent", result: "misfire", fired: false, baseProbability: 1, probability: .5, misfireChance: .5 }], "roulette-result");
  expect(extractDialogueEvent(ready, trigger)).toMatchObject({ type: "core.trigger-result", data: { result: "misfire" } });
  expect(restoreDialogueEvent(trigger)).toEqual(extractDialogueEvent(ready, trigger));
  const cancelled = appended(ready, [{ type: "PENDING_EVENT_CANCELLED", eventId: "neutral", sourceInstanceId: "neutral" }, { type: "ROUND_STARTED", roundIndex: 1 }], "turns");
  expect(extractDialogueEvent(ready, { ...cancelled, roundIndex: 1 })).toMatchObject({ type: "core.round-start", data: { roundIndex: 1 } });
});
it("real reducers generate at most one normal event, including AI and invalid actions", () => {
  let state = s(); expect(restoreDialogueEvent(state)?.type).toBe("core.round-start");
  for (let i = 0; i < 100 && state.status === "active"; i++) {
    const action = state.round.phase === "turns" ? state.round.currentActor === "player" ? { type: "PLAYER_STAND" as const } : { type: "AI_TURN" as const } : state.round.phase === "round-reveal" ? { type: "ACK_ROUND_RESULT" as const } : state.round.phase === "roulette-reaction" || state.round.phase === "roulette-trigger" ? { type: "TRIGGER_ROULETTE" as const } : { type: "ACK_TRIGGER_RESULT" as const };
    const after = gameReducer(state, action), e = extractDialogueEvent(state, after);
    if (e) expect(restoreDialogueEvent(after)).toEqual(e);
    state = after;
  }
  expect(extractDialogueEvent(state, gameReducer(state, { type: "PLAYER_HIT" }))).toBeUndefined();
});
it("random channels are event-stable and independent from every domain random cursor", () => {
  const random = CORE_DIALOGUE_PRIMITIVES.find(p => p.id === "core.random")!, state = s(), before = structuredClone(state);
  const ctx = { state, characterId: "neutral", event: event("one") };
  const value = random.read(ctx, { key: "response" }) as number;
  expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(1);
  expect(random.read(structuredClone(ctx), { key: "response" })).toBe(value);
  expect(random.read({ ...ctx, event: event("two") }, { key: "response" })).not.toBe(value);
  expect(random.read(ctx, { key: "other" })).not.toBe(value);
  expect(random.read({ state }, { key: "response" })).toBeUndefined(); expect(state).toEqual(before);
});
it("indexes subscriptions, samples once per event, and latches failures instead of opening rules", () => {
  const read = vi.fn(() => 1), registry = new DialoguePrimitiveRegistry();
  const p = { id: "value", apiVersion: 1, title: "中性", description: "中性验证", returnType: "number" as const, dependencies: ["event" as const], parameters: { type: "object", additionalProperties: false }, read };
  registry.registerPackage("test/neutral", [p], [p]);
  const program: CharacterDialogue = { pools: { FALLBACK: ["基础"], OPEN: ["开场"], ACTION: ["行动"] }, fallbackPoolId: "FALLBACK", rules: [
    { id: "opening", on: [{ type: "core.round-start", apiVersion: 1 }], when: atom("test/neutral#value", { eq: 1 }), poolId: "OPEN" },
    { id: "action", on: [{ type: "core.action", apiVersion: 1 }, { type: "missing/provider#event", apiVersion: 1 }], when: { all: [atom("test/neutral#value", { eq: 1 }), atom("test/neutral#value", { eq: 1 })] }, poolId: "ACTION" }
  ] };
  const engine = new DialogueEngine(program, "neutral", registry), state = s();
  expect(engine.peek(state).poolId).toBe("FALLBACK"); expect(read).not.toHaveBeenCalled();
  engine.commit(engine.accept(state, event("hit"))); expect(engine.peek(state).poolId).toBe("ACTION"); expect(read).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) engine.peek({ ...state });
  engine.accept(state, event("hit")); expect(read).toHaveBeenCalledTimes(1);
  read.mockReturnValue(0); const retained = engine.peek(state); engine.commit(engine.accept(state, event("miss")));
  expect(engine.peek(state)).toBe(retained); expect(read).toHaveBeenCalledTimes(2);
  read.mockReturnValue(1); engine.accept(state, event("opening", "core.round-start")); expect(read).toHaveBeenCalledTimes(3);
});
it("event registry isolates packages and rejects duplicate, undeclared or malformed publishes", () => {
  const r = new DialogueEventRegistry(), declaration = { id: "tap", apiVersion: 1, title: "中性", description: "中性事件", data: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } };
  const release = r.registerPackage("test/neutral", [declaration]);
  expect(() => r.registerPackage("test/neutral", [declaration])).toThrow("重复");
  expect(() => r.registerPackage("test/other", [{ ...declaration, id: "core.action" }])).toThrow("非法");
  expect(() => r.validate({ id: "1", type: "test/neutral#tap", apiVersion: 1, data: { n: "bad" } })).toThrow();
  expect(() => r.validate({ id: "1", type: "test/neutral#other", apiVersion: 1, data: {} })).toThrow();
  release(); expect(r.get("test/neutral#tap", 1)).toBeUndefined();
});
