import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { skinCharacterFixture } from "../../test/skin-character-fixtures";
import { ABILITY_CATALOG_VERSION } from "../../core/abilities/registry";
import { AchievementCatalogSchema } from "../../core/achievements";
import { activateContentRuntime, deactivateContentRuntime, loadContent, prepareContentRuntime } from "./content-loader";
import { HocpkgManifestSchema, type BuiltinPackageIndex } from "./schema";
import * as telemetryModule from "../../telemetry";

const report = vi.fn(async (_entries: unknown) => {});
beforeEach(() => {
  report.mockClear();
  vi.spyOn(telemetryModule, "setTelemetryAchievementCatalog").mockImplementation(report);
});
afterEach(() => { deactivateContentRuntime(); vi.restoreAllMocks(); });

async function prepared(invalid = false) {
  const { access } = await skinCharacterFixture();
  const manifest = HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: "achievements", version: "1.0.0" },
    metadata: { title: "独立成就", description: "测试", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: "main", type: "achievement.catalog", apiVersion: 1, entry: "achievements.json", requires: [] }],
    files: [{ path: "achievements.json", bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" }], extensions: {} });
  const catalog = AchievementCatalogSchema.parse({ achievements: [{ id: "first", revision: 1, name: "首个目标", description: "中性描述",
    tracking: { scope: "profile", tracks: [{ id: "n", progress: { type: "count" } }],
      completeWhen: { type: "scalar-compare", left: { type: "metric", id: "n" }, operator: "gte", right: 1 } } }] });
  const packageAccess = { packageId: "example/achievements", manifest,
    async *files() { /* Fixture resources are read through readJson below. */ },
    readJson: async () => invalid ? { invalid: true } : catalog,
    resolveAsset: async () => ({ url: "blob:unused" }) };
  const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2,
    abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [] };
  const loaded = await loadContent({ packages: async () => [access, packageAccess] }, index);
  return { loaded, runtime: prepareContentRuntime(loaded) };
}

it("reports only catalogs that really activate, not preparation or transient deactivation", async () => {
  const { loaded, runtime } = await prepared();
  try {
    expect(report).not.toHaveBeenCalled();
    expect(runtime.achievements?.map(entry => entry.key)).toEqual(["example/achievements#main/first"]);
    activateContentRuntime(runtime);
    expect(report).toHaveBeenCalledExactlyOnceWith(runtime.achievements);
    deactivateContentRuntime();
    expect(report).toHaveBeenCalledTimes(1);
  } finally { loaded.release(); }
});

it("does not treat an invalid optional catalog as loaded or block character content", async () => {
  const { loaded, runtime } = await prepared(true);
  try {
    expect(runtime.achievements).toEqual([]);
    expect(runtime.diagnostics.some(diagnostic => diagnostic.type === "achievement.catalog")).toBe(true);
    activateContentRuntime(runtime);
    expect(report).toHaveBeenCalledWith([]);
  } finally { loaded.release(); }
});

it("reports an actual empty replacement without emitting a transient teardown snapshot", async () => {
  const { loaded, runtime } = await prepared();
  try {
    activateContentRuntime(runtime);
    deactivateContentRuntime();
    expect(report).toHaveBeenCalledTimes(1);
    activateContentRuntime({ ...runtime, achievements: [] });
    expect(report).toHaveBeenLastCalledWith([]);
    expect(report).toHaveBeenCalledTimes(2);
  } finally { loaded.release(); }
});
