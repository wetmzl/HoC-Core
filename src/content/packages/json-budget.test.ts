import { expect, it, vi } from "vitest";
import { CharacterDialogueResourceSchema, CharacterMatchResourceSchema, createCharacterPackageDraft, PluginModuleResourceSchema } from "../../authoring-api";
import { assertContentJsonBudget, CONTENT_JSON_LIMITS } from "./json-budget";
import { HocpkgManifestSchema, type HocpkgManifest } from "./schema";
import { loadHocpkgResources } from "./loader";

function fixture() {
  const manifest: HocpkgManifest = createCharacterPackageDraft("sample", "Sample").manifest;
  manifest.files = manifest.resources.map(resource => ({ path: resource.entry, bytes: 1, sha256: "0".repeat(64), mediaType: "application/json" }));
  return manifest;
}

it.each(["tags", "files", "resources"])("rejects oversized %s without collecting one issue per element", field => {
  const manifest = fixture();
  if (field === "tags") manifest.metadata.tags = Array(20_000).fill(null);
  else Object.assign(manifest, { [field]: Array(5000).fill(null) });
  const result = HocpkgManifestSchema.safeParse(manifest);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toHaveLength(1);
});

it("checks nesting and total work before entering recursive content validators", () => {
  let nested: unknown = null;
  for (let i = 0; i <= CONTENT_JSON_LIMITS.depth; i++) nested = { child: nested };
  expect(() => assertContentJsonBudget(nested)).toThrow("嵌套");
  expect(() => assertContentJsonBudget(Array.from({ length: 100 }, () => Array(1000).fill(null)))).toThrow("节点");
  expect(() => assertContentJsonBudget({ nested: Array(10).fill({ valid: "value" }) })).not.toThrow();
});

it.each([CharacterMatchResourceSchema, CharacterDialogueResourceSchema, PluginModuleResourceSchema])("guards standalone SDK validators before validating oversized content", schema => {
  const result = schema.safeParse({ values: Array(20_000).fill(null) });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toEqual([expect.objectContaining({ code: "custom", message: expect.stringContaining("集合超过") })]);
});

it("isolates an over-budget resource without invoking its handler or blocking unrelated resources", async () => {
  const manifest = HocpkgManifestSchema.parse(fixture());
  const parse = vi.fn(value => value);
  const resources = await loadHocpkgResources(manifest, {
    handlers: manifest.resources.map(resource => ({ type: resource.type, apiVersions: [resource.apiVersion], parse })),
    readJson: async entry => entry === manifest.resources[0].entry ? Array(20_000).fill(null) : { valid: true }
  });
  expect(resources[0]).toMatchObject({ state: "invalid", reason: "payload-invalid" });
  expect(resources.slice(1).every(resource => resource.state === "active")).toBe(true);
  expect(parse).toHaveBeenCalledTimes(manifest.resources.length - 1);
});
