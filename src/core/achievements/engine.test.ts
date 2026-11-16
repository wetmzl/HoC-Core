import { describe, expect, it } from "vitest";
import { advanceAchievements, createAchievementLedger } from "./engine";
import { AchievementDefinitionSchema, AchievementLedgerSchema } from "./schema";
import type { AchievementCondition, AchievementDefinition, AchievementDefinitionEntry, AchievementLedger, AchievementObservation, AchievementObservationContract, AchievementTracking, AchievementWindowScope } from "./types";

const signal = { type: "example/skills-removed", apiVersion: 1 } as const;
const lifecycle = { type: "example/lifecycle", apiVersion: 1 } as const;
const key = "example/package#achievements/ten-skills";
const contracts: readonly AchievementObservationContract[] = [
  { topic: signal, values: { amount: "number", item: "string", reset: "boolean", fail: "boolean", blocked: "boolean", guard: "boolean" }, skillCollections: ["removed"] },
  { topic: lifecycle, values: { blocked: "boolean" }, skillCollections: [] }
];
const threshold = (id: string, target: number): AchievementCondition => ({ type: "scalar-compare", left: { type: "metric", id }, operator: "gte", right: target });
function definition(tracking: Partial<AchievementTracking> = {}, revision = 1): AchievementDefinition {
  return AchievementDefinitionSchema.parse({ id: "ten-skills", revision, name: "Collect ten", description: "Count successful removals", tracking: {
    scope: "profile", completion: "immediate", continuity: "continuous", allowDebug: false,
    tracks: [{ id: "removed", on: [signal], progress: { type: "sum", value: { type: "observation", key: "amount" } } }],
    completeWhen: threshold("removed", 10), ...tracking
  } });
}
function entry(value = definition(), entryKey = key): AchievementDefinitionEntry { return { key: entryKey, definition: { ...value, id: entryKey.split("/").at(-1)! } }; }
function observation(sequence: number, extra: Partial<AchievementObservation> = {}): AchievementObservation {
  return { apiVersion: 1, streamId: "example-profile", sequence, at: "2026-11-09T01:00:00.000Z", topic: signal,
    scopes: {}, debugUsed: false, values: { amount: 1 }, skillCards: {}, ...extra };
}
function begin(sequence: number, scope: AchievementWindowScope = "match", id = "match-a"): AchievementObservation {
  return observation(sequence, { topic: lifecycle, scopes: { [scope]: id }, boundary: { scope, phase: "begin" }, values: {} });
}
function end(sequence: number, reason: "completed" | "abandoned" | "aborted" = "completed", scope: AchievementWindowScope = "match", id = "match-a"): AchievementObservation {
  return observation(sequence, { topic: lifecycle, scopes: { [scope]: id }, boundary: { scope, phase: "end", reason }, values: {} });
}
function apply(ledger: AchievementLedger, input: AchievementObservation, entries: readonly AchievementDefinitionEntry[] = [entry()]) {
  return advanceAchievements(entries, ledger, input, contracts);
}
function metric(ledger: AchievementLedger, id = "removed", recordKey = key) { return ledger.records[recordKey].metrics[id]; }

describe("achievement semantic stream reducer", () => {
  it("taints a debug begin even when its semantic topic is unsupported", () => {
    const entries = [entry(definition({ scope: "match" }))];
    const start = { ...begin(0), topic: { type: "future/lifecycle", apiVersion: 99 }, debugUsed: true };
    const first = apply(createAchievementLedger("example-profile"), start, entries);
    expect(first.ledger.records[key].invalidated).toBe(true);
    const result = apply(first.ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 10 } }), entries);
    expect(result.completed).toEqual([]);
    expect(result.ledger.nextSequence).toBe(2);
  });

  it.each(["continuous", "cumulative"] as const)("applies %s profile debug policy on unknown topics", continuity => {
    const entries = [entry(definition({ continuity }))];
    let ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } }), entries).ledger;
    ledger = apply(ledger, observation(1, { topic: { type: "future/debug", apiVersion: 1 }, debugUsed: true }), entries).ledger;
    expect(metric(ledger)).toEqual({ type: "sum", value: continuity === "continuous" ? 0 : 6 });
    expect(apply(ledger, observation(2, { values: { amount: 4 } }), entries).completed).toHaveLength(continuity === "continuous" ? 0 : 1);
  });

  it("allows explicitly opted-in debug windows while still ignoring unknown-topic aggregation", () => {
    const entries = [entry(definition({ scope: "match", allowDebug: true }))];
    const start = { ...begin(0), topic: { type: "future/lifecycle", apiVersion: 99 }, debugUsed: true };
    const first = apply(createAchievementLedger("example-profile"), start, entries);
    expect(first.ledger.records[key].invalidated).toBe(false);
    expect(apply(first.ledger, observation(1, { scopes: { match: "match-a" }, debugUsed: true, values: { amount: 10 } }), entries).completed).toHaveLength(1);
  });

  it("sums six plus four successful entities while separately counting two signals", () => {
    const entries = [entry(definition({ scope: "match", tracks: [
      { id: "removed", on: [signal], progress: { type: "sum", value: { type: "observation", key: "amount" } } },
      { id: "signals", on: [signal], progress: { type: "count" } }
    ], completeWhen: { type: "all", conditions: [threshold("removed", 10), threshold("signals", 2)] } }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    const first = apply(ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 6 } }), entries);
    expect(first.completed).toEqual([]);
    ledger = first.ledger;
    const second = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 4 } }), entries);
    expect(metric(second.ledger)).toEqual({ type: "sum", value: 10 });
    expect(metric(second.ledger, "signals")).toEqual({ type: "count", value: 2 });
    expect(second.completed).toEqual([{ key, completion: { at: observation(2).at, sequence: 2, revision: 1 } }]);
    expect(apply(second.ledger, observation(3), entries).completed).toEqual([]);
  });

  it("filters captured skill cards using the shared fields before summing their cardinality", () => {
    const entries = [entry(definition({ tracks: [{ id: "removed", on: [signal], progress: { type: "sum", value: {
      type: "skill-card-count", collection: "removed", filter: { primaryDomains: ["gambler", "cheater"], tags: ["counted"], activation: "action" }
    } } }], completeWhen: threshold("removed", 2) }))];
    const subject = { instanceId: "card-a", definitionId: "example/card", primaryDomain: "gambler" as const,
      skillTags: ["gambler" as const], tags: ["counted"], activation: "action" as const };
    const result = apply(createAchievementLedger("example-profile"), observation(0, { skillCards: { removed: [
      subject, { ...subject, instanceId: "card-b", primaryDomain: "cheater" },
      { ...subject, instanceId: "card-c", activation: "passive" }, { ...subject, instanceId: "card-d", tags: [] }
    ] } }), entries);
    expect(metric(result.ledger)).toEqual({ type: "sum", value: 2 });
    expect(result.completed).toHaveLength(1);
  });

  it("updates every independent track before evaluating one completion condition", () => {
    const entries = [entry(definition({ tracks: [
      { id: "a", on: [signal], progress: { type: "count" } }, { id: "b", on: [signal], progress: { type: "count" } }
    ], completeWhen: { type: "scalar-compare", left: { type: "add", left: { type: "metric", id: "a" }, right: { type: "metric", id: "b" } }, operator: "eq", right: 2 } }))];
    expect(apply(createAchievementLedger("example-profile"), observation(0), entries).completed).toHaveLength(1);
  });

  it.each(["run", "match", "round"] as const)("opens %s only on begin and completes at its matching successful end", scope => {
    const entries = [entry(definition({ scope, completion: "scope-end", completeWhen: threshold("removed", 1) }))];
    let result = apply(createAchievementLedger("example-profile"), observation(0, { scopes: { [scope]: "scope-a" } }), entries);
    expect(result.ledger.records[key]).toBeUndefined();
    result = apply(result.ledger, begin(1, scope, "scope-a"), entries);
    result = apply(result.ledger, observation(2, { scopes: { [scope]: "scope-a" } }), entries);
    expect(result.completed).toEqual([]);
    result = apply(result.ledger, end(3, "completed", scope, "scope-a"), entries);
    expect(result.completed).toHaveLength(1);
    expect(result.ledger.windows[scope]).toEqual({ id: "scope-a", status: "completed" });
  });

  it.each(["aborted", "abandoned"] as const)("invalidates %s windows before scope-end completion", reason => {
    const entries = [entry(definition({ scope: "match", completion: "scope-end", completeWhen: threshold("removed", 1) }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" } }), entries).ledger;
    const result = apply(ledger, end(2, reason), entries);
    expect(result.completed).toEqual([]);
    expect(result.ledger.records[key].invalidated).toBe(true);
    expect(metric(apply(result.ledger, observation(3, { scopes: { match: "match-a" }, values: { amount: 50 } }), entries).ledger)).toEqual({ type: "sum", value: 1 });
  });

  it("does not combine progress across windows or accept mismatched ordinary scope IDs", () => {
    const entries = [entry(definition({ scope: "match" }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    ledger = apply(ledger, observation(1, { scopes: { match: "wrong" }, values: { amount: 50 } }), entries).ledger;
    expect(metric(ledger)).toEqual({ type: "sum", value: 0 });
    ledger = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 6 } }), entries).ledger;
    ledger = apply(ledger, end(3), entries).ledger;
    ledger = apply(ledger, begin(4, "match", "match-b"), entries).ledger;
    const result = apply(ledger, observation(5, { scopes: { match: "match-b" }, values: { amount: 4 } }), entries);
    expect(result.completed).toEqual([]);
    expect(metric(result.ledger)).toEqual({ type: "sum", value: 4 });
  });

  it("rejects duplicate/replacement begins and unmatched ends without consuming the cursor", () => {
    const ledger = apply(createAchievementLedger("example-profile"), begin(0)).ledger;
    expect(() => apply(ledger, begin(1))).toThrow(/窗口/);
    expect(() => apply(ledger, begin(1, "match", "other"))).toThrow(/窗口/);
    expect(() => apply(ledger, end(1, "completed", "match", "other"))).toThrow(/边界/);
    expect(ledger.nextSequence).toBe(1);
  });

  it("rejects reusing the most recently closed scope identity", () => {
    let ledger = apply(createAchievementLedger("example-profile"), begin(0)).ledger;
    ledger = apply(ledger, end(1)).ledger;
    expect(() => apply(ledger, begin(2))).toThrow(/ID/);
    expect(apply(ledger, begin(2, "match", "match-b")).ledger.windows.match).toEqual({ id: "match-b", status: "active" });
  });

  it("ignores a replay by returning the original ledger, and rejects gaps or foreign streams", () => {
    const ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } })).ledger;
    const replay = apply(ledger, observation(0, { values: { amount: 100 } }));
    expect(replay).toMatchObject({ replayed: true, completed: [], diagnostics: [] });
    expect(replay.ledger).toBe(ledger);
    expect(() => apply(ledger, observation(2))).toThrow(/序号/);
    expect(() => apply(ledger, observation(1, { streamId: "other-profile" }))).toThrow(/持久流/);
  });

  it("survives JSON round trips with unfinished progress and no completion replay", () => {
    let ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } })).ledger;
    ledger = AchievementLedgerSchema.parse(JSON.parse(JSON.stringify(ledger)));
    const completed = apply(ledger, observation(1, { values: { amount: 4 } }));
    const restored = JSON.parse(JSON.stringify(completed.ledger));
    expect(apply(restored, observation(1)).completed).toEqual([]);
    expect(apply(restored, observation(2)).ledger.records[key].completed).toEqual(completed.ledger.records[key].completed);
  });

  it.each(["continuous", "cumulative"] as const)("handles a disabled profile definition according to %s continuity", continuity => {
    const entries = [entry(definition({ continuity }))];
    let ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } }), entries).ledger;
    ledger = apply(ledger, observation(1, { values: { amount: 50 } }), []).ledger;
    expect(ledger.records[key].suspended).toBe(true);
    const resumed = apply(ledger, observation(2, { values: { amount: 4 } }), entries);
    expect(metric(resumed.ledger)).toEqual({ type: "sum", value: continuity === "continuous" ? 4 : 10 });
    expect(resumed.completed).toHaveLength(continuity === "continuous" ? 0 : 1);
  });

  it("waits for a new begin after a scoped package gap", () => {
    const entries = [entry(definition({ scope: "match" }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 6 } }), entries).ledger;
    ledger = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 4 } }), []).ledger;
    ledger = apply(ledger, observation(3, { scopes: { match: "match-a" }, values: { amount: 4 } }), entries).ledger;
    expect(metric(ledger)).toEqual({ type: "sum", value: 6 });
    expect(ledger.records[key].suspended).toBe(true);
    ledger = apply(ledger, end(4), entries).ledger;
    ledger = apply(ledger, begin(5, "match", "match-b"), entries).ledger;
    const result = apply(ledger, observation(6, { scopes: { match: "match-b" }, values: { amount: 10 } }), entries);
    expect(result.completed).toHaveLength(1);
    expect(result.ledger.records[key].suspended).toBe(false);
  });

  it("pins scoped tracking and its input contract through a mid-window revision", () => {
    const old = definition({ scope: "match" });
    const next = definition({ scope: "match", tracks: [{ id: "removed", on: [{ type: "example/future-topic", apiVersion: 2 }], progress: { type: "count" } }], completeWhen: threshold("removed", 99) }, 2);
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), [entry(old)]).ledger;
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 6 } }), [entry(old)]).ledger;
    const result = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 4 } }), [entry(next)]);
    expect(result.diagnostics).toEqual([]);
    expect(result.completed[0].completion.revision).toBe(1);
    expect(result.ledger.records[key].tracking).toEqual(old.tracking);
  });

  it("adopts the new revision on the next begin while profile revisions reset immediately", () => {
    const scoped = definition({ scope: "match" });
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), [entry(scoped)]).ledger;
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 6 } }), [entry(scoped)]).ledger;
    const next = definition({ scope: "match", completeWhen: threshold("removed", 20) }, 2);
    ledger = apply(ledger, end(2), [entry(next)]).ledger;
    ledger = apply(ledger, begin(3, "match", "match-b"), [entry(next)]).ledger;
    expect(ledger.records[key].revision).toBe(2);
    expect(metric(ledger)).toEqual({ type: "sum", value: 0 });
    const profile = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } })).ledger;
    const changed = apply(profile, observation(1, { values: { amount: 4 } }), [entry(definition({}, 2))]);
    expect(metric(changed.ledger)).toEqual({ type: "sum", value: 4 });
  });

  it("detects changed rules under one revision, but permits metadata and object-key ordering changes", () => {
    const base = definition();
    const first = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } }), [entry(base)]).ledger;
    const metadata = { ...base, name: "Renamed", tracking: Object.fromEntries(Object.entries(base.tracking).reverse()) as unknown as AchievementTracking };
    expect(apply(first, observation(1, { values: { amount: 4 } }), [entry(metadata)]).completed).toHaveLength(1);
    const wrong = apply(first, observation(1, { values: { amount: 4 } }), [entry(definition({ completeWhen: threshold("removed", 5) }))]);
    expect(wrong.completed).toEqual([]);
    expect(wrong.diagnostics).toEqual([expect.objectContaining({ key, code: "tracking-revision-mismatch" })]);
    expect(wrong.ledger.records[key]).toMatchObject({ suspended: true, metrics: { removed: { value: 6 } } });
  });

  it("preserves completed identities through catalog removal and revision changes", () => {
    let ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 10 } })).ledger;
    const completion = ledger.records[key].completed;
    ledger = apply(ledger, observation(1), []).ledger;
    const result = apply(ledger, observation(2), [entry(definition({ completeWhen: threshold("removed", 50) }, 2))]);
    expect(result.completed).toEqual([]);
    expect(result.ledger.records[key].completed).toEqual(completion);
    expect(result.ledger.records[key].revision).toBe(1);
  });

  it("normalizes explicitly undefined optional rule fields across JSON restoration", () => {
    const entries = [entry(definition({ resetWhen: undefined, tracks: [{ id: "removed", on: [signal], when: undefined,
      progress: { type: "sum", value: { type: "observation", key: "amount" } } }] }))];
    const first = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } }), entries);
    const restored = JSON.parse(JSON.stringify(first.ledger));
    const result = apply(restored, observation(1, { values: { amount: 4 } }), entries);
    expect(result.diagnostics).toEqual([]);
    expect(result.completed).toHaveLength(1);
  });

  it("keeps an unknown negated field unknown instead of awarding an absence achievement", () => {
    const entries = [entry(definition({ scope: "match", completion: "scope-end", tracks: [], completeWhen: { type: "not", condition: {
      type: "value-compare", left: { type: "observation", key: "blocked" }, operator: "eq", right: { type: "literal", value: true }
    } } }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    const result = apply(ledger, end(1), entries);
    expect(result.completed).toEqual([]);
    expect(result.ledger.records[key].invalidated).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ key, code: "input-unavailable" })]));
  });

  it("applies on filtering before a possibly unavailable when predicate", () => {
    const entries = [entry(definition({ scope: "match", tracks: [{ id: "removed", on: [signal], when: {
      type: "value-compare", left: { type: "observation", key: "guard" }, operator: "eq", right: { type: "literal", value: true }
    }, progress: { type: "count" } }] }))];
    const result = apply(createAchievementLedger("example-profile"), begin(0), entries);
    expect(result.diagnostics).toEqual([]);
    expect(result.ledger.records[key].invalidated).toBe(false);
  });

  it("uses the final three-valued condition result rather than a diagnostic callback as a gap", () => {
    const entries = [entry(definition({ scope: "match", tracks: [{ id: "removed", on: [signal], when: { type: "any", conditions: [
      { type: "topic-is", topic: signal }, { type: "value-compare", left: { type: "observation", key: "blocked" }, operator: "eq", right: { type: "literal", value: true } }
    ] }, progress: { type: "sum", value: { type: "observation", key: "amount" } } }] }))];
    const first = apply(createAchievementLedger("example-profile"), begin(0), entries);
    const result = apply(first.ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 10 } }), entries);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.ledger.records[key].invalidated).toBe(false);
    expect(result.completed).toHaveLength(1);
  });

  it.each(["resetWhen", "invalidateWhen"] as const)("treats an unknown %s as a scoped observation gap", field => {
    const condition: AchievementCondition = { type: "all", conditions: [{ type: "topic-is", topic: signal }, {
      type: "value-compare", left: { type: "observation", key: "guard" }, operator: "eq", right: { type: "literal", value: true }
    }] };
    const entries = [entry(definition({ scope: "match", [field]: condition }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    expect(ledger.records[key].invalidated).toBe(false);
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 6, guard: false } }), entries).ledger;
    const result = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 4 } }), entries);
    expect(result.completed).toEqual([]);
    expect(result.ledger.records[key].invalidated).toBe(true);
  });

  it("invalidates a scoped attempt when its selected track predicate is unknown", () => {
    const entries = [entry(definition({ scope: "match", tracks: [{ id: "removed", on: [signal], when: {
      type: "value-compare", left: { type: "observation", key: "guard" }, operator: "eq", right: { type: "literal", value: true }
    }, progress: { type: "count" } }] }))];
    const first = apply(createAchievementLedger("example-profile"), begin(0), entries);
    const result = apply(first.ledger, observation(1, { scopes: { match: "match-a" } }), entries);
    expect(metric(result.ledger)).toEqual({ type: "count", value: 0 });
    expect(result.ledger.records[key].invalidated).toBe(true);
  });

  it.each(["continuous", "cumulative"] as const)("handles a missing or negative progress value under %s continuity", continuity => {
    const entries = [entry(definition({ continuity }))];
    let ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } }), entries).ledger;
    const missing = apply(ledger, observation(1, { values: {} }), entries);
    expect(metric(missing.ledger)).toEqual({ type: "sum", value: continuity === "continuous" ? 0 : 6 });
    const negative = apply(ledger, observation(1, { values: { amount: -1 } }), entries);
    expect(negative.completed).toEqual([]);
    expect(metric(negative.ledger)).toEqual({ type: "sum", value: continuity === "continuous" ? 0 : 6 });
    expect(negative.diagnostics.length).toBeGreaterThan(0);
  });

  it("lets invalidation win over reset, and resets before counting the same observation", () => {
    const predicate = (name: string): AchievementCondition => ({ type: "all", conditions: [{ type: "topic-is", topic: signal }, {
      type: "value-compare", left: { type: "observation", key: name }, operator: "eq", right: { type: "literal", value: true }
    }] });
    const entries = [entry(definition({ scope: "match", resetWhen: predicate("reset"), invalidateWhen: predicate("fail") }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    // Both predicates need explicit false values on ordinary observations.
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 6, reset: false, fail: false } }), entries).ledger;
    const restart = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 4, reset: true, fail: false } }), entries);
    expect(metric(restart.ledger)).toEqual({ type: "sum", value: 4 });
    const invalid = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 10, reset: true, fail: true } }), entries);
    expect(invalid.completed).toEqual([]);
    expect(invalid.ledger.records[key].invalidated).toBe(true);
  });

  it.each(["continuous", "cumulative"] as const)("excludes debug contributions for %s profile tracking while consuming their sequence", continuity => {
    const entries = [entry(definition({ continuity }))];
    let ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 6 } }), entries).ledger;
    ledger = apply(ledger, observation(1, { debugUsed: true, values: { amount: 100 } }), entries).ledger;
    expect(ledger.nextSequence).toBe(2);
    expect(metric(ledger)).toEqual({ type: "sum", value: continuity === "continuous" ? 0 : 6 });
    expect(apply(ledger, observation(2, { values: { amount: 4 } }), entries).completed).toHaveLength(continuity === "continuous" ? 0 : 1);
  });

  it("latches scoped debug invalidation until a new begin, while opt-in debug definitions count", () => {
    const entries = [entry(definition({ scope: "match" }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" }, debugUsed: true, values: { amount: 10 } }), entries).ledger;
    expect(ledger.records[key].invalidated).toBe(true);
    expect(apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 10 } }), entries).completed).toEqual([]);
    expect(apply(createAchievementLedger("example-profile"), observation(0, { debugUsed: true, values: { amount: 10 } }), [entry(definition({ allowDebug: true }))]).completed).toHaveLength(1);
  });

  it("deduplicates primitive identities and saturates distinct storage at its declared bound", () => {
    const entries = [entry(definition({ tracks: [{ id: "removed", on: [signal], progress: { type: "distinct", value: { type: "observation", key: "item" }, limit: 2 } }], completeWhen: threshold("removed", 3) }))];
    let ledger = createAchievementLedger("example-profile");
    for (const [sequence, item] of ["a", "a", "b", "c"].entries()) ledger = apply(ledger, observation(sequence, { values: { item } }), entries).ledger;
    expect(metric(ledger)).toEqual({ type: "distinct", values: ["a", "b"] });
    expect(ledger.records[key].completed).toBeUndefined();
  });

  it("initializes max without fabricating a zero sample and retains the actual best value", () => {
    const entries = [entry(definition({ scope: "match", tracks: [{ id: "removed", on: [signal], progress: { type: "max", value: { type: "observation", key: "amount" } } }], completeWhen: threshold("removed", 10) }))];
    let ledger = apply(createAchievementLedger("example-profile"), begin(0), entries).ledger;
    expect(metric(ledger)).toEqual({ type: "max", value: null });
    expect(ledger.records[key].invalidated).toBe(false);
    ledger = apply(ledger, observation(1, { scopes: { match: "match-a" }, values: { amount: 6 } }), entries).ledger;
    ledger = apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 4 } }), entries).ledger;
    expect(metric(ledger)).toEqual({ type: "max", value: 6 });
  });

  it("throws atomically on aggregate overflow, preserving the caller's previous cursor and metrics", () => {
    const entries = [entry(definition({ completeWhen: { type: "scalar-compare", left: { type: "metric", id: "removed" }, operator: "eq", right: -1 } }))];
    const ledger = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: Number.MAX_SAFE_INTEGER } }), entries).ledger;
    const saved = JSON.stringify(ledger);
    expect(() => apply(ledger, observation(1), entries)).toThrow(/溢出/);
    expect(JSON.stringify(ledger)).toBe(saved);
  });

  it("pauses a bad declaration without blocking a separate valid achievement", () => {
    const bad = definition({ tracks: [{ id: "removed", on: [signal], progress: { type: "sum", value: { type: "observation", key: "misspelled" } } }] });
    const goodKey = "example/package#achievements/good";
    const result = apply(createAchievementLedger("example-profile"), observation(0, { values: { amount: 10 } }), [entry(bad), entry(definition(), goodKey)]);
    expect(result.ledger.records[key].suspended).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ key })]));
    expect(result.completed.map(item => item.key)).toEqual([goodKey]);
  });

  it("consumes unknown topics and versions without updating or completing, while preserving boundaries", () => {
    const entries = [entry(definition({ scope: "match" }))];
    let ledger = apply(createAchievementLedger("example-profile"), { ...begin(0), topic: { type: "example/future-lifecycle", apiVersion: 2 } }, entries).ledger;
    expect(ledger.windows.match?.status).toBe("active");
    expect(metric(ledger)).toEqual({ type: "sum", value: 0 });
    ledger = apply(ledger, observation(1, { topic: { ...signal, apiVersion: 2 }, scopes: { match: "match-a" }, values: { amount: 10 } }), entries).ledger;
    expect(ledger.nextSequence).toBe(2);
    expect(metric(ledger)).toEqual({ type: "sum", value: 0 });
    expect(apply(ledger, observation(2, { scopes: { match: "match-a" }, values: { amount: 10 } }), entries).completed).toHaveLength(1);
  });

  it("rejects ambiguous catalogs/contracts and invalid declared value types", () => {
    const ledger = createAchievementLedger("example-profile");
    expect(() => apply(ledger, observation(0), [entry(), entry()])).toThrow(/重复/);
    expect(() => apply(ledger, observation(0), [{ key, definition: { ...definition(), id: "different" } }])).toThrow(/局部 ID/);
    expect(() => advanceAchievements([entry()], ledger, observation(0), [...contracts, contracts[0]])).toThrow(/重复/);
    expect(() => apply(ledger, observation(0, { values: { amount: "wrong" } }))).toThrow();
    expect(() => apply(ledger, observation(0), Array.from({ length: 1025 }, () => entry()))).toThrow(/预算/);
    expect(() => advanceAchievements([entry()], ledger, observation(0), Array.from({ length: 1025 }, () => contracts[0]))).toThrow(/预算/);
  });

  it("leaves inputs unchanged and freezes its validated new ledger and notifications deeply", () => {
    const source = JSON.parse(JSON.stringify(createAchievementLedger("example-profile")));
    const input = observation(0, { values: { amount: 10 } });
    const entries = [entry()];
    const before = JSON.stringify({ source, input, entries });
    const result = apply(source, input, entries);
    expect(JSON.stringify({ source, input, entries })).toBe(before);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(input.values)).toBe(false);
    expect(Object.isFrozen(result.ledger.records[key].tracking.tracks[0])).toBe(true);
    expect(Object.isFrozen(result.completed[0].completion)).toBe(true);
  });
});
