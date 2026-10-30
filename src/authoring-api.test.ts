import { expect, it } from "vitest";
import { createCharacterDraft, createCharacterPackageDraft, validateCharacterPackage, type LoadedCharacterContract } from "./authoring-api";
import { sha256 } from "./content/storage/encoding";
import { readFileSync } from "node:fs";
import { CharacterDialogueResourceSchema, createDialogueDraft, validateDialogueResource, type DialogueRule } from "./authoring-api";
import { DialogueEngine } from "./dialogue/engine";
import { createMatch } from "./core/match/reducer";
import { resolvePresentation, type CharacterPresentation } from "./content/packages/character-presentation";

it("provides the existing ordered rules with empty authoring pools and an opening fallback", () => {
  const draft = createCharacterDraft("neutral", "中性角色");
  const appearance = JSON.parse(readFileSync("public/characters/chatgpt/resources/appearance.json", "utf8")) as CharacterPresentation;
  const existing = resolvePresentation(JSON.parse(readFileSync("public/characters/chatgpt/resources/dialogue.json", "utf8")), appearance) as ReturnType<typeof createDialogueDraft>;
  expect(draft.match.dialogueResourceId).toBe("dialogue");
  expect(Object.keys(draft.dialogue.pools)).toEqual(Object.keys(existing.pools).filter(id => !["CHARACTER_TAP", "CHARACTER_TAP_DEFEATED", "CHARACTER_TAP_ROULETTE"].includes(id)));
  expect(Object.values(draft.dialogue.pools).every(pool => pool.length === 0)).toBe(true);
  expect(draft.dialogue.rules).toEqual(existing.rules.filter((rule: { id: string }) => !["character-tap", "character-tap-defeated", "character-tap-roulette"].includes(rule.id)));
  expect(draft.dialogue.fallbackPoolId).toBe("MATCH_START");
  expect(CharacterDialogueResourceSchema.safeParse(draft.dialogue).success).toBe(false);
  const filled = { ...draft.dialogue, pools: Object.fromEntries(Object.keys(draft.dialogue.pools).map(id => [id, ["测试对白"]])) };
  expect(validateDialogueResource(filled)).toEqual([]);
});

it("keeps edits to one author's pools and nested rules out of other drafts", () => {
  const first = createDialogueDraft(), second = createDialogueDraft();
  (first.pools.MATCH_START as string[]).push("第一位作者的开场");
  (first.rules[0].when as { test: { eq: string } }).test.eq = "turns";
  (first.rules as DialogueRule[]).pop();
  expect(second.pools.MATCH_START).toEqual([]);
  expect(second.rules[0].when).toMatchObject({ test: { eq: "roulette-reaction" } });
  expect(createDialogueDraft()).toEqual(second);
});

it("provides a package layout that validates after its dialogue and media are supplied", async () => {
  const draft = createCharacterPackageDraft("neutral", "中性角色");
  const files: Record<string, Uint8Array> = Object.fromEntries(Object.entries(draft.files).map(([path, content]) => [path, new TextEncoder().encode(content)]));
  const dialoguePath = draft.manifest.resources.find(resource => resource.type === "game.character-dialogue")!.entry;
  const dialogue = JSON.parse(draft.files[dialoguePath]);
  for (const pool of Object.values(dialogue.pools)) (pool as string[]).push("测试对白");
  files[dialoguePath] = new TextEncoder().encode(JSON.stringify(dialogue));
  for (const name of ["cover", "relaxed", "conflicted", "mocking", "threatened", "unconscious"]) files[`${name}.png`] = new Uint8Array([1, 2, 3]);
  const manifest = { ...draft.manifest, files: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : "image/png" }))) };
  await validateCharacterPackage({ manifest, readFile: async path => files[path] });
  manifest.resources.find(resource => resource.type === "game.character-match")!.requires = [];
  await expect(validateCharacterPackage({ manifest, readFile: async path => files[path] })).rejects.toThrow("对白资源依赖");
});

it("accepts custom pools and selects a custom rule inserted before the authoring defaults", () => {
  const draft = createDialogueDraft();
  const custom: DialogueRule = { id: "custom-opening", on: [{ type: "core.round-start", apiVersion: 1 }], poolId: "custom", when: { primitive: "core.round-number", apiVersion: 1, args: {}, test: { eq: 1 } } };
  const filled = {
    ...draft,
    pools: { ...Object.fromEntries(Object.keys(draft.pools).map(id => [id, ["默认对白"]])), custom: ["自定义对白"] },
    rules: [custom, ...draft.rules]
  };
  expect(validateDialogueResource(filled)).toEqual([]);
  expect(new DialogueEngine(filled, "neutral").select(createMatch("custom-authoring")))
    .toMatchObject({ ruleId: "custom-opening", poolId: "custom", line: "自定义对白" });
});

async function fixture(apiVersion: number) {
  const draft = createCharacterDraft("neutral", "中性角色");
  Reflect.deleteProperty(draft.match.metadata, "encounter");
  for (const pool of Object.values(draft.dialogue.pools)) (pool as string[]).push("测试对白");
  const files: Record<string, Uint8Array> = {
    "character.json": new TextEncoder().encode(JSON.stringify(draft.match)),
    "dialogue.json": new TextEncoder().encode(JSON.stringify(draft.dialogue)),
    "profile.json": new TextEncoder().encode(JSON.stringify({ revision: apiVersion }))
  };
  for (const name of ["cover", "relaxed", "conflicted", "mocking", "threatened", "unconscious"]) files[`${name}.png`] = new Uint8Array([1, 2, 3]);
  const manifest = { format: "house-of-chances-hocpkg", formatVersion: 1, identity: { authorId: "test", packageName: "neutral", version: "1.0.0" }, metadata: { title: "中性角色", description: "契约验证", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] }, resources: [
    { id: "character", type: "game.character-match", apiVersion: 4, entry: "character.json", requires: ["dialogue"] },
    { id: "dialogue", type: "game.character-dialogue", apiVersion: 2, entry: "dialogue.json", requires: [] },
    { id: "profile", type: "plugin.profile", apiVersion, entry: "profile.json", requires: ["character"] }
  ], files: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : "image/png" }))), extensions: {} };
  return { manifest, readFile: async (path: string) => files[path] };
}
it("checks each extension API against its own contract while validating full Core character content", async () => {
  const contracts: LoadedCharacterContract[] = [1, 2].map(apiVersion => ({ type: "plugin.profile", apiVersion, title: "资料", description: "版本资料", guide: "说明", examples: [], schema: { type: "object", properties: { revision: { const: apiVersion } }, required: ["revision"], additionalProperties: false } }));
  await validateCharacterPackage(await fixture(1), contracts); await validateCharacterPackage(await fixture(2), contracts);
  await expect(validateCharacterPackage(await fixture(3), contracts)).rejects.toThrow("api-version-unsupported");
  await expect(validateCharacterPackage(await fixture(1), [contracts[0], contracts[0]])).rejects.toThrow("重复");
  await expect(validateCharacterPackage(await fixture(1), [{ ...contracts[0], type: "game.character-match" }])).rejects.toThrow("核心");
  const corrupted = await fixture(1); corrupted.manifest.files[0].sha256 = "0".repeat(64);
  await expect(validateCharacterPackage(corrupted, contracts)).rejects.toThrow("完整性");
});
