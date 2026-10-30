import { afterEach, describe, expect, it } from "vitest";
import { createCharacterDraft, validateCharacterPackage } from "../../authoring-api";
import { createDefaultSave } from "../../persistence/boot";
import { ABILITY_CATALOG_VERSION, ABILITY_REGISTRY, createStandaloneAbilityRegistry } from "../../core/abilities/registry";
import { singleMatchProgram } from "../../core/flow/program-templates";
import { invitationProgram } from "../encounters";
import { pendingCharacterChallenges } from "../characters/invitations";
import { EncounterProgramResourceSchema, getEncounterFlows, installEncounterFlows, validateProgramInitialization, validateProgramSkillGrant } from "../encounter-flows/catalog";
import { installCharacterCatalog, clearCharacterCatalog } from "../characters/catalog";
import { loadContent, prepareContentRuntime } from "./content-loader";
import { createCharacterMatchResourceHandler } from "./resources";
import { HocpkgManifestSchema, type BuiltinPackageIndex } from "./schema";

function fixture(runtime: unknown = { type: "flow", resourceId: "local-flow" }) {
  const draft = createCharacterDraft("sample", "测试与会者");
  for (const pool of Object.values(draft.dialogue.pools)) (pool as string[]).push("测试对白");
  const match = { ...draft.match, metadata: { ...draft.match.metadata, runtime } };
  const program = singleMatchProgram({ id: "sample-program", opponentId: "sample", init: { opponentGun: { mode: "replace", value: { capacity: 9, bullets: 2 } } } });
  const flow = { id: program.id, name: "包内对局", description: "中性测试流程", ownerId: "sample", entry: false, unlock: { type: "always" }, definition: program };
  const manifest = HocpkgManifestSchema.parse({
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName: "program", version: "1.0.0" },
    metadata: { title: "Program", description: "Neutral program fixture", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [
      { id: "match", type: "game.character-match", apiVersion: 16, entry: "match.json", requires: ["dialogue", "local-flow"] },
      { id: "dialogue", type: "game.character-dialogue", apiVersion: 2, entry: "dialogue.json", requires: [] },
      { id: "local-flow", type: "game.encounter-flow", apiVersion: 2, entry: "flows/ordinary.json", requires: [] }
    ],
    files: ["match.json", "dialogue.json", "flows/ordinary.json", "cover.png", "relaxed.png", "conflicted.png", "mocking.png", "threatened.png", "unconscious.png"].map(path => ({ path, bytes: 1, sha256: "0".repeat(64), mediaType: path.endsWith(".json") ? "application/json" : "image/png" })), extensions: {}
  });
  const payloads: Record<string, unknown> = { "match.json": match, "dialogue.json": draft.dialogue, "flows/ordinary.json": flow };
  const source = { packages: async () => [{ packageId: "example/program", manifest, async *files() {}, readJson: async (path: string) => payloads[path], resolveAsset: async (path: string) => ({ url: `blob:sample/${path}` }) }] };
  const index: BuiltinPackageIndex = { format: "house-of-chances-builtin-package-index", formatVersion: 2, abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "sample", playerSkillOrder: [], packages: [], releaseDigest: "0".repeat(64) };
  const context = { manifest, descriptor: manifest.resources[0], dependencies: new Map<string, unknown>([["dialogue", draft.dialogue], ["local-flow", EncounterProgramResourceSchema.parse(flow)]]), packageBaseUrl: "/", resolvePath: (path: string) => `blob:sample/${path}` };
  return { match, flow, manifest, payloads, source, index, context };
}

afterEach(() => { installEncounterFlows([]); clearCharacterCatalog(); });

describe("declarative package runtime contracts", () => {
  it("resolves a package-local flow file and keeps helper programs out of lobby entries", async () => {
    const value = fixture();
    const loaded = await loadContent(value.source, value.index);
    const prepared = prepareContentRuntime(loaded);
    const character = prepared.characters[0];
    expect(character.program?.id).toBe("sample-program");
    installCharacterCatalog(prepared.catalog, "sample");
    installEncounterFlows(prepared.encounterFlows);
    expect(getEncounterFlows()).toEqual([]);
    const { definition } = invitationProgram(character, createDefaultSave());
    expect(definition.nodes.find(node => node.type === "match")).toMatchObject({ init: { opponentGun: { mode: "replace", value: { capacity: 9, bullets: 2 } } } });
    loaded.release();
  });

  it("uses single-match directly and preserves character equipment when no override is authored", async () => {
    const value = fixture({ type: "template", template: { type: "single-match", opponentId: "sample" } });
    value.match.metadata.encounter.playerGun = { capacity: 8, bullets: 1 };
    const loaded = await loadContent(value.source, value.index);
    const prepared = prepareContentRuntime(loaded);
    installCharacterCatalog(prepared.catalog, "sample");
    const { definition } = invitationProgram(prepared.characters[0], createDefaultSave());
    const initial = definition.nodes.find(node => node.id === definition.start);
    expect(initial).toMatchObject({ type: "initialize", resources: { gun: { capacity: 8, bullets: 1 } }, next: "match" });
    loaded.release();
  });

  it("does not permit a runtime declaration on an older character API", async () => {
    const { match, context } = fixture();
    await expect(createCharacterMatchResourceHandler().parse(match, { ...context, descriptor: { ...context.descriptor, apiVersion: 15 } })).rejects.toThrow("API 16");
  });

  it("rejects missing, wrong-type, undeclared and external flow references", async () => {
    const { match, context } = fixture();
    const handler = createCharacterMatchResourceHandler();
    await expect(handler.parse(match, { ...context, descriptor: { ...context.descriptor, requires: ["dialogue"] } })).rejects.toThrow("包内流程");
    await expect(handler.parse(match, { ...context, dependencies: new Map([["dialogue", context.dependencies.get("dialogue")]]) })).rejects.toThrow("包内流程");
    for (const resourceId of ["missing", "dialogue", "other/package#local-flow", "../flows/ordinary.json"]) {
      await expect(handler.parse({ ...match, metadata: { ...match.metadata, runtime: { type: "flow", resourceId } } }, context)).rejects.toThrow();
    }
  });

  it("rejects a referenced program with an unavailable opponent instead of falling back to ordinary play", async () => {
    const value = fixture();
    value.flow.definition = singleMatchProgram({ id: value.flow.id, opponentId: "unavailable" });
    const loaded = await loadContent(value.source, value.index);
    expect(() => prepareContentRuntime(loaded)).toThrow("unavailable");
    loaded.release();
  });

  it("accepts a presentation-only helper program without inventing a playable encounter", () => {
    const entry = EncounterProgramResourceSchema.parse({ id: "message", name: "说明", description: "说明流程", ownerId: "sample", entry: false, unlock: { type: "always" },
      definition: { version: 2, id: "message", start: "page", nodes: [{ id: "page", type: "presentation", body: "说明", next: "end" }, { id: "end", type: "end", result: "abandoned" }] } });
    expect(entry.program?.nodes.map(node => node.type)).toEqual(["presentation", "end"]);
    installEncounterFlows([entry]);
    expect(getEncounterFlows()).toEqual([]);
  });

  it("validates initialization abilities before allowing a referenced program to run", async () => {
    const value = fixture();
    value.flow.definition = singleMatchProgram({ id: value.flow.id, opponentId: "sample", init: {
      opponentAbilities: [{ definitionId: "missing-ability", level: 1, enabled: true, parameters: {} }]
    } });
    const loaded = await loadContent(value.source, value.index);
    expect(() => prepareContentRuntime(loaded)).toThrow();
    loaded.release();
  });

  it("tracks new flow completion independently of old character defeats and honors repeatable entries", () => {
    const value = fixture();
    const entry = EncounterProgramResourceSchema.parse({ ...value.flow, entry: true });
    installEncounterFlows([entry]);
    const save = createDefaultSave();
    save.defeats = [{ opponentId: "sample", timestamp: "2026-10-30T00:00:00Z" }];
    expect(pendingCharacterChallenges(save).map(entry => entry.id)).toEqual([entry.id]);
    save.completedFlows = [entry.id];
    expect(pendingCharacterChallenges(save)).toEqual([]);
    installEncounterFlows([{ ...entry, repeatable: true }]);
    expect(pendingCharacterChallenges(save).map(entry => entry.id)).toEqual([entry.id]);
  });

  it.each([false, true])("rejects invalid initialization sources in activation/authoring mode %s", localOnly => {
    const player = ABILITY_REGISTRY.definitions.find(definition => definition.sourceKind === "player-skill" && !definition.hidden)!;
    const talent = ABILITY_REGISTRY.definitions.find(definition => definition.sourceKind === "talent")!;
    expect(() => validateProgramInitialization({ intrinsicAbilities: [{ definitionId: player.id, level: 1, enabled: true, parameters: {} }] }, ABILITY_REGISTRY, localOnly)).toThrow("固有能力");
    expect(() => validateProgramInitialization({ talents: { source: "fixed", ids: [player.id] } }, ABILITY_REGISTRY, localOnly)).toThrow("类型不匹配");
    expect(() => validateProgramInitialization({ skillPool: { source: "fixed", ids: [talent.id] } }, ABILITY_REGISTRY, localOnly)).toThrow("类型不匹配");
    expect(() => validateProgramInitialization({ skillPool: { source: "fixed", ids: [player.id, player.id] } }, ABILITY_REGISTRY, localOnly)).toThrow("不能重复");
  });

  it.each(["intrinsic", "talents", "reward"])("rejects invalid local %s declarations through the public authoring package API", async kind => {
    const source = structuredClone(ABILITY_REGISTRY.definitions.find(definition => definition.sourceKind === "player-skill" && !definition.hidden)!);
    const player = kind === "reward" ? { ...source, hidden: true, drop: { enabled: false, baseWeight: 1 }, activation: { type: "automatic" as const } } : source;
    Reflect.deleteProperty(player, "unlock");
    const init = kind === "intrinsic" ? { intrinsicAbilities: [{ definitionId: player.id, level: 1, enabled: true, parameters: {} }] }
      : kind === "talents" ? { talents: { source: "fixed", ids: [player.id] } } : undefined;
    const value = fixture({ type: "template", template: { type: "single-match", opponentId: "sample", init } });
    if (kind === "reward") {
      const binding = { definitionId: player.id, level: 1, enabled: true, parameters: {} };
      value.flow.definition.nodes = value.flow.definition.nodes.map(node => node.type === "end" && node.result === "victory"
        ? { ...node, effects: [{ id: "hidden-reward", type: "grant-skill", binding }] } : node);
      const registry = createStandaloneAbilityRegistry([player], ABILITY_REGISTRY.statuses);
      expect(() => validateProgramSkillGrant(binding, registry)).toThrow("非隐藏玩家技能");
    }
    value.payloads["skill.json"] = { definition: player, acquisition: { type: "none" } };
    const bytes = new Map<string, Uint8Array>();
    for (const path of [...value.manifest.files.map(file => file.path), "skill.json"]) bytes.set(path,
      new TextEncoder().encode(path.endsWith(".json") ? JSON.stringify(value.payloads[path]) : "neutral-image-fixture"));
    const manifest = { ...value.manifest, resources: [...value.manifest.resources,
      { id: "local-skill", type: "game.player-skill", apiVersion: 4, entry: "skill.json", requires: [] }],
      files: await Promise.all([...bytes].map(async ([path, data]) => ({ path, bytes: data.length,
        sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)))].map(value => value.toString(16).padStart(2, "0")).join(""),
        mediaType: path.endsWith(".json") ? "application/json" : "image/png" }))) };
    await expect(validateCharacterPackage({ manifest, readFile: async path => bytes.get(path)! })).rejects.toThrow(kind === "intrinsic" ? "固有能力" : kind === "talents" ? "类型不匹配" : "非隐藏玩家技能");
  });
});
