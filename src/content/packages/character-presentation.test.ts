import { afterEach, expect, it, vi } from "vitest";
import { CharacterPresentationSchema, createPresentationResolver, resolvePresentation, assertPresentationReferencesAllowed } from "./character-presentation";
import { skinCharacterFixture } from "../../test/skin-character-fixtures";
import { activateContentRuntime, deactivateContentRuntime, loadContent, prepareContentRuntime } from "./content-loader";
import { loadCharacter, getCharacterMetadata } from "../characters";
import { ABILITY_CATALOG_VERSION } from "../../core/abilities/registry";
import type { BuiltinPackageIndex } from "./schema";
import { validateCharacterPackage } from "../../authoring-api";
import { createMatch } from "../../core/match/reducer";
import { DialogueEngine } from "../../dialogue/engine";
import { createDefaultSave } from "../../persistence/boot";
import { validateLongTermSave } from "../../persistence/schema";
import { recoverLongTermSave } from "../../persistence/recover-save";
import { loadSkinPreviews } from "./skin-previews";
import { authoringPresentationAllows } from "./authoring-schema";
import { characterCardMarkup } from "../../lobby-screen-module";
import { renderFlowSelection } from "../../screens/flow-view";
import { FlowDefinitionSchema } from "../../core/flow/schema";
import { createFlowRun } from "../../core/flow/reducer";

afterEach(deactivateContentRuntime);
const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2, abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [] };

it("selects by stable ID, falls back per slot and keeps projected portrait fields together", async () => {
  const { presentation } = await skinCharacterFixture();
  const before = structuredClone(presentation);
  expect(resolvePresentation({ presentationRef: "portrait:relaxed", path: "/image" }, presentation, { skinId: "b", locale: "en" })).toBe("alternate.png");
  expect(resolvePresentation({ presentationRef: "portrait:relaxed", path: "/anchorY" }, presentation, { skinId: "b" })).toBe(.82);
  expect(resolvePresentation({ presentationRef: "portrait:relaxed", path: "/image" }, presentation, { skinId: "c" })).toBe("relaxed.png");
  expect(resolvePresentation({ presentationRef: "music" }, presentation, { skinId: "c" })).toBe("travel.ogg");
  expect(resolvePresentation({ presentationRef: "music" }, presentation, { skinId: "b" })).toBe("base.ogg");
  expect(presentation).toEqual(before);
  presentation.resources.music.variants.reverse();
  expect(resolvePresentation({ presentationRef: "music" }, presentation, { skinId: "b" })).toBe("travel.ogg");
});

it("shares the selected cover and focus across lobby, profiles and flow opponents, independently of table art", async () => {
  const { access } = await skinCharacterFixture();
  const source = { packages: async () => [access] };
  const routes = { victory: { type: "finish", result: "victory" }, defeat: { type: "finish", result: "defeat" }, escaped: { type: "selection" } };
  const flow = FlowDefinitionSchema.parse({ id: "cover-test", playerGun: { capacity: 6, bullets: 0 }, nodes: [
    { id: "guard", opponentId: "sample", routes },
    { id: "boss", opponentId: "sample", presentation: { layout: "action" }, routes }
  ] });
  for (const [skinId, cover, table, focus] of [
    ["default", "cover.png", "relaxed.png", { x: .5, y: .35 }],
    ["b", "alternate-cover.png", "alternate.png", { x: .48, y: .4 }],
    ["c", "cover.png", "relaxed.png", { x: .5, y: .35 }]
  ] as const) {
    const content = await loadContent(source, index, { characterSkins: { "creator/sample#character": skinId }, characterSkinUnlocks: { "creator/sample#character": { b: true, c: true } } });
    try {
      const prepared = prepareContentRuntime(content);
      activateContentRuntime(prepared);
      const metadata = getCharacterMetadata("sample")!;
      const character = await loadCharacter("sample");
      expect(metadata.appearance?.skinId).toBe(skinId);
      expect(metadata.previewImage).toBe(`blob:sample/${cover}`);
      expect(character.assets.cover).toBe(metadata.previewImage);
      expect(character.assets.relaxed).toBe(`blob:sample/${table}`);
      expect(metadata.previewFocus).toEqual(focus);
      expect(characterCardMarkup(metadata)).toContain(`src="blob:sample/${cover}"`);
      const markup = renderFlowSelection(createFlowRun("cover-run", "cover-seed", flow));
      expect(markup).toContain(`class="challenge-guard-portrait" src="blob:sample/${cover}"`);
      expect(markup).not.toContain("challenge-boss-action-portrait");
    } finally { content.release(); }
  }
});

it("rejects duplicates, missing/default variants, unsafe media, unknown references and cycles", async () => {
  const { presentation } = await skinCharacterFixture();
  for (const mutate of [
    (p: typeof presentation) => p.skins.push(p.skins[0]),
    (p: typeof presentation) => p.resources.music.variants.push(p.resources.music.variants[0]),
    (p: typeof presentation) => p.resources.music.variants.splice(0),
    (p: typeof presentation) => { p.resources.music.variants[0].skinId = "unknown"; },
    (p: typeof presentation) => { p.resources.music.variants[0].value = "../escape.ogg"; }
  ]) { const copy = structuredClone(presentation); mutate(copy); expect(CharacterPresentationSchema.safeParse(copy).success).toBe(false); }
  expect(() => resolvePresentation({ presentationRef: "missing" }, presentation)).toThrow("不存在");
  presentation.resources.cycle = { type: "data", variants: [{ skinId: "default", value: { presentationRef: "cycle" } }] };
  expect(() => resolvePresentation({ presentationRef: "cycle" }, presentation)).toThrow("成环");
  expect(() => resolvePresentation({ presentationRef: "portrait:relaxed", path: "/__proto__" }, presentation)).toThrow("不存在");
});

it("falls back from a legacy selected alternate until the matching durable unlock exists", async () => {
  const { access } = await skinCharacterFixture();
  const source = { packages: async () => [access] };
  const cases: Array<import("../../persistence/skin-unlocks").CharacterSkinUnlocks | undefined> = [undefined, {}, { "another/character#match": { b: true } }, { "creator/sample#character": { b: false } }];
  for (const unlocks of cases) {
    const content = await loadContent(source, index, { characterSkins: { "creator/sample#character": "b" }, characterSkinUnlocks: unlocks });
    try {
      expect(prepareContentRuntime(content).catalog[0].appearance?.skinId).toBe("default");
      expect(prepareContentRuntime(content).catalog[0].previewImage).toBe("blob:sample/cover.png");
    } finally { content.release(); }
  }
});

it("falls back as a complete portrait when alternate media cannot be read, resolving once", async () => {
  const { presentation } = await skinCharacterFixture();
  const resolvePath = vi.fn(async (path: string) => { if (path === "alternate.png") throw Error("unavailable"); return path; });
  const onFallback = vi.fn();
  const resolve = createPresentationResolver(presentation, { skinId: "b" }, { resolvePath, onFallback });
  const result = await resolve({ image: { presentationRef: "portrait:relaxed", path: "/image" }, anchor: { presentationRef: "portrait:relaxed", path: "/anchorY" } });
  expect(result).toEqual({ image: "relaxed.png", anchor: 1 });
  expect(resolvePath.mock.calls.map(([path]) => path)).toEqual(["alternate.png", "relaxed.png"]);
  expect(onFallback).toHaveBeenCalledOnce();
});

it("loads only the selected skin, preserves C when art falls back and never changes domain state", async () => {
  const { access } = await skinCharacterFixture();
  const releases: string[] = [];
  const resolveAsset = vi.fn(async (path: string) => ({ url: `blob:sample/${path}`, release: () => { releases.push(path); } }));
  const source = { packages: async () => [{ ...access, resolveAsset }] };
  const contentA = await loadContent(source, index);
  expect(resolveAsset.mock.calls.some(([path]) => ["alternate.png", "travel.ogg"].includes(path))).toBe(false);
  const a = prepareContentRuntime(contentA).characters[0];
  const contentC = await loadContent(source, index, { characterSkins: { "creator/sample#character": "c" }, characterSkinUnlocks: { "creator/sample#character": { c: true } } });
  const prepared = prepareContentRuntime(contentC);
  activateContentRuntime(prepared);
  const c = await loadCharacter("sample");
  expect(getCharacterMetadata("sample")?.appearance?.skinId).toBe("c");
  expect(c.assets.relaxed).toBe(a.assets.relaxed);
  expect(c.matchMusicSources?.[0]).toBe("blob:sample/travel.ogg");
  const stateA = createMatch("skin-test", { opponentId: a.id, aiProfile: a.ai, opponentAiSkills: a.aiSkills });
  const stateC = createMatch("skin-test", { opponentId: c.id, aiProfile: c.ai, opponentAiSkills: c.aiSkills });
  expect(stateC).toEqual(stateA);
  const portrait = new DialogueEngine(c.dialogue, c.id).peek(stateC).portrait;
  expect(portrait).toMatchObject({ image: "blob:sample/relaxed.png", anchorY: 1 });
  contentA.release(); contentC.release();
  expect(releases.length).toBe(resolveAsset.mock.calls.length);
});

it("validates all authored skins and prevents presentation references from entering rules", async () => {
  const fixture = await skinCharacterFixture();
  await expect(validateCharacterPackage({ manifest: fixture.manifest, readFile: async path => fixture.files[path] })).resolves.toBeUndefined();
  fixture.presentation.resources["pool:match_start"].variants.push({ skinId: "c", value: [] });
  await expect(validateCharacterPackage({ manifest: await fixture.rebuild(), readFile: async path => fixture.files[path] })).rejects.toThrow();
  for (const raw of [{ metadata: { id: { presentationRef: "name" } } }, { definition: { ai: { presentationRef: "ai" } } }, { aiSkills: { presentationRef: "bindings" } }]) expect(() => assertPresentationReferencesAllowed(raw, "game.character-match")).toThrow("不允许");
  const schema = { type: "object", properties: { character: { type: "string" }, art: { type: "object", "x-presentation": true } } };
  expect(authoringPresentationAllows(schema, ["art", "image"])).toBe(true);
  expect(authoringPresentationAllows(schema, ["character"])).toBe(false);
  expect(() => assertPresentationReferencesAllowed({ character: { presentationRef: "id" } }, "plugin.sample", path => authoringPresentationAllows(schema, path))).toThrow("不允许");
  expect(() => assertPresentationReferencesAllowed({ art: { presentationRef: "portrait" } }, "plugin.sample", path => authoringPresentationAllows(schema, path))).not.toThrow();
});

it("preserves missing-package preferences through save export/recovery and isolates damaged entries", () => {
  const save = createDefaultSave();
  save.settings.characterSkins = { "missing/character#match": "b" };
  expect(validateLongTermSave(JSON.parse(JSON.stringify(save))).settings.characterSkins).toEqual(save.settings.characterSkins);
  const recovered = recoverLongTermSave({ ...save, settings: { ...save.settings, characterSkins: { ...save.settings.characterSkins, bad: 2 } } });
  expect(recovered.settings.characterSkins).toEqual(save.settings.characterSkins);
  expect(recovered.recovery?.originals).toHaveLength(1);
});

it("previews skin covers and fallback portraits and releases every borrowed URL on close", async () => {
  const fixture = await skinCharacterFixture();
  const release = vi.fn();
  const resolveAsset = vi.fn(async (path: string) => ({ url: `blob:picker/${path}`, release }));
  const controller = new AbortController();
  const previews = await loadSkinPreviews({ packages: async () => [{ ...fixture.access, resolveAsset }] }, "creator/sample#character", controller.signal);
  expect(previews.items.map(item => item.image)).toEqual(["blob:picker/relaxed.png", "blob:picker/alternate.png", "blob:picker/relaxed.png"]);
  expect(previews.items.map(item => item.cover)).toEqual(["blob:picker/cover.png", "blob:picker/alternate-cover.png", "blob:picker/cover.png"]);
  expect(resolveAsset).toHaveBeenCalledTimes(4);
  controller.abort(); previews.release();
  await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(4);
});

it("keeps portrait previews available when covers are missing or unreadable", async () => {
  const fixture = await skinCharacterFixture();
  const controller = new AbortController();
  const access = { ...fixture.access, resolveAsset: async (path: string) => {
    if (path.includes("cover")) throw new Error("unavailable cover");
    return { url: `blob:picker/${path}` };
  } };
  const previews = await loadSkinPreviews({ packages: async () => [access] }, "creator/sample#character", controller.signal);
  expect(previews.items.every(item => item.image && !item.cover && !item.error)).toBe(true);
  previews.release();
});

it("releases a late plugin media lease and rejects requests after a skin runtime is retired", async () => {
  const fixture = await skinCharacterFixture();
  fixture.manifest.resources.push({ id: "lazy", type: "plugin.lazy", apiVersion: 1, entry: "lazy.json", requires: [] });
  fixture.manifest.files.push({ path: "lazy.json", bytes: 2, sha256: "0".repeat(64), mediaType: "application/json" });
  let finish!: (asset: { url: string; release(): void }) => void;
  const release = vi.fn();
  const resolveAsset = vi.fn(async (path: string) => path === "alternate.png" ? new Promise<{ url: string; release(): void }>(resolve => { finish = resolve; }) : { url: `blob:sample/${path}` });
  const content = await loadContent({ packages: async () => [{ ...fixture.access, readJson: async path => path === "lazy.json" ? {} : fixture.access.readJson(path), resolveAsset }] }, index, {
    handlers: [{ type: "plugin.lazy", apiVersions: [1], parse: (_payload, context) => ({ resolvePath: context.resolvePath }) }]
  });
  const lazy = content.registry.extensions["plugin.lazy"][0].value as { resolvePath(path: string): Promise<string> };
  const pending = lazy.resolvePath("alternate.png");
  content.release();
  finish({ url: "blob:late", release });
  await expect(pending).rejects.toThrow("已经释放");
  expect(release).toHaveBeenCalledOnce();
  const count = resolveAsset.mock.calls.length;
  await expect(lazy.resolvePath("alternate.png")).rejects.toThrow("已经释放");
  expect(resolveAsset).toHaveBeenCalledTimes(count);
  expect(() => content.packages[0].resolvePath("relaxed.png")).toThrow("已经释放");
});
