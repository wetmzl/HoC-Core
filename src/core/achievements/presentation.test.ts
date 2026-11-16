import { describe, expect, it } from "vitest";
import { advanceAchievements, createAchievementLedger } from "./engine";
import { projectAchievement, projectAchievementList, type AchievementPresentationEntry } from "./presentation";
import { AchievementCatalogSchema, AchievementDefinitionSchema, AchievementLedgerSchema, StandardAchievementCatalogSchema, StandardAchievementDefinitionSchema } from "./schema";
import type { AchievementMetric, AchievementObservation, AchievementTracking } from "./types";

const topic = { type: "example.win", apiVersion: 1 };
const contract = { topic, values: { amount: "number" as const }, skillCollections: [] };
function entry(id = "secret", extra = {}): AchievementPresentationEntry {
  return { key: `example/package#catalog/${id}`, coverUrl: "blob:secret-cover", iconUrl: "blob:secret-icon",
    definition: AchievementDefinitionSchema.parse({ id, revision: 1, name: "真正的秘密名称", description: "真正的秘密条件", category: "秘密分类",
      cover: "images/secret-cover.png", icon: "images/secret-icon.png", hidden: true, progressDisplay: { metric: "wins", target: 10 },
      tracking: { scope: "profile", tracks: [{ id: "wins", on: [topic], progress: { type: "sum", value: { type: "observation", key: "amount" } } }],
        completeWhen: { type: "scalar-compare", left: { type: "metric", id: "wins" }, operator: "gte", right: 10 } }, ...extra }) };
}
function observation(sequence: number, amount: number): AchievementObservation {
  return { apiVersion: 1, streamId: "profile", sequence, at: "2026-11-10T00:00:00Z", topic, scopes: {}, debugUsed: false, values: { amount }, skillCards: {} };
}
function committed(entry: AchievementPresentationEntry, metric: AchievementMetric) {
  return AchievementLedgerSchema.parse({ ...createAchievementLedger("profile"), nextSequence: 1, records: {
    [entry.key]: { revision: entry.definition.revision, tracking: entry.definition.tracking, scopeId: "profile", metrics: { wins: metric }, invalidated: false, suspended: false }
  } });
}

describe("standard achievement declarations retain legacy loading", () => {
  it("requires an explicit standard cover while accepting legacy icons and missing images through API 1", () => {
    const definition = entry().definition;
    expect(StandardAchievementDefinitionSchema.parse(definition).cover).toBe("images/secret-cover.png");
    for (const legacy of [{ ...definition, cover: undefined }, { ...definition, cover: undefined, icon: undefined }]) {
      expect(AchievementDefinitionSchema.safeParse(legacy).success).toBe(true);
      expect(AchievementCatalogSchema.safeParse({ achievements: [legacy] }).success).toBe(true);
      expect(StandardAchievementDefinitionSchema.safeParse(legacy).success).toBe(false);
      expect(StandardAchievementCatalogSchema.safeParse({ achievements: [legacy] }).success).toBe(false);
    }
    expect(StandardAchievementCatalogSchema.parse({ achievements: [definition] }).achievements).toHaveLength(1);
  });
  it("preserves all original identity, text, tracking and duplicate checks in standard schemas", () => {
    const definition = entry().definition;
    for (const patch of [{ name: " " }, { description: " " }, { cover: "../cover.png" }, { cover: "https://example.org/cover.png" }, { tracking: {} }]) {
      expect(StandardAchievementDefinitionSchema.safeParse({ ...definition, ...patch }).success).toBe(false);
    }
    expect(StandardAchievementCatalogSchema.safeParse({ achievements: [definition, definition] }).success).toBe(false);
  });
});

describe("committed achievement presentation", () => {
  it("serializes only generic placeholders before a hidden achievement is committed", () => {
    const value = entry(), ledger = createAchievementLedger("profile");
    const speculative = advanceAchievements([value], ledger, observation(0, 10), [contract]);
    expect(speculative.completed).toHaveLength(1);
    const hidden = projectAchievement(value, ledger);
    expect(hidden).toEqual({ status: "hidden", cover: { type: "placeholder" }, name: "隐藏成就", description: "解锁后显示具体内容。" });
    const serialized = JSON.stringify(hidden);
    for (const secret of [value.key, value.definition.name, value.definition.description, value.definition.category!, "secret-cover", "secret-icon", "wins", "tracking", "progress", "reward"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(projectAchievement(value, speculative.ledger)).toMatchObject({ status: "completed", key: value.key,
      cover: { type: "image", url: "blob:secret-cover" }, name: value.definition.name, description: value.definition.description, completedAt: observation(0, 10).at });
  });
  it("aggregates remaining hidden entries without exposing their keys or metadata in rows", () => {
    const first = entry(), second = entry("other-secret"), visible = entry("visible", { hidden: false, name: "可见名称", description: "可见说明", category: undefined });
    const unlocked = advanceAchievements([first], createAchievementLedger("profile"), observation(0, 10), [contract]).ledger;
    const result = projectAchievementList([first, second, visible], unlocked);
    expect(result.hiddenCount).toBe(1);
    expect(result.rows.map(row => [row.key, row.status])).toEqual([[first.key, "completed"], [visible.key, "locked"]]);
    expect(JSON.stringify(result)).not.toContain(second.key);
    expect(projectAchievementList([], unlocked)).toEqual({ rows: [], hiddenCount: 0 });
  });
  it("uses cover, legacy icon or a generic placeholder without inventing a standard cover", () => {
    const value = entry("visible", { hidden: false }), ledger = createAchievementLedger("profile");
    expect(projectAchievement(value, ledger).cover).toEqual({ type: "image", url: "blob:secret-cover" });
    expect(projectAchievement({ ...value, coverUrl: undefined }, ledger).cover).toEqual({ type: "image", url: "blob:secret-icon" });
    expect(projectAchievement({ ...value, definition: { ...value.definition, cover: undefined } }, ledger).cover).toEqual({ type: "image", url: "blob:secret-icon" });
    expect(projectAchievement({ ...value, coverUrl: undefined, iconUrl: undefined }, ledger).cover).toEqual({ type: "placeholder" });
  });
  it.each<AchievementMetric>([{ type: "sum", value: 4.5 }, { type: "count", value: 4 }, { type: "distinct", values: ["a", "b"] }, { type: "max", value: null }])("exposes committed compatible progress without computing a percentage: %j", metric => {
    const progress: AchievementTracking["tracks"][number]["progress"] = metric.type === "count" ? { type: "count" }
      : metric.type === "distinct" ? { type: "distinct", value: { type: "literal", value: "a" }, limit: 10 }
        : { type: metric.type, value: { type: "observation", key: "amount" } };
    const initial = entry("visible", { hidden: false });
    const value = entry("visible", { hidden: false, tracking: { ...initial.definition.tracking, tracks: [{ id: "wins", on: [topic], progress }] } });
    expect(projectAchievement(value, committed(value, metric))).toMatchObject({ status: "locked", progressDisplay: { metric: "wins", target: 10,
      value: metric.type === "distinct" ? metric.values.length : metric.value } });
  });
  it("does not mix stale, suspended, invalidated or differently revised attempts into current display hints", () => {
    const value = entry("visible", { hidden: false }), ledger = committed(value, { type: "sum", value: 6 });
    for (const patch of [{ suspended: true }, { invalidated: true }, { revision: 2 }]) {
      const changed = { ...ledger, records: { [value.key]: { ...ledger.records[value.key], ...patch } } };
      expect(projectAchievement(value, changed)).toMatchObject({ status: "locked", progressDisplay: { metric: "wins", target: 10 } });
      expect(projectAchievement(value, changed)).not.toHaveProperty("progressDisplay.value");
    }
    const changedRule = { ...value, definition: { ...value.definition, tracking: { ...value.definition.tracking, allowDebug: true } } };
    expect(projectAchievement(changedRule, ledger)).not.toHaveProperty("progressDisplay.value");
    expect(projectAchievement(value, createAchievementLedger("profile"))).not.toHaveProperty("progressDisplay.value");
  });
  it("keeps scoped progress out of a display after the corresponding window closes", () => {
    const base = entry("visible", { hidden: false });
    const value = { ...base, definition: { ...base.definition, tracking: { ...base.definition.tracking, scope: "match" as const } } };
    const ledger = { ...committed(base, { type: "sum", value: 6 }), windows: { match: { id: "match", status: "completed" as const } }, records: {
      [value.key]: { revision: 1, tracking: value.definition.tracking, scopeId: "match", metrics: { wins: { type: "sum" as const, value: 6 } }, invalidated: false, suspended: false }
    } };
    expect(projectAchievement(value, ledger)).not.toHaveProperty("progressDisplay.value");
  });
  it("does not change tracking revision when a cover changes and reveals updated metadata after completion", () => {
    const value = entry(), partial = advanceAchievements([value], createAchievementLedger("profile"), observation(0, 6), [contract]);
    const updated = { ...value, coverUrl: "blob:new-cover", definition: { ...value.definition, cover: "images/new-cover.png" } };
    const result = advanceAchievements([updated], partial.ledger, observation(1, 4), [contract]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ledger.records[value.key].completed?.revision).toBe(1);
    expect(projectAchievement(updated, AchievementLedgerSchema.parse(JSON.parse(JSON.stringify(result.ledger))))).toMatchObject({ status: "completed", cover: { type: "image", url: "blob:new-cover" } });
  });
  it("leaves inputs unchanged, freezes output and rejects ambiguous or mismatched identities", () => {
    const value = entry("visible", { hidden: false }), ledger = committed(value, { type: "sum", value: 4 });
    const original = JSON.stringify({ value, ledger });
    const result = projectAchievementList([value], ledger);
    expect(JSON.stringify({ value, ledger })).toBe(original);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.rows[0].cover)).toBe(true);
    expect(() => projectAchievementList([value, value], ledger)).toThrow("ID 重复");
    expect(() => projectAchievement({ ...value, key: "example/package#catalog/wrong" }, ledger)).toThrow("局部 ID 不一致");
  });
});
