import { afterEach, describe, expect, it, vi } from "vitest";
import * as reducer from "../match/reducer";
import { createPublicEvent, createPublicEventBatch } from "./public-events";
import { createPublicQueryContext, PublicQuerySchema, readPublicQuery } from "./public-queries";
import { evaluatePublicCondition, matchPublicTrigger, PublicConditionSchema, PublicTriggerSpecSchema, selectPublicTriggerEvents, type PublicCondition } from "./triggers";
import { capturePublicMatchReadModel } from "./public-match-read-model";

afterEach(() => vi.restoreAllMocks());
const compare = (key: string, value: number): PublicCondition => ({ type: "compare", left: { type: "query", query: { id: "event.data", key } }, operator: "eq", right: { type: "literal", value } });
const event = createPublicEvent({ id: "match:hit", type: "match.PLAYER_HIT", scopes: { game: "game", match: "match", round: "match:0" }, data: { value: 21, actor: "player" } });
const batch = createPublicEventBatch({ id: "transition", facts: [event] });

describe("shared public conditions", () => {
  it("propagates unavailable data through not and accepts only a proven true condition", () => {
    const missing = compare("missing", 1);
    expect(evaluatePublicCondition(missing, { event, batch })).toBeUndefined();
    expect(evaluatePublicCondition({ type: "not", condition: missing }, { event, batch })).toBeUndefined();
    expect(matchPublicTrigger({ when: { type: "not", condition: missing } }, event, batch)).toBe(false);
    expect(evaluatePublicCondition({ type: "all", conditions: [missing, compare("value", 0)] }, { event, batch })).toBe(false);
    expect(evaluatePublicCondition({ type: "any", conditions: [missing, compare("value", 21)] }, { event, batch })).toBe(true);
    expect(evaluatePublicCondition({ type: "available", query: { id: "event.data", key: "missing" } }, { event, batch })).toBe(false);
  });

  it("matches the same occurrence's type, scope and payload while retaining whole batch selection", () => {
    const other = createPublicEvent({ id: "other", type: "match.PLAYER_STOOD", scopes: { match: "other" } });
    const atomic = createPublicEventBatch({ id: "atomic", facts: [event, other] });
    const trigger = { on: ["match.PLAYER_HIT"], scope: { name: "match" as const, id: "match" }, when: compare("value", 21) };
    expect(selectPublicTriggerEvents(trigger, atomic)).toEqual([event]);
    expect(matchPublicTrigger({ ...trigger, scope: { name: "match", id: "other" } }, event, atomic)).toBe(false);
    expect(atomic.facts).toEqual([event, other]);
    expect(selectPublicTriggerEvents(trigger, { ...atomic, restored: true })).toEqual([]);
  });

  it("rejects unknown topics, queries, operations, non-finite constants and extra keys", () => {
    expect(PublicTriggerSpecSchema.safeParse({ on: ["match.TYPO"] }).success).toBe(false);
    expect(PublicTriggerSpecSchema.safeParse({ on: ["rule.before-card-draw"] }).success).toBe(true);
    expect(PublicTriggerSpecSchema.safeParse({ on: ["core.duel-requested"] }).success).toBe(true);
    expect(PublicQuerySchema.safeParse({ id: "match.typo" }).success).toBe(false);
    expect(PublicQuerySchema.safeParse({ id: "match.action-available", action: "FAKE" }).success).toBe(false);
    expect(PublicQuerySchema.safeParse({ id: "match.status", arbitraryPath: "hidden" }).success).toBe(false);
    expect(PublicConditionSchema.safeParse({ ...compare("value", 21), operator: "divide" }).success).toBe(false);
    expect(PublicConditionSchema.safeParse(compare("value", Infinity)).success).toBe(false);
    expect(readPublicQuery({ id: "event.data", key: "__proto__" }, { event, batch })).toBeUndefined();
  });

  it("rejects cyclic and excessively deep content before recursive schema evaluation", () => {
    const cyclic: { type: "not"; condition?: unknown } = { type: "not" };
    cyclic.condition = cyclic;
    expect(PublicConditionSchema.safeParse(cyclic).success).toBe(false);
    let deep: unknown = compare("value", 21);
    for (let depth = 0; depth < 100; depth++) deep = { type: "not", condition: deep };
    expect(PublicConditionSchema.safeParse(deep).success).toBe(false);
    expect(PublicTriggerSpecSchema.safeParse({ when: cyclic }).success).toBe(false);
    const shared = compare("value", 21);
    expect(PublicConditionSchema.safeParse({ type: "all", conditions: [shared, shared] }).success).toBe(true);
  });

  it("keeps occurrence payload distinct from the accepted final batch snapshot", () => {
    const state = reducer.createMatch("final-state", { openingSkillCards: 0 });
    const first = createPublicEvent({ id: "first", type: "match.PLAYER_HIT", scopes: { match: state.id }, data: { value: 19 } });
    const second = createPublicEvent({ id: "second", type: "match.PLAYER_HIT", scopes: { match: state.id }, data: { value: 22 } });
    const final = createPublicEventBatch({ id: "two-hits", facts: [first, second], context: { match: state } });
    expect(readPublicQuery({ id: "event.data", key: "value" }, { event: first, batch: final })).toBe(19);
    expect(readPublicQuery({ id: "event.data", key: "value" }, { event: second, batch: final })).toBe(22);
    expect(readPublicQuery({ id: "match.phase" }, { event: first, batch: final })).toBe(state.round.phase);
    expect(readPublicQuery({ id: "match.phase" }, {})).toBeUndefined();
  });

  it("reads typed program context and game scope without requiring an active match", () => {
    const entered = createPublicEvent({ id: "entered", type: "program.node-entered", scopes: { game: "runtime", program: "run" }, data: { nodeId: "first" } });
    const program = createPublicEventBatch({ id: "program-transition", facts: [entered], context: {
      program: { id: "run", definitionId: "flow", nodeId: "second", visitIndex: 2, status: "waiting" }
    } });
    const context = createPublicQueryContext({ event: entered, batch: program });
    expect(readPublicQuery({ id: "game.id" }, context)).toBe("runtime");
    expect(readPublicQuery({ id: "program.id" }, context)).toBe("run");
    expect(readPublicQuery({ id: "program.definition-id" }, context)).toBe("flow");
    expect(readPublicQuery({ id: "program.node-id" }, context)).toBe("second");
    expect(readPublicQuery({ id: "event.data", key: "nodeId" }, context)).toBe("first");
    expect(readPublicQuery({ id: "program.visit-index" }, context)).toBe(2);
    expect(readPublicQuery({ id: "program.status" }, context)).toBe("waiting");
    expect(readPublicQuery({ id: "program.node-id" }, {})).toBeUndefined();
  });

  it("shares legality preflight only inside one evaluation context and leaves domain RNG untouched", () => {
    const state = reducer.createMatch("query-cache", { openingSkillCards: 0 });
    const before = JSON.stringify(state);
    const legal = vi.spyOn(reducer, "getLegalActions");
    const context = createPublicQueryContext({ match: state, matchQueries: capturePublicMatchReadModel(state) });
    readPublicQuery({ id: "match.action-available", action: "PLAYER_HIT" }, context);
    readPublicQuery({ id: "match.action-available", action: "PLAYER_STAND" }, context);
    readPublicQuery({ id: "match.playable-skill" }, context);
    expect(legal).toHaveBeenCalledTimes(1);
    readPublicQuery({ id: "match.action-available", action: "PLAYER_HIT" }, createPublicQueryContext({ match: state, matchQueries: capturePublicMatchReadModel(state) }));
    expect(legal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state)).toBe(before);
  });
});
