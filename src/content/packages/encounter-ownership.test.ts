import { describe, expect, it } from "vitest";
import { EncounterProgramResourceSchema } from "../encounter-flows/catalog";
import { singleMatchProgram } from "../../core/flow/program-templates";
import { buildContentRegistry, type LoadedHocpkgPackage } from "./content-registry";
import { resolveEncounterOwnership } from "./encounter-ownership";
import { HocpkgManifestSchema } from "./schema";

function fixture(packageName: string, ownsCharacter: boolean, amount = 0): LoadedHocpkgPackage {
  const entry = EncounterProgramResourceSchema.parse({ id: "neutral-trial", ownerId: "guest", name: "Trial", description: "Neutral fixture", unlock: { type: "always" },
    definition: singleMatchProgram({ id: "neutral-trial", opponentId: "guest", playerGun: { capacity: 6, bullets: amount } }) });
  const descriptor = { id: "trial", type: "game.encounter-flow", apiVersion: 2, entry: "trial.json", requires: [] };
  const manifest = HocpkgManifestSchema.parse({ format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "example", packageName, version: "1.0.0" }, metadata: { title: packageName, description: "Test", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [descriptor], files: [{ path: "trial.json", bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" }], extensions: {} });
  return { manifest, resolvePath: path => path, resources: [
    { descriptor, state: "active", value: entry },
    ...(ownsCharacter ? [{ descriptor: { ...descriptor, id: "match", type: "game.character-match" }, state: "active" as const, value: { metadata: { id: "guest" } } }] : [])
  ] };
}

describe("encounter declaration ownership", () => {
  it("chooses the owning character's identical declaration independently of package order", () => {
    const character = fixture("character", true), standalone = fixture("standalone", false);
    for (const packages of [[character, standalone], [standalone, character]]) {
      const result = resolveEncounterOwnership(packages, buildContentRegistry(packages));
      expect(result.encounterFlows).toEqual([character.resources[0].value]);
    }
  });
  it("keeps duplicate unrelated declarations and conflicting owner declarations invalid", () => {
    for (const packages of [[fixture("first", false), fixture("second", false)], [fixture("owner", true), fixture("other", false, 1)]]) {
      expect(() => resolveEncounterOwnership(packages, buildContentRegistry(packages))).toThrow("identity is duplicated");
    }
  });
});
