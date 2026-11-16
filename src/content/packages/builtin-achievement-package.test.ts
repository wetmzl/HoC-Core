import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import index from "../../../public/characters/packages.json";
import manifestJson from "../../../public/characters/official-built-in-achievements/hocpkg-info.json";
import skillsManifest from "../../../public/characters/official-built-in-skills/hocpkg-info.json";
import { verifyAuthoringPackage } from "../../authoring-api";
import { prepareAchievementCatalogs } from "./achievements";
import { buildContentRegistry } from "./content-registry";
import { loadHocpkgResources } from "./loader";
import { createHocpkgResourceHandlers } from "./resources";
import { HocpkgManifestSchema } from "./schema";

describe("standalone official achievement package", () => {
  it("loads all 25 goals and distinct covers without the player skill package", async () => {
    const manifest = HocpkgManifestSchema.parse(manifestJson);
    const read = async (path: string) => new Uint8Array(await readFile(new URL(`../../../public/characters/official-built-in-achievements/${path}`, import.meta.url)));
    await verifyAuthoringPackage({ manifest, readFile: read });
    const resolvePath = (path: string) => `/characters/official-built-in-achievements/${path}`;
    const resources = await loadHocpkgResources(manifest, {
      handlers: createHocpkgResourceHandlers(),
      readJson: async path => JSON.parse(new TextDecoder().decode(await read(path))), resolvePath
    });
    expect(resources.every(resource => resource.state === "active")).toBe(true);
    const registry = buildContentRegistry([{ manifest, resources, resolvePath }]);
    const goals = prepareAchievementCatalogs(registry.extensions["achievement.catalog"]);
    expect(goals).toHaveLength(25);
    expect(new Set(goals.map(goal => goal.coverUrl)).size).toBe(25);
    for (const goal of goals) {
      expect(goal.key).toBe(`hoc-core/official-built-in-achievements#achievements/${goal.definition.id}`);
      const png = await read(goal.definition.cover!);
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
      expect([header.getUint32(16), header.getUint32(20)]).toEqual([512, 512]);
    }
    expect(index.packages.filter(entry => entry.packageId === "hoc-core/official-built-in-achievements")).toHaveLength(1);
    expect(skillsManifest.resources.some(resource => resource.type === "achievement.catalog")).toBe(false);
  });
});
