import { afterEach, describe, expect, it } from "vitest";
import legacyFlow from "../../../tests/fixtures/boss-trial.json";
import legacyManifest from "../../../tests/fixtures/boss-trial-manifest.json";
import legacyChallenge from "../../core/challenge/fixtures/legacy-challenge.json";
import { compileLegacyFlow } from "../../core/flow/program-templates";
import { createProgramRun } from "../../core/flow/program-engine";
import { createDefaultSave } from "../../persistence/boot";
import { publicFileFetch, installBuiltinContentForTests } from "../../test/builtin-content";
import { pendingInvitationEntries, invitationProgram } from "../encounters";
import { EmbeddedContentSource, type ContentPackageAccess } from "./content-source";
import { activateContentRuntime, loadContent, prepareContentRuntime } from "./content-loader";
import { HocpkgManifestSchema } from "./schema";
import { FileContentRepository } from "../storage/repository";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { EmbeddedContentSeeder } from "./embedded-content-seeder";

function standalone(payload: unknown = legacyFlow, bossApi = false): ContentPackageAccess {
  const manifest = HocpkgManifestSchema.parse({ ...legacyManifest, resources: bossApi
    ? [{ ...legacyManifest.resources[0], type: "game.boss-challenge", apiVersion: 6 }] : legacyManifest.resources });
  return { packageId: "hoc-core/boss-challenge-dev", manifest,
    async *files() {}, async readJson() { return payload; }, async resolveAsset() { throw new Error("No media"); } };
}
async function prepare(extra: readonly ContentPackageAccess[] = []) {
  const source = new EmbeddedContentSource({ fetch: publicFileFetch });
  const packages = await source.packages();
  const content = await loadContent({ packages: async () => [...packages, ...extra] }, await source.loadIndex());
  try { return prepareContentRuntime(content); } finally { content.release(); }
}

afterEach(async () => { await installBuiltinContentForTests(); });

describe("character-owned official encounter", () => {
  it("ships the executable API 2 program with the character and discovers it without a standalone package", async () => {
    const source = new EmbeddedContentSource({ fetch: publicFileFetch });
    const packages = await source.packages();
    expect(packages.some(entry => entry.packageId === "hoc-core/boss-challenge-dev")).toBe(false);
    expect(packages.find(entry => entry.packageId === "hoc-core/claude")?.manifest.resources).toContainEqual(
      expect.objectContaining({ id: "trial", type: "game.encounter-flow", apiVersion: 2 }));
    const prepared = await prepare();
    activateContentRuntime(prepared);
    const save = createDefaultSave();
    save.defeats = ["chatgpt", "llama", "gemini", "deepseek"].map(opponentId => ({ opponentId, timestamp: new Date(0).toISOString() }));
    const entries = pendingInvitationEntries(save);
    expect(entries.filter(entry => entry.character.id === "claude")).toHaveLength(1);
    expect(entries.find(entry => entry.character.id === "claude")?.progress.unlocked).toBe(true);
    const character = prepared.characters.find(entry => entry.id === "claude")!;
    const { definition } = invitationProgram(character, save);
    expect(definition.version).toBe(2);
    const run = createProgramRun("test", "test", definition);
    expect(definition.nodes.find(node => node.id === run.cursor)).toMatchObject({ type: "choice", options: expect.any(Array) });
    expect(definition.nodes.filter(node => node.type === "match")).toHaveLength(5);
    save.completedChallenges = ["intelligent-core-trial"];
    expect(pendingInvitationEntries(save).some(entry => entry.character.id === "claude")).toBe(false);
  });

  it.each([false, true])("coexists with the installed standalone package (legacy Boss API: %s) without duplicate entries", async bossApi => {
    const prepared = await prepare([standalone(bossApi ? legacyChallenge : legacyFlow, bossApi)]);
    expect(prepared.challenges).toEqual([]);
    expect(prepared.encounterFlows.filter(entry => entry.id === "intelligent-core-trial")).toHaveLength(1);
    expect(prepared.encounterFlows[0].program).toEqual(compileLegacyFlow(prepared.encounterFlows[0].definition));
  });

  it("rejects a conflicting installed declaration rather than silently changing the challenge rules", async () => {
    await expect(prepare([standalone({ ...legacyFlow, unlock: { ...legacyFlow.unlock, count: 1 } })])).rejects.toThrow("identity is duplicated");
  });

  it.each([true, false])("upgrades an installed character without installing the retired package, preserving enabled=%s", async enabled => {
    const embedded = new EmbeddedContentSource({ fetch: publicFileFetch });
    const current = (await embedded.packages()).find(entry => entry.packageId === "hoc-core/claude")!;
    const old = { ...current, manifest: { ...current.manifest, identity: { ...current.manifest.identity, version: "1.4.6" },
      resources: current.manifest.resources.filter(resource => resource.id !== "trial"),
      files: current.manifest.files.filter(file => file.path !== "resources/challenge.json") },
      async *files() { for await (const file of current.files()) if (file.path !== "resources/challenge.json") yield file; } };
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.install(old);
    if (!enabled) await repository.disablePackage(old.packageId);
    await expect(new EmbeddedContentSeeder(repository, embedded).upgradeInstalled()).resolves.toEqual({ upgraded: 1 });
    expect(await repository.listPackages()).toEqual([expect.objectContaining({ packageId: current.packageId, enabled })]);
    expect((await repository.readManifest(current.packageId)).resources).toContainEqual(expect.objectContaining({ type: "game.encounter-flow", apiVersion: 2 }));
  });
});
