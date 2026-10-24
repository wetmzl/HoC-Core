import { expect, it, vi } from "vitest";
import { createCharacterDraft, validateCharacterPackage } from "../../authoring-api";
import { characterCardMarkup } from "../../lobby-screen-module";
import { loadContent, prepareContentRuntime } from "./content-loader";
import type { ContentPackageAccess } from "./content-source";
import { CharacterMatchResourceSchema, createCharacterMatchResourceHandler, createHocpkgResourceHandlers, mergeResourceHandlers } from "./resources";
import { HocpkgManifestSchema, HocpkgResourceKeySchema, type BuiltinPackageIndex } from "./schema";
import { ABILITY_CATALOG_VERSION } from "../../core/abilities/registry";

const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2,
  abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [] };
function access(name: string, resources: unknown[], bodies: Record<string, unknown>, images: string[]): ContentPackageAccess {
  const manifest = HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: name, version: "1.0.0" },
    metadata: { title: name, description: "Neutral fixture", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources, files: [...Object.keys(bodies), ...images].map(path => ({ path, bytes: 1, sha256: "0".repeat(64), mediaType: path.endsWith(".json") ? "application/json" : "image/png" })), extensions: {} });
  return { packageId: `example/${name}`, manifest, async *files() {}, readFile: vi.fn(),
    readJson: vi.fn(async path => bodies[path]), resolveAsset: vi.fn(async path => ({ url: `blob:${name}/${path}`, release: vi.fn() })) };
}
function fixture(reference = "example/factions#guild") {
  const draft = createCharacterDraft("sample", "测试与会者");
  for (const pool of Object.values(draft.dialogue.pools)) (pool as string[]).push("测试对白");
  const match = { ...draft.match, metadata: { ...draft.match.metadata, faction: reference } };
  const character = access("sample", [
    { id: "match", type: "game.character-match", apiVersion: 7, entry: "match.json", requires: ["dialogue"] },
    { id: "dialogue", type: "game.character-dialogue", apiVersion: 2, entry: "dialogue.json", requires: [] }
  ], { "match.json": match, "dialogue.json": draft.dialogue }, ["cover.png", "relaxed.png", "conflicted.png", "mocking.png", "threatened.png", "unconscious.png"]);
  const faction = access("factions", [{ id: "guild", type: "presentation.faction", apiVersion: 1, entry: "guild.json", requires: [] }],
    { "guild.json": { name: "星辰公会", badge: "badge.png" } }, ["badge.png"]);
  return { character, faction, match };
}
async function runtime(packages: ContentPackageAccess[]) {
  const content = await loadContent({ packages: async () => packages }, index);
  return { content, prepared: prepareContentRuntime(content) };
}

it("resolves affiliation against its owning package and shares one asset across characters", async () => {
  const { character, faction } = fixture();
  const other = access("other", [{ id: "guild", type: "presentation.faction", apiVersion: 1, entry: "guild.json", requires: [] }],
    { "guild.json": { name: "另一个公会", badge: "badge.png" } }, ["badge.png"]);
  const secondCharacter = { ...fixture().character, packageId: "example/second-character" };

  secondCharacter.manifest.identity.packageName = "second-character";
  const readSecond = secondCharacter.readJson;
  secondCharacter.readJson = async path => {
    const value = await readSecond(path);
    const match = value as ReturnType<typeof fixture>["match"];
    return path === "match.json" ? { ...match, metadata: { ...match.metadata, id: "second" } } : value;
  };
  const { content, prepared } = await runtime([character, secondCharacter, other, faction]);
  expect(prepared.catalog[0]).toMatchObject({ faction: "example/factions#guild", badge: { label: "星辰公会", image: "blob:factions/badge.png" } });
  expect(prepared.characters[0].badge).toEqual(prepared.catalog[0].badge);
  expect(prepared.characters[1].badge).toEqual(prepared.catalog[0].badge);
  expect(faction.resolveAsset).toHaveBeenCalledTimes(1);
  expect(character.resolveAsset).not.toHaveBeenCalledWith("badge.png");
  expect(prepared.diagnostics).toEqual([]);
  content.release();
  const resolved = await vi.mocked(faction.resolveAsset).mock.results[0].value;
  expect(resolved.release).toHaveBeenCalledTimes(1);
});

it("keeps affiliation, definitions and the character playable when the faction package is absent or disabled, then restores it", async () => {
  const { character, faction } = fixture();
  for (const packages of [[character, faction], [character], [character, faction]]) {
    const { content, prepared } = await runtime(packages);
    expect(prepared.defaultCharacterId).toBe("sample");
    expect(prepared.characters[0].faction).toBe("example/factions#guild");
    expect(prepared.characters[0].assets.relaxed).toBe("blob:sample/relaxed.png");
    expect(prepared.characters[0].ai).toBeDefined();
    expect(prepared.catalog[0].badge !== undefined).toBe(packages.length === 2);
    expect(characterCardMarkup(prepared.catalog[0]).includes('class="character-badge"')).toBe(packages.length === 2);
    content.release();
  }
});

it.each(["missing-resource", "invalid-body", "missing-image", "image-read-failure", "unsupported-api"])("isolates optional faction failures: %s", async failure => {
  const { character, faction } = fixture(failure === "missing-resource" ? "example/factions#missing" : undefined);
  if (failure === "invalid-body") vi.mocked(faction.readJson).mockResolvedValue({ name: "" });
  if (failure === "missing-image") faction.manifest.files.splice(faction.manifest.files.findIndex(file => file.path === "badge.png"), 1);
  if (failure === "image-read-failure") vi.mocked(faction.resolveAsset).mockRejectedValue(new Error("unavailable"));
  if (failure === "unsupported-api") faction.manifest.resources[0].apiVersion = 999;
  const { content, prepared } = await runtime([character, faction]);
  expect(prepared.characters).toHaveLength(1);
  expect(prepared.catalog[0].badge).toBeUndefined();
  expect(prepared.diagnostics.some(d => d.reason === "reference-unavailable")).toBe(true);
  content.release();
});

it("accepts only qualified identities, requires API 7, and does not make affiliation a resource dependency", async () => {
  const { character, match } = fixture();
  for (const value of ["guild", "../badges/guild.png", "https://example.org/badge.png", "example/factions#../guild"]) {
    expect(HocpkgResourceKeySchema.safeParse(value).success).toBe(false);
    expect(CharacterMatchResourceSchema.safeParse({ ...match, metadata: { ...match.metadata, faction: value } }).success).toBe(false);
  }
  const context = { manifest: character.manifest, descriptor: { ...character.manifest.resources[0], apiVersion: 6 },
    packageBaseUrl: "/", dependencies: new Map([["dialogue", {}]]), resolvePath: (p: string) => p };
  await expect(createCharacterMatchResourceHandler().parse(match, context)).rejects.toThrow("API 7");
  expect(character.manifest.resources[0].requires).toEqual(["dialogue"]);
  expect(() => mergeResourceHandlers(createHocpkgResourceHandlers(), [{ type: "presentation.faction", apiVersions: [1], parse: p => p }])).toThrow("核心资源类型");
});

it("authoring validates a standalone faction-affiliated character without requiring its faction package", async () => {
  const { character, match } = fixture();
  const bodies: Record<string, Uint8Array> = {};
  for (const file of character.manifest.files) bodies[file.path] = new TextEncoder().encode(file.path.endsWith(".json") ? JSON.stringify(await character.readJson(file.path)) : "png");
  for (const file of character.manifest.files) {
    file.bytes = bodies[file.path].length;
    file.sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bodies[file.path])))].map(v => v.toString(16).padStart(2, "0")).join("");
  }
  expect(match.metadata.faction).toBe("example/factions#guild");
  await expect(validateCharacterPackage({ manifest: character.manifest, readFile: async path => bodies[path] })).resolves.toBeUndefined();
});
