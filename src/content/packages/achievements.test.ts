import { expect, it, vi } from "vitest";
import { validateAchievementPackage, type AuthoringPackage } from "../../authoring-api";
import { type AchievementCatalog } from "../../core/achievements";
import { sha256 } from "../storage/encoding";
import { prepareAchievementCatalogs } from "./achievements";
import { buildContentRegistry } from "./content-registry";
import { loadHocpkgResources } from "./loader";
import { createHocpkgResourceHandlers, mergeResourceHandlers } from "./resources";
import { HocpkgManifestSchema, type HocpkgManifest } from "./schema";

function catalog(): AchievementCatalog {
  return { achievements: [{
    id: "ten-cards", revision: 1, name: "收集十张", description: "在一场牌局内收集十张牌。", icon: "icons/cards.png",
    tracking: {
      scope: "match", completion: "immediate", continuity: "continuous", allowDebug: false,
      tracks: [{ id: "removed", on: [{ type: "example.skills-removed", apiVersion: 1 }], progress: { type: "sum", value: { type: "skill-card-count", collection: "removed" } } }],
      completeWhen: { type: "scalar-compare", left: { type: "metric", id: "removed" }, operator: "gte", right: 10 }
    }
  }] };
}

function fixture(packageName = "achievements", resourceId = "main") {
  const body = catalog();
  const manifest = HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName, version: "1.0.0" },
    metadata: { title: "牌局成就", description: "中性测试包", tags: [], creators: [{ displayName: "Example", roles: ["design"] }] },
    resources: [{ id: resourceId, type: "achievement.catalog", apiVersion: 1, entry: "achievements.json", requires: [] }],
    files: [
      { path: "achievements.json", bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" },
      { path: "icons/cards.png", bytes: 1, sha256: "0".repeat(64), mediaType: "image/png" }
    ], extensions: {} });
  const resolvePath = vi.fn(async (path: string) => `blob:${packageName}/${path}`);
  const load = () => loadHocpkgResources(manifest, { handlers: createHocpkgResourceHandlers(), readJson: async () => body, resolvePath });
  return { body, manifest, resolvePath, load };
}

it("loads standalone catalogs through the optional resource channel with immutable ownership and icon URLs", async () => {
  const { body, manifest, resolvePath, load } = fixture();
  const resources = await load();
  expect(resources[0].state).toBe("active");
  expect(resolvePath).toHaveBeenCalledWith("icons/cards.png");
  const registry = buildContentRegistry([{ manifest, resources, resolvePath: path => `blob:prepared/${path}` }]);
  const entries = prepareAchievementCatalogs(registry.extensions["achievement.catalog"]);
  expect(entries).toEqual([{
    key: "example/achievements#main/ten-cards", definition: body.achievements[0],
    packageId: "example/achievements", catalogKey: "example/achievements#main", packageTitle: "牌局成就", packageVersion: "1.0.0", iconUrl: "blob:prepared/icons/cards.png"
  }]);
  expect(Object.isFrozen(entries)).toBe(true);
  expect(Object.isFrozen(entries[0])).toBe(true);
  expect(Object.isFrozen(entries[0].definition.tracking)).toBe(true);
  expect(Object.isFrozen(entries[0].definition.tracking.tracks)).toBe(true);
  expect(entries[0].definition).not.toBe(resources[0].value && (resources[0].value as AchievementCatalog).achievements[0]);
  expect(prepareAchievementCatalogs([])).toEqual([]);
  expect(prepareAchievementCatalogs([
    ...registry.extensions["achievement.catalog"],
    { ...registry.extensions["achievement.catalog"][0], descriptor: { ...manifest.resources[0], type: "presentation.faction" }, value: { name: "其他资源" } }
  ])).toEqual(entries);
});

it("accepts icon-free achievements and keeps keys stable when their package version changes", async () => {
  const value = fixture();
  Reflect.deleteProperty(value.body.achievements[0], "icon");
  const snapshots = [];
  for (const version of ["1.0.0", "2.0.0"]) {
    value.manifest.identity.version = version;
    const resources = await value.load();
    const registry = buildContentRegistry([{ manifest: value.manifest, resources, resolvePath: path => path }]);
    snapshots.push(prepareAchievementCatalogs(registry.extensions["achievement.catalog"])[0]);
  }
  expect(snapshots.map(entry => entry.key)).toEqual(["example/achievements#main/ten-cards", "example/achievements#main/ten-cards"]);
  expect(snapshots.map(entry => entry.packageVersion)).toEqual(["1.0.0", "2.0.0"]);
  expect(snapshots.every(entry => entry.iconUrl === undefined)).toBe(true);
  expect(value.resolvePath).not.toHaveBeenCalled();
});

it("prepares a declared cover separately from the legacy icon", async () => {
  const value = fixture();
  (value.body.achievements[0] as { cover?: string }).cover = "images/cover.png";
  value.manifest.files.push({ path: "images/cover.png", bytes: 1, sha256: "0".repeat(64), mediaType: "image/png" });
  const resources = await value.load();
  expect(resources[0].state).toBe("active");
  expect(value.resolvePath).toHaveBeenCalledWith("images/cover.png");
  const registry = buildContentRegistry([{ manifest: value.manifest, resources, resolvePath: path => `blob:${path}` }]);
  expect(prepareAchievementCatalogs(registry.extensions["achievement.catalog"])[0]).toMatchObject({
    coverUrl: "blob:images/cover.png", iconUrl: "blob:icons/cards.png", definition: { cover: "images/cover.png" }
  });
});

it.each(["../cover.png", "https://example.org/cover.png", "missing.png", "achievements.json"])("rejects unsafe, undeclared or non-image covers: %s", async cover => {
  const value = fixture();
  (value.body.achievements[0] as { cover?: string }).cover = cover;
  expect((await value.load())[0]).toMatchObject({ state: "invalid", reason: "payload-invalid" });
});

it("keeps identical local achievement IDs distinct across packages and catalog resources", async () => {
  const first = fixture();
  first.manifest.resources.push({ ...first.manifest.resources[0], id: "second", entry: "second.json" });
  first.manifest.files.push({ ...first.manifest.files[0], path: "second.json" });
  const packages = await Promise.all([first, fixture("other")].map(async value => ({
    manifest: value.manifest, resources: await value.load(), resolvePath: (path: string) => path
  })));
  const entries = prepareAchievementCatalogs(buildContentRegistry(packages).extensions["achievement.catalog"]);
  expect(entries.map(entry => entry.key)).toEqual([
    "example/achievements#main/ten-cards", "example/achievements#second/ten-cards", "example/other#main/ten-cards"
  ]);
});

it.each(["../escape.png", "https://example.org/icon.png", "missing.png", "icons/cards.svg"])("rejects unsafe or undeclared achievement icons: %s", async path => {
  const { body, load } = fixture();
  (body.achievements[0] as { icon?: string }).icon = path;
  expect((await load())[0].state).toBe("invalid");
});

it("rejects incorrect image MIME and unreadable icons without blocking the content registry", async () => {
  const value = fixture();
  value.manifest.files[1].mediaType = "text/plain";
  expect((await value.load())[0]).toMatchObject({ state: "invalid", reason: "payload-invalid" });
  value.manifest.files[1].mediaType = "image/png";
  value.resolvePath.mockRejectedValue(new Error("image unavailable"));
  const resources = await value.load();
  const registry = buildContentRegistry([{ manifest: value.manifest, resources, resolvePath: path => path }]);
  expect(registry.extensions["achievement.catalog"]).toBeUndefined();
  expect(registry.diagnostics).toMatchObject([{ type: "achievement.catalog", state: "invalid", error: "image unavailable" }]);
});

it("rejects duplicate local IDs, leaves unsupported APIs dormant, and prevents plugin overrides", async () => {
  const value = fixture();
  (value.body.achievements as unknown[]).push(value.body.achievements[0]);
  expect((await value.load())[0].state).toBe("invalid");
  value.manifest.resources[0].apiVersion = 2;
  expect((await value.load())[0]).toMatchObject({ state: "dormant", reason: "api-version-unsupported", supportedApiVersions: [1] });
  expect(() => mergeResourceHandlers(createHocpkgResourceHandlers(), [{ type: "achievement.catalog", apiVersions: [1], parse: payload => payload }])).toThrow("核心资源类型");
});

it("validates the complete achievement identity before activating its optional catalog", async () => {
  const value = fixture("a".repeat(400));
  expect((await value.load())[0]).toMatchObject({ state: "invalid", reason: "payload-invalid" });
});

async function authoringFixture(mixed = false): Promise<{ input: AuthoringPackage; manifest: HocpkgManifest; files: Record<string, Uint8Array> }> {
  const { manifest, body } = fixture();
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const files: Record<string, Uint8Array> = { "achievements.json": encode(body), "icons/cards.png": new Uint8Array([1, 2, 3]) };
  if (mixed) {
    manifest.resources.push({ id: "unrelated", type: "plugin.module", apiVersion: 999, entry: "plugin.json", requires: [] });
    manifest.resources.push({ id: "unrelated-faction", type: "presentation.faction", apiVersion: 1, entry: "faction.json", requires: [] });
    // Deliberately not JSON: unrelated resources are outside this validator's scope.
    files["plugin.json"] = new TextEncoder().encode("not parsed by achievement validation");
    files["faction.json"] = new TextEncoder().encode("also outside the achievement dependency closure");
    files["plugin.js"] = new TextEncoder().encode("throw new Error('Package code must never run');");
  }
  manifest.files = await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({
    path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "image/png"
  })));
  return { manifest, files, input: { manifest, readFile: vi.fn(async (path: string) => files[path]) } };
}

it.each([false, true])("validates standalone and mixed achievement packages without requiring a character or executing plugins (mixed: %s)", async mixed => {
  const { input } = await authoringFixture(mixed);
  await expect(validateAchievementPackage(input)).resolves.toBeUndefined();
  if (mixed) {
    const readPaths = vi.mocked(input.readFile).mock.calls.map(([path]) => path);
    expect(readPaths.filter(path => path === "faction.json")).toHaveLength(1);
    expect(readPaths.filter(path => path === "plugin.js")).toHaveLength(1);
  }
});

it("offers explicit standard authoring validation without rejecting legacy API 1 packages by default", async () => {
  const value = await authoringFixture();
  await expect(validateAchievementPackage(value.input)).resolves.toBeUndefined();
  await expect(validateAchievementPackage(value.input, { standard: true })).rejects.toThrow("标准成就必须声明封面");
  const body = JSON.parse(new TextDecoder().decode(value.files["achievements.json"]));
  body.achievements[0].cover = "icons/cards.png";
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  value.files["achievements.json"] = bytes;
  value.manifest.files[0] = { ...value.manifest.files[0], bytes: bytes.length, sha256: await sha256(bytes) };
  await expect(validateAchievementPackage(value.input, { standard: true })).resolves.toBeUndefined();
});

it("checks every file's integrity, including unrelated files in a mixed package", async () => {
  const { input, files } = await authoringFixture(true);
  files["plugin.js"] = new Uint8Array([99]);
  await expect(validateAchievementPackage(input)).rejects.toThrow("文件完整性不符：plugin.js");
});

it("parses the verified byte snapshot even when a provider would return different bytes on a second read", async () => {
  const value = await authoringFixture();
  const valid = value.files["achievements.json"];
  const invalid = new TextEncoder().encode(JSON.stringify({ achievements: [] }));
  value.manifest.files[0] = { ...value.manifest.files[0], bytes: invalid.length, sha256: await sha256(invalid) };
  let catalogReads = 0;
  const readFile = vi.fn(async (path: string) => path === "achievements.json" ? ++catalogReads === 1 ? invalid : valid : value.files[path]);
  await expect(validateAchievementPackage({ manifest: value.manifest, readFile })).rejects.toThrow("payload-invalid");
  expect(catalogReads).toBe(1);
  expect(readFile).toHaveBeenCalledTimes(value.manifest.files.length);
});

it("owns verified bytes even if a provider reuses and mutates its original buffer", async () => {
  const value = await authoringFixture();
  const mutable = new Uint8Array(value.files["achievements.json"]);
  const readFile = vi.fn(async (path: string) => {
    if (path === "achievements.json") return mutable;
    mutable.fill(0);
    return value.files[path];
  });
  await expect(validateAchievementPackage({ manifest: value.manifest, readFile })).resolves.toBeUndefined();
  expect(mutable[0]).toBe(0);
  expect(readFile).toHaveBeenCalledTimes(value.manifest.files.length);
});

it("requires a catalog and validates every catalog API and its transitive dependencies", async () => {
  const value = await authoringFixture();
  value.manifest.resources[0].type = "plugin.unrelated";
  await expect(validateAchievementPackage(value.input)).rejects.toThrow("至少一个 achievement.catalog");
  value.manifest.resources[0].type = "achievement.catalog";
  value.manifest.resources.push({ id: "future", type: "achievement.catalog", apiVersion: 999, entry: "future.json", requires: [] });
  const bytes = new TextEncoder().encode(JSON.stringify(catalog()));
  value.files["future.json"] = bytes;
  value.manifest.files.push({ path: "future.json", bytes: bytes.length, sha256: await sha256(bytes), mediaType: "application/json" });
  await expect(validateAchievementPackage(value.input)).rejects.toThrow("future: api-version-unsupported");
  value.manifest.resources[1].apiVersion = 1;
  value.manifest.resources[0].requires = ["future"];
  value.manifest.resources[1].requires = ["missing"];
  await expect(validateAchievementPackage(value.input)).rejects.toThrow("依赖不存在");
  value.manifest.resources[1].requires = ["dependency"];
  value.manifest.resources.push({ id: "dependency", type: "presentation.faction", apiVersion: 999, entry: "dependency.json", requires: [] });
  value.files["dependency.json"] = new Uint8Array([123, 125]);
  value.manifest.files.push({ path: "dependency.json", bytes: 2, sha256: await sha256(value.files["dependency.json"]), mediaType: "application/json" });
  await expect(validateAchievementPackage(value.input)).rejects.toThrow("dependency-unavailable");
  value.manifest.resources[2].apiVersion = 1;
  await expect(validateAchievementPackage(value.input)).rejects.toThrow("dependency-unavailable");
  value.files["dependency.json"] = new TextEncoder().encode(JSON.stringify({ name: "测试组织" }));
  value.manifest.files[3] = { path: "dependency.json", bytes: value.files["dependency.json"].length, sha256: await sha256(value.files["dependency.json"]), mediaType: "application/json" };
  await expect(validateAchievementPackage(value.input)).resolves.toBeUndefined();
});
