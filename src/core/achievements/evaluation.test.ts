import { describe, expect, it } from "vitest";
import { evaluateAchievementCondition, evaluateAchievementNumber, evaluateAchievementValue } from "./evaluation";
import { assertAchievementObservationContract, validateAchievementInputs } from "./validation";
import { AchievementDefinitionSchema, AchievementObservationSchema } from "./schema";
import type { AchievementCondition, AchievementObservationContract } from "./types";

const input = AchievementObservationSchema.parse({ apiVersion: 1, streamId: "test", sequence: 0, at: "2026-11-09T00:00:00Z",
  topic: { type: "example.removed", apiVersion: 1 }, scopes: {}, debugUsed: false,
  values: { "source.definition-id": "collector", amount: 4, nothing: null, truth: true }, skillCards: { removed: [
    { instanceId: "one", definitionId: "skill-a", primaryDomain: "gambler", skillTags: ["gambler", "gunslinger"], tags: ["fire"], activation: "passive" },
    { instanceId: "two", definitionId: "skill-b", primaryDomain: "gunslinger", skillTags: ["gunslinger"], tags: ["fire"], activation: "action" }
  ] } });
const context = { observation: input, metrics: { previous: { type: "sum" as const, value: 8 } } };
const missing: AchievementCondition = { type: "scalar-compare", left: { type: "observation", key: "missing" }, operator: "eq", right: 0 };
const yes: AchievementCondition = { type: "scalar-compare", left: 1, operator: "eq", right: 1 };
const no: AchievementCondition = { type: "not", condition: yes };
const contract: AchievementObservationContract = { topic: input.topic, values: { "source.definition-id": "string", amount: "number", nothing: "null", truth: "boolean" }, skillCollections: ["removed"] };
const definition = () => AchievementDefinitionSchema.parse({ id: "ten", revision: 1, name: "十个", description: "累计十个目标",
  tracking: { scope: "match", tracks: [{ id: "count", on: [input.topic], progress: { type: "sum", value: { type: "skill-card-count", collection: "removed" } } }],
    completeWhen: { type: "scalar-compare", left: { type: "metric", id: "count" }, operator: "gte", right: 10 } } });

describe("achievement reads are observations, not ability transactions", () => {
  it("reuses nested arithmetic and metrics without changing inputs", () => {
    const before = JSON.stringify(context);
    expect(evaluateAchievementNumber({ type: "divide", left: { type: "add", left: { type: "metric", id: "previous" }, right: { type: "observation", key: "amount" } }, right: 2 }, context)).toBe(6);
    expect(evaluateAchievementNumber({ type: "round", value: { type: "power", left: 2, right: 3 } }, context)).toBe(8);
    expect(JSON.stringify(context)).toBe(before);
  });
  it("keeps missing values unknown under not and neq", () => {
    expect(evaluateAchievementCondition(missing, context)).toBeUndefined();
    expect(evaluateAchievementCondition({ type: "not", condition: missing }, context)).toBeUndefined();
    expect(evaluateAchievementCondition({ type: "value-compare", left: { type: "observation", key: "missing" }, operator: "neq", right: { type: "literal", value: "x" } }, context)).toBeUndefined();
  });
  it("combines three-valued conditions independently of order", () => {
    for (const conditions of [[missing, no], [no, missing]]) expect(evaluateAchievementCondition({ type: "all", conditions }, context)).toBe(false);
    for (const conditions of [[missing, yes], [yes, missing]]) expect(evaluateAchievementCondition({ type: "any", conditions }, context)).toBe(true);
    expect(evaluateAchievementCondition({ type: "all", conditions: [missing, yes] }, context)).toBeUndefined();
    expect(evaluateAchievementCondition({ type: "any", conditions: [missing, no] }, context)).toBeUndefined();
  });
  it("distinguishes an available null from an unavailable name, with no string coercion", () => {
    expect(evaluateAchievementValue({ type: "observation", key: "nothing" }, context)).toBeNull();
    expect(evaluateAchievementCondition({ type: "available", key: "nothing" }, context)).toBe(true);
    expect(evaluateAchievementCondition({ type: "available", key: "missing" }, context)).toBe(false);
    expect(evaluateAchievementCondition({ type: "value-compare", left: { type: "observation", key: "amount" }, operator: "eq", right: { type: "literal", value: "4" } }, context)).toBe(false);
    expect(evaluateAchievementNumber({ type: "observation", key: "truth" }, context)).toBeUndefined();
  });
  it("matches captured removed entities with the same filter as abilities", () => {
    expect(evaluateAchievementNumber({ type: "skill-card-count", collection: "removed", filter: { primaryDomains: ["gambler"], skillTags: ["gunslinger"], tags: ["fire"], activation: "passive" } }, context)).toBe(1);
    expect(evaluateAchievementNumber({ type: "skill-card-count", collection: "removed", filter: { definitionIds: ["skill-a", "skill-b"] } }, context)).toBe(2);
    expect(evaluateAchievementNumber({ type: "skill-card-count", collection: "inventory-after-removal" }, context)).toBeUndefined();
  });
  it("diagnoses zero division and out-of-range arithmetic instead of inventing zero", () => {
    const messages: string[] = [];
    const diagnostics = { ...context, onUnavailable: (message: string) => messages.push(message) };
    expect(evaluateAchievementNumber({ type: "divide", left: 1, right: 0 }, diagnostics)).toBeUndefined();
    expect(evaluateAchievementNumber({ type: "power", left: 2, right: 1024 }, diagnostics)).toBeUndefined();
    expect(messages).toHaveLength(2);
    expect(() => evaluateAchievementCondition({ type: "all", conditions: [] }, context)).toThrow();
  });
  it("uses explicit semantic topic versions for guards", () => {
    expect(evaluateAchievementCondition({ type: "topic-is", topic: input.topic }, context)).toBe(true);
    expect(evaluateAchievementCondition({ type: "topic-is", topic: { ...input.topic, apiVersion: 2 } }, context)).toBe(false);
    expect(evaluateAchievementCondition({ type: "all", conditions: [{ type: "topic-is", topic: { type: "example.other", apiVersion: 1 } }, missing] }, context)).toBe(false);
  });
});

describe("provider contracts are checked before execution", () => {
  it("validates names against the selected topic and the declared collection", () => {
    expect(validateAchievementInputs(definition(), [contract])).toEqual([]);
    const wrong = definition();
    expect(validateAchievementInputs(wrong, [{ ...contract, skillCollections: [] }]).map(issue => issue.code)).toContain("unknown-skill-collection");
    expect(validateAchievementInputs(wrong, []).map(issue => issue.code)).toContain("unsupported-topic");
  });
  it("reports misspelled and wrongly typed scalar queries", () => {
    const value = definition();
    const wrong = { ...value, tracking: { ...value.tracking, tracks: [{ ...value.tracking.tracks[0]!, progress: { type: "sum" as const, value: { type: "observation" as const, key: "source.definition-id" } } }] } };
    expect(validateAchievementInputs(wrong, [contract]).map(issue => issue.code)).toContain("observation-type");
    expect(validateAchievementInputs({ ...wrong, tracking: { ...wrong.tracking, completeWhen: { type: "available", key: "typo" } } }, [contract]).map(issue => issue.code)).toContain("unknown-observation");
  });
  it("allows declared unavailable fields, but rejects wrong type and undeclared data", () => {
    expect(() => assertAchievementObservationContract(input, contract)).not.toThrow();
    expect(() => assertAchievementObservationContract({ ...input, values: {} }, contract)).not.toThrow();
    expect(() => assertAchievementObservationContract({ ...input, values: { amount: "4" } }, contract)).toThrow(/类型/);
    expect(() => assertAchievementObservationContract({ ...input, values: { typo: 4 } }, contract)).toThrow(/未在/);
    expect(() => assertAchievementObservationContract(input, { ...contract, skillCollections: [] })).toThrow(/技能集合/);
  });
  it("supports explicit nullable provider types without confusing null with missing", () => {
    const nullable: AchievementObservationContract = { topic: input.topic, values: { winner: ["string", "null"] }, skillCollections: [] };
    expect(() => assertAchievementObservationContract({ ...input, values: { winner: null }, skillCards: {} }, nullable)).not.toThrow();
    expect(() => assertAchievementObservationContract({ ...input, values: { winner: "player" }, skillCards: {} }, nullable)).not.toThrow();
    expect(() => assertAchievementObservationContract({ ...input, values: { winner: 1 }, skillCards: {} }, nullable)).toThrow(/类型/);
  });
});
