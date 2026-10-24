import { afterEach, expect, it, vi } from "vitest";
import { createCharacterDraft } from "../../authoring-api";
import { CHARACTER_CATALOG, clearCharacterCatalog, installCharacterCatalog } from "../characters/catalog";
import { characterCardMarkup } from "../../lobby-screen-module";
import { CharacterMatchResourceSchema, createCharacterMatchResourceHandler } from "./resources";
import { loadContent, prepareContentRuntime } from "./content-loader";
import { HocpkgManifestSchema, type BuiltinPackageIndex } from "./schema";
import { ABILITY_CATALOG_VERSION } from "../../core/abilities/registry";

function fixture() {
  const draft = createCharacterDraft("sample", "测试与会者");
  for (const pool of Object.values(draft.dialogue.pools)) (pool as string[]).push("测试对白");
  const match = { ...draft.match, metadata: { ...draft.match.metadata, badge: { image: "badge.png", label: "星辰公会" } } };
  const manifest = HocpkgManifestSchema.parse({
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: "sample", version: "1.0.0" },
    metadata: { title: "Sample", description: "Neutral fixture", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [
      { id: "match", type: "game.character-match", apiVersion: 5, entry: "match.json", requires: ["dialogue"] },
      { id: "dialogue", type: "game.character-dialogue", apiVersion: 2, entry: "dialogue.json", requires: [] }
    ],
    files: ["match.json", "dialogue.json", "badge.png", "cover.png", "relaxed.png", "conflicted.png", "mocking.png", "threatened.png", "unconscious.png"].map(path => ({
      path, bytes: 1, sha256: "0".repeat(64), mediaType: path.endsWith(".json") ? "application/json" : "image/png"
    })), extensions: {}
  });
  const resolvePath = vi.fn(async (path: string) => `blob:sample/${path}`);
  const context = { manifest, descriptor: manifest.resources[0], dependencies: new Map([["dialogue", draft.dialogue]]), packageBaseUrl: "/", resolvePath };
  return { draft, match, manifest, context };
}

afterEach(clearCharacterCatalog);

it("resolves package badges through the same source lifecycle as other images", async () => {
  const { draft, match, manifest } = fixture();
  const release = vi.fn();
  const resolveAsset = vi.fn(async (path: string) => ({ url: `blob:sample/${path}`, release }));
  const source = { packages: async () => [{
    packageId: "example/sample", manifest, async *files() {},
    readJson: async (path: string) => path === "match.json" ? match : draft.dialogue, resolveAsset
  }] };
  const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2, abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [], releaseDigest: "0".repeat(64) };
  const content = await loadContent(source, index);
  const runtime = prepareContentRuntime(content);
  expect(runtime.catalog[0].badge).toEqual({ label: "星辰公会", image: "blob:sample/badge.png" });
  expect(runtime.characters[0].badge).toEqual(runtime.catalog[0].badge);
  installCharacterCatalog(runtime.catalog, "sample");
  expect(Object.isFrozen(CHARACTER_CATALOG[0].badge)).toBe(true);
  content.release();
  expect(release).toHaveBeenCalledTimes(resolveAsset.mock.calls.length);
  expect(resolveAsset.mock.calls.filter(([path]) => path === "badge.png")).toHaveLength(1);
});

it("keeps API 4 packages valid without badges and requires API 5 for the new field", async () => {
  const { draft, match, context } = fixture();
  const legacy = { ...context, descriptor: { ...context.descriptor, apiVersion: 4 } };
  await expect(createCharacterMatchResourceHandler().parse(draft.match, legacy)).resolves.toBeDefined();
  await expect(createCharacterMatchResourceHandler().parse(match, legacy)).rejects.toThrow("API 5");
});

it("rejects external or escaping badge paths and undeclared or non-image files", async () => {
  const { match, context } = fixture();
  for (const image of ["https://example.com/badge.png", "../badge.png", "/badge.png", "badge.svg"]) {
    expect(CharacterMatchResourceSchema.safeParse({ ...match, metadata: { ...match.metadata, badge: { label: "Test", image } } }).success).toBe(false);
  }
  for (const files of [context.manifest.files.filter(file => file.path !== "badge.png"), context.manifest.files.map(file => file.path === "badge.png" ? { ...file, mediaType: "text/plain" } : file)]) {
    await expect(createCharacterMatchResourceHandler().parse(match, { ...context, manifest: { ...context.manifest, files } })).rejects.toThrow("已声明的图片");
  }
  expect(CharacterMatchResourceSchema.safeParse({ ...match, metadata: { ...match.metadata, badge: { image: "badge.png", label: " " } } }).success).toBe(false);
});

it("renders an accessible escaped badge in the portrait frame without scaling it with portrait art", () => {
  const { match } = fixture();
  const character = { ...match.metadata, tier: "B" as const, portraitScales: { selection: 1.5, table: 1 }, badge: { image: "blob:badge", label: '<Guild "A">' } };
  const markup = characterCardMarkup(character, true);
  expect(markup).toContain('class="character-portrait-frame"');
  expect(markup).toContain('class="character-badge" data-badge-label="&lt;Guild &quot;A&quot;&gt;" data-tier="B" aria-label="&lt;Guild &quot;A&quot;&gt;，B级"');
  expect(markup).toContain('src="blob:badge" alt=""');
  expect(characterCardMarkup({ ...character, badge: undefined })).not.toContain('class="character-badge"');
});
