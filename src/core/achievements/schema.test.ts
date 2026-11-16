import { describe, expect, it } from "vitest";
import { SKILL_TAGS } from "../skills/types";
import {
  ACHIEVEMENT_LIMITS, AchievementCatalogSchema, AchievementConditionSchema, AchievementDefinitionSchema,
  AchievementKeySchema, AchievementLedgerSchema, AchievementNumberSchema, AchievementObservationContractSchema,
  AchievementObservationSchema, AchievementTrackingSchema, AchievementValueSchema, assertAchievementBudget
} from "./schema";
import type { AchievementScope, AchievementTracking } from "./types";

const topic = { type: "example.skills-removed", apiVersion: 1 };
const key = "example/achievements#main/ten-cards";
const at = "2026-11-09T05:00:00.000Z";
const threshold = { type: "scalar-compare" as const, left: { type: "metric" as const, id: "removed" }, operator: "gte" as const, right: 10 };

function tracking(scope: AchievementScope = "match") {
  return {
    scope, completion: "immediate", continuity: "continuous", allowDebug: false,
    tracks: [{ id: "removed", on: [{ ...topic }], progress: { type: "count" } }],
    completeWhen: structuredClone(threshold)
  } satisfies AchievementTracking;
}

function definition() {
  return { id: "ten-cards", revision: 1, name: "收集十张", description: "在一场牌局内收集十张牌。", tracking: tracking() };
}

function observation() {
  return {
    apiVersion: 1, streamId: "profile-stream", sequence: 0, at, topic: { ...topic },
    scopes: { run: "run-1", match: "match-1", round: "round-1" }, debugUsed: false,
    values: { count: 2, source: "neutral-removal", enabled: true, optional: null },
    skillCards: { removed: [{ instanceId: "removed-card", definitionId: "neutral-skill", primaryDomain: "gambler",
      skillTags: ["gambler", "cheater"], tags: ["neutral"], activation: "action" }] }
  };
}

function ledger(rule: AchievementTracking = tracking(), metrics: unknown = { removed: { type: "count", value: 2 } }) {
  return {
    schemaVersion: 1, streamId: "profile-stream", nextSequence: 4,
    windows: { match: { id: "match-1", status: "active" } },
    records: { [key]: { revision: 1, tracking: rule, scopeId: "match-1", metrics, invalidated: false, suspended: false } }
  };
}

describe("achievement declaration boundaries", () => {
  it.each<AchievementScope>(["profile", "run", "match", "round"])("defaults policy fields for %s without changing the chosen scope", scope => {
    const value = tracking(scope);
    const { completion: _completion, continuity: _continuity, allowDebug: _allowDebug, ...input } = value;
    expect(AchievementTrackingSchema.parse(input)).toEqual(value);
  });

  it("accepts shared arithmetic around observation and metric leaves", () => {
    const input = { ...definition(), tracking: { ...tracking(), completeWhen: {
      type: "scalar-compare", operator: "gte", left: { type: "floor", value: { type: "divide", left: { type: "metric", id: "removed" }, right: 2 } }, right: 5
    } } };
    expect(AchievementDefinitionSchema.parse(input)).toEqual(input);
    expect(AchievementNumberSchema.parse({ type: "skill-card-count", collection: "removed", filter: { skillTags: ["cheater"], activation: "passive" } })).toMatchObject({ collection: "removed" });
  });

  it.each([
    { ...definition(), priority: 10 },
    { ...definition(), tracking: { ...tracking(), chance: 0.5 } },
    { ...definition(), tracking: { ...tracking(), tracks: [{ ...tracking().tracks[0], effects: [] }] } },
    { ...definition(), tracking: { ...tracking(), tracks: [{ ...tracking().tracks[0], progress: { type: "count", value: 1 } }] } },
    { ...definition(), tracking: { ...tracking(), completeWhen: { ...threshold, tolerance: 0.1 } } }
  ])("rejects undeclared behavior instead of silently dropping fields: %j", input => {
    expect(AchievementDefinitionSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { type: "effect-result", key: "removed" },
    { type: "parameter", key: "amount" },
    { type: "hand-total", target: "owner" },
    { type: "bust-limit", target: "rival" },
    { type: "add", left: 1, right: { type: "status-number", target: "owner", statusDefinitionId: "counter", key: "value" } }
  ])("does not admit skill-only scalar leaves through a shared arithmetic node: %j", input => {
    expect(AchievementNumberSchema.safeParse(input).success).toBe(false);
  });

  it("keeps typed equality distinct from numeric ordering and skill condition windows", () => {
    expect(AchievementConditionSchema.safeParse({ type: "value-compare", left: { type: "literal", value: "10" }, operator: "eq", right: { type: "literal", value: 10 } }).success).toBe(true);
    expect(AchievementConditionSchema.safeParse({ type: "value-compare", left: { type: "literal", value: "a" }, operator: "gt", right: { type: "literal", value: "b" } }).success).toBe(false);
    expect(AchievementConditionSchema.safeParse({ type: "scalar-compare", left: "10", operator: "gte", right: 10 }).success).toBe(false);
    expect(AchievementConditionSchema.safeParse({ type: "pending-defeat-can-prevent", target: "owner" }).success).toBe(false);
  });

  it("rejects duplicate track identities and unresolved metrics in every completion policy", () => {
    expect(AchievementTrackingSchema.safeParse({ ...tracking(), tracks: [...tracking().tracks, ...tracking().tracks] }).success).toBe(false);
    for (const location of ["completeWhen", "resetWhen", "invalidateWhen"]) {
      const input = { ...tracking(), [location]: { ...threshold, left: { type: "metric", id: "missing" } } };
      expect(AchievementTrackingSchema.safeParse(input).success).toBe(false);
    }
  });

  it.each([
    { progress: { type: "sum", value: { type: "metric", id: "removed" } } },
    { progress: { type: "max", value: { type: "add", left: 1, right: { type: "metric", id: "other" } } } },
    { progress: { type: "distinct", limit: 10, value: { type: "numeric", value: { type: "metric", id: "other" } } } },
    { when: { type: "not", condition: { ...threshold, left: { type: "metric", id: "other" } } } }
  ])("rejects same-track and cross-track reads during an update: %j", change => {
    const input = { ...tracking(), tracks: [{ ...tracking().tracks[0], ...change }, { id: "other", progress: { type: "count" } }] };
    expect(AchievementTrackingSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate topic subscriptions while permitting explicitly versioned alternatives", () => {
    expect(AchievementTrackingSchema.safeParse({ ...tracking(), tracks: [{ ...tracking().tracks[0], on: [topic, topic] }] }).success).toBe(false);
    expect(AchievementTrackingSchema.safeParse({ ...tracking(), tracks: [{ ...tracking().tracks[0], on: [topic, { ...topic, apiVersion: 2 }] }] }).success).toBe(true);
  });

  it("keeps catalog-local identities unique and qualified identities unambiguous", () => {
    expect(AchievementCatalogSchema.safeParse({ achievements: [definition(), definition()] }).success).toBe(false);
    expect(AchievementKeySchema.parse(key)).toBe(key);
    for (const invalid of ["ten-cards", "example/achievements/main/ten-cards", "example/achievements#main/../ten-cards", "example/achievements#main/ten-cards/extra"]) {
      expect(AchievementKeySchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("cumulative achievements", () => {
  it("accepts positive profile thresholds and positive all/any combinations", () => {
    for (const completeWhen of [threshold, { type: "all", conditions: [threshold] }, { type: "any", conditions: [{ ...threshold, operator: "gt", right: { type: "constant", value: 5 } }] }]) {
      expect(AchievementTrackingSchema.safeParse({ ...tracking("profile"), continuity: "cumulative", completeWhen }).success).toBe(true);
    }
  });

  it.each<AchievementScope>(["run", "match", "round"])("does not resume discontinuous %s attempts as cumulative totals", scope => {
    expect(AchievementTrackingSchema.safeParse({ ...tracking(scope), continuity: "cumulative" }).success).toBe(false);
  });

  it.each([
    { resetWhen: threshold }, { invalidateWhen: threshold }, { completion: "scope-end" }, { tracks: [] },
    { completeWhen: { type: "not", condition: threshold } },
    { completeWhen: { ...threshold, operator: "eq" } },
    { completeWhen: { ...threshold, operator: "lte" } },
    { completeWhen: { ...threshold, right: 0 } },
    { completeWhen: { ...threshold, right: -1 } },
    { completeWhen: { ...threshold, right: { type: "observation", key: "goal" } } },
    { completeWhen: { type: "available", key: "source" } }
  ])("rejects cumulative policies that cannot retain a positive monotonic threshold: %j", change => {
    expect(AchievementTrackingSchema.safeParse({ ...tracking("profile"), continuity: "cumulative", ...change }).success).toBe(false);
  });

  it("does not invent an end boundary or permanent invalidation for profile scope", () => {
    expect(AchievementTrackingSchema.safeParse({ ...tracking("profile"), completion: "scope-end" }).success).toBe(false);
    expect(AchievementTrackingSchema.safeParse({ ...tracking("profile"), invalidateWhen: threshold }).success).toBe(false);
    expect(AchievementTrackingSchema.safeParse({ ...tracking("match"), completion: "scope-end", invalidateWhen: threshold }).success).toBe(true);
  });
});

describe("optional progress display hints", () => {
  it("accepts a display target without replacing the actual completion condition", () => {
    const input = { ...definition(), progressDisplay: { metric: "removed", target: 100 } };
    const parsed = AchievementDefinitionSchema.parse(input);
    expect(parsed.progressDisplay).toEqual(input.progressDisplay);
    expect(parsed.tracking.completeWhen).toEqual(threshold);
  });

  it("rejects absent metrics, nonpositive targets and undeclared display behavior", () => {
    for (const progressDisplay of [
      { metric: "missing", target: 10 }, { metric: "removed", target: 0 }, { metric: "removed", target: -1 },
      { metric: "removed", target: Infinity }, { metric: "removed", target: Number.MAX_SAFE_INTEGER + 1 },
      { metric: "removed", target: 10, unlockWhenFull: true }
    ]) expect(AchievementDefinitionSchema.safeParse({ ...definition(), progressDisplay }).success).toBe(false);
  });

  it("does not display fractional targets for indivisible count progress", () => {
    expect(AchievementDefinitionSchema.safeParse({ ...definition(), progressDisplay: { metric: "removed", target: 0.5 } }).success).toBe(false);
  });

  it("keeps distinct display targets integral and within retained distinct capacity", () => {
    const input = { ...definition(), tracking: { ...tracking(), tracks: [{ id: "removed", progress: {
      type: "distinct", value: { type: "observation", key: "source" }, limit: 3
    } }] } };
    expect(AchievementDefinitionSchema.safeParse({ ...input, progressDisplay: { metric: "removed", target: 3 } }).success).toBe(true);
    for (const target of [4, 2.5]) expect(AchievementDefinitionSchema.safeParse({ ...input, progressDisplay: { metric: "removed", target } }).success).toBe(false);
  });

  it("permits fractional presentation targets for sum and maximum measurements", () => {
    for (const type of ["sum", "max"]) {
      const input = { ...definition(), tracking: { ...tracking(), tracks: [{ id: "removed", progress: { type, value: { type: "observation", key: "count" } } }] } };
      expect(AchievementDefinitionSchema.safeParse({ ...input, progressDisplay: { metric: "removed", target: 0.5 } }).success).toBe(true);
    }
  });
});

describe("observation contracts and immutable skill metadata", () => {
  it.each(SKILL_TAGS)("accepts real skill domain metadata: %s", tag => {
    const input = observation();
    input.skillCards.removed[0].primaryDomain = tag;
    input.skillCards.removed[0].skillTags = [tag];
    expect(AchievementObservationSchema.parse(input).skillCards.removed[0]).toMatchObject({ primaryDomain: tag, skillTags: [tag] });
  });

  it.each([
    { primaryDomain: "unknown" }, { skillTags: ["unknown"] }, { skillTags: [] },
    { activation: "manual" }, { instanceId: "" }, { definitionId: "" }, { level: 1 }
  ])("rejects untyped or incomplete captured skill metadata: %j", change => {
    const input = observation();
    expect(AchievementObservationSchema.safeParse({ ...input, skillCards: { removed: [{ ...input.skillCards.removed[0], ...change }] } }).success).toBe(false);
  });

  it("rejects duplicate instance identities within one captured collection", () => {
    const input = observation(), card = input.skillCards.removed[0];
    expect(AchievementObservationSchema.safeParse({ ...input, skillCards: { removed: [card, { ...card }] } }).success).toBe(false);
    expect(AchievementObservationSchema.safeParse({ ...input, skillCards: { removed: [card, { ...card, instanceId: "another-card" }] } }).success).toBe(true);
    expect(AchievementObservationSchema.safeParse({ ...input, skillCards: { removed: [card], other: [card] } }).success).toBe(true);
  });

  it("requires topic identity and version, with unsupported contracts rejected at their own version boundary", () => {
    for (const invalid of [{ type: topic.type }, { apiVersion: 1 }, { ...topic, apiVersion: 0 }, { ...topic, apiVersion: 1.5 }, { ...topic, extra: true }]) {
      expect(AchievementObservationSchema.safeParse({ ...observation(), topic: invalid }).success).toBe(false);
    }
    expect(AchievementObservationSchema.safeParse({ ...observation(), apiVersion: 2 }).success).toBe(false);
    expect(AchievementLedgerSchema.safeParse({ ...ledger(), schemaVersion: 2 }).success).toBe(false);
    expect(AchievementObservationSchema.safeParse({ ...observation(), scopes: {}, topic: { ...topic, apiVersion: 2 } }).success).toBe(true);
  });

  it.each(["run", "match", "round"] as const)("requires a matching %s ID for both boundary phases", scope => {
    for (const boundary of [{ scope, phase: "begin" }, { scope, phase: "end", reason: "completed" }]) {
      const input = { ...observation(), boundary };
      expect(AchievementObservationSchema.safeParse(input).success).toBe(true);
      const scopes = { ...input.scopes };
      Reflect.deleteProperty(scopes, scope);
      expect(AchievementObservationSchema.safeParse({ ...input, scopes }).success).toBe(false);
      expect(AchievementObservationSchema.safeParse({ ...input, scopes: { ...scopes, [scope]: "" } }).success).toBe(false);
    }
  });

  it("rejects unspecified end reasons and profile boundaries", () => {
    for (const boundary of [{ scope: "match", phase: "end" }, { scope: "match", phase: "end", reason: "victory" }, { scope: "profile", phase: "begin" }]) {
      expect(AchievementObservationSchema.safeParse({ ...observation(), boundary }).success).toBe(false);
    }
  });

  it("checks provider declarations without treating them as observed values", () => {
    const contract = { topic, values: { count: "number", source: "string", enabled: "boolean", optional: "null" }, skillCollections: ["removed"] };
    expect(AchievementObservationContractSchema.parse(contract)).toEqual(contract);
    expect(AchievementObservationContractSchema.safeParse({ ...contract, values: { count: "integer" } }).success).toBe(false);
    expect(AchievementObservationContractSchema.safeParse({ ...contract, skillCollections: ["removed", "removed"] }).success).toBe(false);
  });

  it("accepts nullable provider types while rejecting empty, repeated or unsupported type alternatives", () => {
    const input = { topic, values: { source: ["string", "null"], count: "number" }, skillCollections: ["removed"] };
    expect(AchievementObservationContractSchema.parse(input)).toEqual(input);
    expect(AchievementObservationContractSchema.safeParse({ ...input, values: { source: ["string"] } }).success).toBe(true);
    for (const source of [[], ["string", "string"], ["string", "undefined"]]) {
      expect(AchievementObservationContractSchema.safeParse({ ...input, values: { source } }).success).toBe(false);
    }
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects a sequence that cannot be a durable exact cursor: %s", sequence => {
    expect(AchievementObservationSchema.safeParse({ ...observation(), sequence }).success).toBe(false);
    expect(AchievementLedgerSchema.safeParse({ ...ledger(), nextSequence: sequence }).success).toBe(false);
  });
});

describe("ledger evidence integrity", () => {
  it("binds profile progress to its durable stream rather than another window ID", () => {
    const input = ledger(tracking("profile"));
    expect(AchievementLedgerSchema.safeParse(input).success).toBe(false);
    expect(AchievementLedgerSchema.safeParse({ ...input, records: { [key]: { ...input.records[key], scopeId: input.streamId } } }).success).toBe(true);
  });

  it("accepts a ledger whose metrics and completed proof agree with its frozen tracking rule", () => {
    const input = ledger();
    const record = input.records[key];
    expect(AchievementLedgerSchema.safeParse({ ...input, records: { [key]: { ...record, completed: { at, sequence: 3, revision: 1 } } } }).success).toBe(true);
  });

  it.each([
    {}, { removed: { type: "sum", value: 2 } }, { other: { type: "count", value: 2 } },
    { removed: { type: "count", value: 2 }, extra: { type: "count", value: 0 } },
    { removed: { type: "count", value: -1 } }, { removed: { type: "count", value: 0.5 } }
  ])("rejects missing, extra, differently typed or malformed persisted metrics: %j", metrics => {
    expect(AchievementLedgerSchema.safeParse(ledger(tracking(), metrics)).success).toBe(false);
  });

  it("keeps distinct values typed, unique and within the declared finite limit", () => {
    const rule: AchievementTracking = { ...tracking(), tracks: [{ id: "removed", progress: { type: "distinct", value: { type: "observation", key: "source" }, limit: 3 } }] };
    expect(AchievementLedgerSchema.safeParse(ledger(rule, { removed: { type: "distinct", values: [1, "1", null] } })).success).toBe(true);
    for (const values of [["a", "a"], [0, -0], [1, "1", null, true]]) {
      expect(AchievementLedgerSchema.safeParse(ledger(rule, { removed: { type: "distinct", values } })).success).toBe(false);
    }
  });

  it("permits an unobserved max while rejecting negative or non-finite aggregate state", () => {
    for (const type of ["sum", "max"] as const) {
      const rule: AchievementTracking = { ...tracking(), tracks: [{ id: "removed", progress: { type, value: { type: "observation", key: "count" } } }] };
      expect(AchievementLedgerSchema.safeParse(ledger(rule, { removed: { type, value: 0.5 } })).success).toBe(true);
      expect(AchievementLedgerSchema.safeParse(ledger(rule, { removed: { type, value: null } })).success).toBe(type === "max");
      for (const value of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(AchievementLedgerSchema.safeParse(ledger(rule, { removed: { type, value } })).success).toBe(false);
      }
    }
  });

  it.each([
    { sequence: 4, revision: 1 }, { sequence: 5, revision: 1 }, { sequence: -1, revision: 1 },
    { sequence: 3, revision: 2 }, { sequence: 3.5, revision: 1 }
  ])("rejects completion evidence ahead of the durable cursor or belonging to another revision: %j", proof => {
    const input = ledger();
    expect(AchievementLedgerSchema.safeParse({ ...input, records: { [key]: { ...input.records[key], completed: { at, ...proof } } } }).success).toBe(false);
  });
});

describe("bounded untrusted achievement input", () => {
  it.each(["all", "any"])("does not let an empty %s become an accidental completion rule", type => {
    expect(AchievementConditionSchema.safeParse({ type, conditions: [] }).success).toBe(false);
  });

  it("rejects depth, node and collection overflow before recursive validation", () => {
    let expression: unknown = 1;
    for (let depth = 0; depth <= ACHIEVEMENT_LIMITS.depth; depth++) expression = { type: "abs", value: expression };
    const deep = AchievementNumberSchema.safeParse(expression);
    expect(deep.success).toBe(false);
    if (!deep.success) expect(deep.error.issues[0].message).toContain("预算");
    const manyNodes = Array.from({ length: ACHIEVEMENT_LIMITS.collection }, () => Array(8).fill(0));
    expect(() => assertAchievementBudget(manyNodes)).toThrow("预算");
    expect(() => assertAchievementBudget(Array(ACHIEVEMENT_LIMITS.collection).fill(0))).not.toThrow();
    expect(() => assertAchievementBudget(Array(ACHIEVEMENT_LIMITS.collection + 1).fill(0))).toThrow("集合过大");
    expect(AchievementConditionSchema.safeParse({ type: "all", conditions: Array.from({ length: 33 }, () => ({ type: "available", key: "source" })) }).success).toBe(false);
  });

  it("checks sparse array length before a recursive parser can traverse its holes", () => {
    const sparse = new Array(ACHIEVEMENT_LIMITS.collection + 1);
    expect(Object.keys(sparse)).toEqual([]);
    expect(() => assertAchievementBudget(sparse)).toThrow("集合过大");
    expect(AchievementConditionSchema.safeParse({ type: "all", conditions: sparse }).success).toBe(false);
  });

  it("rejects cyclic SDK objects as validation issues rather than overflowing the stack", () => {
    const cyclic: { type: "not"; condition?: unknown } = { type: "not" };
    cyclic.condition = cyclic;
    expect(() => AchievementConditionSchema.safeParse(cyclic)).not.toThrow();
    expect(AchievementConditionSchema.safeParse(cyclic).success).toBe(false);
  });

  it("rejects inherited expression fields and prototype-hidden cycles before Zod can copy them", () => {
    const inherited = Object.create({ type: "abs", value: 1 });
    expect(AchievementNumberSchema.safeParse(inherited).success).toBe(false);
    const prototype: { type: "not"; condition?: unknown } = { type: "not" };
    const cyclic = Object.create(prototype);
    prototype.condition = cyclic;
    expect(() => assertAchievementBudget(cyclic)).toThrow("普通 JSON 对象");
    expect(() => AchievementConditionSchema.safeParse(cyclic)).not.toThrow();
    expect(AchievementConditionSchema.safeParse(cyclic).success).toBe(false);
  });

  it("rejects array prototypes that supply uninspected elements", () => {
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, [{ type: "available", key: "source" }]);
    expect(Array.isArray(inherited)).toBe(true);
    expect(Object.keys(inherited)).toEqual([]);
    expect(() => assertAchievementBudget(inherited)).toThrow("普通 JSON 对象");
    expect(AchievementConditionSchema.safeParse({ type: "all", conditions: inherited }).success).toBe(false);
  });

  it("rejects own accessors without invoking them on objects or arrays", () => {
    let reads = 0;
    const expression = { type: "abs" };
    Object.defineProperty(expression, "value", { enumerable: true, get: () => { reads++; return 1; } });
    const conditions: unknown[] = [];
    Object.defineProperty(conditions, 0, { enumerable: true, get: () => { reads++; return { type: "available", key: "source" }; } });
    expect(AchievementNumberSchema.safeParse(expression).success).toBe(false);
    expect(AchievementConditionSchema.safeParse({ type: "all", conditions }).success).toBe(false);
    expect(reads).toBe(0);
  });

  it("rejects hidden and symbol fields rather than dropping uninspected data", () => {
    const hidden = { type: "abs", value: 1 };
    Object.defineProperty(hidden, "ignored", { value: hidden, enumerable: false });
    const symbol = Object.assign([{ type: "available", key: "source" }], { [Symbol("ignored")]: true });
    expect(AchievementNumberSchema.safeParse(hidden).success).toBe(false);
    expect(AchievementConditionSchema.safeParse({ type: "all", conditions: symbol }).success).toBe(false);
  });

  it("retains safe null-prototype dictionaries used by standalone SDK callers", () => {
    const input = observation();
    const values = Object.assign(Object.create(null), input.values);
    expect(AchievementObservationSchema.parse({ ...input, values }).values).toEqual(input.values);
    expect(AchievementNumberSchema.parse(Object.assign(Object.create(null), { type: "abs", value: 1 }))).toEqual({ type: "abs", value: 1 });
  });

  it.each(["__proto__", "prototype", "constructor"])("rejects reserved object keys and names while retaining ordinary literal text: %s", reserved => {
    const input = { ...observation(), values: JSON.parse(`{"${reserved}":1}`) };
    expect(AchievementObservationSchema.safeParse(input).success).toBe(false);
    expect(AchievementTrackingSchema.safeParse({ ...tracking(), tracks: [{ id: reserved, progress: { type: "count" } }], completeWhen: { ...threshold, left: { type: "metric", id: reserved } } }).success).toBe(false);
    expect(AchievementValueSchema.parse({ type: "literal", value: reserved })).toEqual({ type: "literal", value: reserved });
  });

  it("caps declarations and rejects non-finite or unsafe numeric constants", () => {
    expect(AchievementTrackingSchema.safeParse({ ...tracking(), tracks: Array.from({ length: ACHIEVEMENT_LIMITS.tracks }, (_, index) => ({ id: `track-${index}`, progress: { type: "count" } })), completeWhen: { ...threshold, left: { type: "metric", id: "track-0" } } }).success).toBe(true);
    expect(AchievementTrackingSchema.safeParse({ ...tracking(), tracks: Array.from({ length: ACHIEVEMENT_LIMITS.tracks + 1 }, (_, index) => ({ id: `track-${index}`, progress: { type: "count" } })), completeWhen: { ...threshold, left: { type: "metric", id: "track-0" } } }).success).toBe(false);
    expect(AchievementCatalogSchema.safeParse({ achievements: Array.from({ length: ACHIEVEMENT_LIMITS.definitions }, (_, index) => ({ ...definition(), id: `achievement-${index}` })) }).success).toBe(true);
    expect(AchievementCatalogSchema.safeParse({ achievements: Array.from({ length: ACHIEVEMENT_LIMITS.definitions + 1 }, (_, index) => ({ ...definition(), id: `achievement-${index}` })) }).success).toBe(false);
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(AchievementNumberSchema.safeParse(value).success).toBe(false);
      expect(AchievementValueSchema.safeParse({ type: "literal", value }).success).toBe(false);
    }
  });
});
