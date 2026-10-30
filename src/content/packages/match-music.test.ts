import { expect, it, vi } from "vitest";
import { createCharacterPackageDraft, validateCharacterPackage } from "../../authoring-api";
import { ABILITY_CATALOG_VERSION } from "../../core/abilities/registry";
import { loadContent, prepareContentRuntime } from "./content-loader";
import type { ContentPackageAccess } from "./content-source";
import { createHocpkgResourceHandlers } from "./resources";
import { loadHocpkgResources } from "./loader";
import { HocpkgManifestSchema, type BuiltinPackageIndex } from "./schema";

const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2,
  abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [] };
function fixture() {
  const draft = createCharacterPackageDraft("sample", "测试与会者");
  const match = JSON.parse(draft.files["resources/character.json"]);
  delete match.metadata.encounter;
  draft.manifest.resources.find(resource => resource.type === "game.character-match")!.apiVersion = 8;
  match.metadata.faction = "example/factions#guild";
  match.metadata.matchMusic = "bgm/character.ogg";
  const dialogue = JSON.parse(draft.files["resources/dialogue.json"]);
  for (const pool of Object.values(dialogue.pools)) (pool as string[]).push("测试对白");
  const bodies: Record<string, unknown> = { "resources/character.json": match, "resources/dialogue.json": dialogue };
  const make = (name: string, resources: unknown[], bodies: Record<string, unknown>, media: string[]): ContentPackageAccess => ({
    packageId: `example/${name}`,
    manifest: HocpkgManifestSchema.parse({ ...draft.manifest, identity: { authorId: "example", packageName: name, version: "1.0.0" },
      resources, files: [...Object.keys(bodies), ...media].map(path => ({ path, bytes: 1, sha256: "0".repeat(64),
        mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".ogg") ? "audio/ogg" : "image/png" })) }),
    async *files() {}, readFile: vi.fn(), readJson: vi.fn(async path => bodies[path]),
    resolveAsset: vi.fn(async path => ({ url: `blob:${name}/${path}`, release: vi.fn() }))
  });
  const character = make("sample", draft.manifest.resources, bodies,
    ["cover.png", "relaxed.png", "conflicted.png", "mocking.png", "threatened.png", "unconscious.png", "bgm/character.ogg"]);
  const factionBody = { name: "星辰公会", matchMusic: "bgm/faction.ogg" };
  const faction = make("factions", [{ id: "guild", type: "presentation.faction", apiVersion: 2, entry: "guild.json", requires: [] }],
    { "guild.json": factionBody }, ["bgm/faction.ogg"]);
  return { character, faction, match, factionBody };
}
async function runtime(packages: ContentPackageAccess[]) {
  const content = await loadContent({ packages: async () => packages }, index);
  return { content, prepared: prepareContentRuntime(content) };
}

it("resolves music from each owning package in character then faction order and releases it", async () => {
  const { character, faction } = fixture();
  const { content, prepared } = await runtime([character, faction]);
  expect(prepared.characters[0].matchMusicSources).toEqual(["blob:sample/bgm/character.ogg", "blob:factions/bgm/faction.ogg"]);
  expect(prepared.catalog[0]).not.toHaveProperty("matchMusic");
  expect(prepared.diagnostics).toEqual([]);
  content.release();
  for (const owner of [character, faction]) for (const result of vi.mocked(owner.resolveAsset).mock.results) {
    expect((await result.value).release).toHaveBeenCalledOnce();
  }
});

it("uses faction music when the character has no override and keeps old characters playable", async () => {
  const { character, faction, match } = fixture();
  delete match.metadata.matchMusic;
  character.manifest.resources[0].apiVersion = 7;
  const { content, prepared } = await runtime([character, faction]);
  expect(prepared.characters[0].matchMusicSources).toEqual(["blob:factions/bgm/faction.ogg"]);
  content.release();
});

it("keeps the character override when its faction is missing and restores faction fallback on reload", async () => {
  const { character, faction } = fixture();
  for (const packages of [[character, faction], [character], [character, faction]]) {
    const { content, prepared } = await runtime(packages);
    expect(prepared.characters[0].matchMusicSources).toHaveLength(packages.length);
    expect(prepared.characters[0].faction).toBe("example/factions#guild");
    content.release();
  }
});

it("records unreadable optional music and continues with faction music", async () => {
  const { character, faction } = fixture();
  vi.mocked(character.resolveAsset).mockImplementation(path => path.startsWith("bgm/") ? Promise.reject(new Error("unavailable")) : resolveImage(path));
  function resolveImage(path: string) { return Promise.resolve({ url: `blob:sample/${path}`, release: vi.fn() }); }
  const { content, prepared } = await runtime([character, faction]);
  expect(prepared.characters[0].matchMusicSources).toEqual(["blob:factions/bgm/faction.ogg"]);
  expect(prepared.diagnostics.some(d => d.reason === "media-unavailable")).toBe(true);
  content.release();
});

it.each(["../escape.ogg", "https://example.org/theme.ogg", "portrait.png", "bgm/missing.ogg"])("rejects unsafe, non-audio or undeclared character music: %s", async path => {
  const { character, match } = fixture();
  match.metadata.matchMusic = path;
  const results = await loadHocpkgResources(character.manifest, { handlers: createHocpkgResourceHandlers(), readJson: character.readJson });
  expect(results.find(r => r.descriptor.type === "game.character-match")?.state).toBe("invalid");
});

it.each(["character", "faction"] as const)("enforces the music API version for %s resources", async owner => {
  const fixtureValue = fixture();
  const access = fixtureValue[owner];
  access.manifest.resources[0].apiVersion = owner === "character" ? 7 : 1;
  const results = await loadHocpkgResources(access.manifest, { handlers: createHocpkgResourceHandlers(), readJson: access.readJson });
  expect(results[0]).toMatchObject({ state: "invalid", error: expect.stringContaining(owner === "character" ? "API 8" : "API 2") });
});

it("rejects a declared music path with image MIME in either owning resource", async () => {
  for (const owner of ["character", "faction"] as const) {
    const access = fixture()[owner];
    access.manifest.files.find(file => file.path.startsWith("bgm/"))!.mediaType = "image/png";
    const results = await loadHocpkgResources(access.manifest, { handlers: createHocpkgResourceHandlers(), readJson: access.readJson });
    expect(results[0]).toMatchObject({ state: "invalid", error: expect.stringContaining("同包已声明的音频") });
  }
});

it("validates a standalone authored character with music and an absent faction package", async () => {
  const { character } = fixture();
  const files: Record<string, Uint8Array> = {};
  for (const file of character.manifest.files) {
    files[file.path] = new TextEncoder().encode(file.path.endsWith(".json") ? JSON.stringify(await character.readJson(file.path)) : "media");
    file.bytes = files[file.path].length;
    file.sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(files[file.path])))].map(v => v.toString(16).padStart(2, "0")).join("");
  }
  await expect(validateCharacterPackage({ manifest: character.manifest, readFile: async path => files[path] })).resolves.toBeUndefined();
});
