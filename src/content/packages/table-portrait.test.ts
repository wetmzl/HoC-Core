import { expect, it } from "vitest";
import { createCharacterDraft, TablePortraitResourceSchema, validateCharacterPackage } from "../../authoring-api";
import { createCharacterMatchResourceHandler } from "./resources";
import { loadContent, prepareContentRuntime } from "./content-loader";
import { HocpkgManifestSchema, type BuiltinPackageIndex } from "./schema";
import { ABILITY_CATALOG_VERSION } from "../../core/abilities/registry";
import { sha256 } from "../storage/encoding";

function fixture() {
  const draft = createCharacterDraft("sample", "中性对手");
  // This fixture deliberately exercises resource APIs predating encounter policies.
  Reflect.deleteProperty(draft.match.metadata, "encounter");
  for (const pool of Object.values(draft.dialogue.pools)) (pool as string[]).push("测试对白");
  const tablePortrait = { anchorY: .94, images: [{ image: "tap.png", anchorY: .86 }] };
  const match = { ...draft.match, definition: { ...draft.match.definition, tablePortrait } };
  const manifest = HocpkgManifestSchema.parse({
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: "sample", version: "1.0.0" },
    metadata: { title: "Sample", description: "Neutral fixture", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [
      { id: "match", type: "game.character-match", apiVersion: 6, entry: "match.json", requires: ["dialogue"] },
      { id: "dialogue", type: "game.character-dialogue", apiVersion: 2, entry: "dialogue.json", requires: [] }
    ],
    files: ["match.json", "dialogue.json", "tap.png", ...Object.values(draft.match.definition.assets)].map(path => ({ path, bytes: 1, sha256: "0".repeat(64), mediaType: path.endsWith(".json") ? "application/json" : "image/png" })), extensions: {}
  });
  const context = { manifest, descriptor: manifest.resources[0], dependencies: new Map([["dialogue", draft.dialogue]]), packageBaseUrl: "/", resolvePath: (path: string) => `blob:sample/${path}` };
  return { draft, match, manifest, context };
}

it("accepts old API 4/5 packages and gates body anchors behind character API 6", async () => {
  const { draft, match, context } = fixture();
  const handler = createCharacterMatchResourceHandler();
  for (const apiVersion of [4, 5]) {
    const legacy = { ...context, descriptor: { ...context.descriptor, apiVersion } };
    await expect(handler.parse(draft.match, legacy)).resolves.toBeDefined();
    await expect(handler.parse(match, legacy)).rejects.toThrow("API 6");
  }
  await expect(handler.parse(match, context)).resolves.toMatchObject({ definition: { tablePortrait: match.definition.tablePortrait } });
});

it("rejects invalid anchors, duplicate image references, escaping and undeclared image paths", async () => {
  const { match, context } = fixture();
  const schema = TablePortraitResourceSchema;
  for (const anchorY of [-.01, 1.01, NaN, Infinity]) expect(schema.safeParse({ anchorY }).success).toBe(false);
  for (const image of ["../tap.png", "/tap.png", "https://example.test/tap.png", "tap.svg"]) expect(schema.safeParse({ anchorY: 1, images: [{ image, anchorY: .9 }] }).success).toBe(false);
  expect(schema.safeParse({ anchorY: 1, images: [{ image: "tap.png", anchorY: .9 }, { image: "tap.png", anchorY: .8 }] }).success).toBe(false);
  await expect(createCharacterMatchResourceHandler().parse(match, { ...context, manifest: { ...context.manifest, files: context.manifest.files.filter(file => file.path !== "tap.png") } })).rejects.toThrow("已声明的图片");
});

it("resolves per-image overrides through the same host media lifecycle as state and dialogue art", async () => {
  const { draft, match, manifest } = fixture();
  const source = { packages: async () => [{ packageId: "example/sample", manifest, async *files() {}, readJson: async (path: string) => path === "match.json" ? match : draft.dialogue,
    resolveAsset: async (path: string) => ({ url: `blob:sample/${path}`, release() {} }) }] };
  const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2, abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [], releaseDigest: "0".repeat(64) };
  const content = await loadContent(source, index);
  expect(prepareContentRuntime(content).characters[0].tablePortrait).toEqual({ anchorY: .94, images: [{ image: "blob:sample/tap.png", anchorY: .86 }] });
  content.release();
});

it("validates the full portable package and refuses undeclared calibration images", async () => {
  const { draft, match, manifest } = fixture();
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = Object.fromEntries(manifest.files.map(file => [file.path, file.path === "match.json" ? encoder.encode(JSON.stringify(match)) : file.path === "dialogue.json" ? encoder.encode(JSON.stringify(draft.dialogue)) : new Uint8Array([1])]));
  manifest.files = await Promise.all(manifest.files.map(async file => ({ ...file, bytes: files[file.path].length, sha256: await sha256(files[file.path]) })));
  await expect(validateCharacterPackage({ manifest, readFile: async path => files[path] })).resolves.toBeUndefined();
  manifest.files = manifest.files.filter(file => file.path !== "tap.png");
  await expect(validateCharacterPackage({ manifest, readFile: async path => files[path] })).rejects.toThrow("已声明的图片");
});


it("gates horizontal positioning behind API 14 and preserves it through package loading", async () => {
  const { draft, match, manifest, context } = fixture();
  const horizontal = { ...match, metadata: { ...match.metadata, encounter: createCharacterDraft("sample", "中性对手").match.metadata.encounter }, definition: { ...match.definition, tablePortrait: { ...match.definition.tablePortrait, offsetX: -.06, images: [{ image: "tap.png", anchorY: .86, offsetX: 0 }] } } };
  await expect(createCharacterMatchResourceHandler().parse(horizontal, { ...context, descriptor: { ...context.descriptor, apiVersion: 12 } })).rejects.toThrow("API 14");
  manifest.resources[0] = { ...manifest.resources[0], apiVersion: 14 };
  const source = { packages: async () => [{ packageId: "example/sample", manifest, async *files() {}, readJson: async (path: string) => path === "match.json" ? horizontal : draft.dialogue, resolveAsset: async (path: string) => ({ url: `blob:sample/${path}`, release() {} }) }] };
  const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2, abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [], releaseDigest: "0".repeat(64) };
  const content = await loadContent(source, index);
  expect(prepareContentRuntime(content).characters[0].tablePortrait).toEqual({ anchorY: .94, offsetX: -.06, images: [{ image: "blob:sample/tap.png", anchorY: .86, offsetX: 0 }] });
  content.release();
  for (const offsetX of [-1.01, 1.01, NaN, Infinity]) expect(TablePortraitResourceSchema.safeParse({ anchorY: 1, offsetX }).success).toBe(false);
});
