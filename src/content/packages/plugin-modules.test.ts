import { afterEach, expect, it, vi } from "vitest";
import { createPackageEffect, loadPluginModules } from "./plugin-modules";
import { pluginCompatibilityError } from "./plugin-version";
import type { ContentPackageAccess } from "./content-source";
import { sha256 } from "../storage/encoding";
import { gameAudio } from "../../audio/game-audio";
import { HocpkgManifestSchema } from "./schema";
async function fixture() {
  const bytes = new Uint8Array([1, 2, 3]);
  const manifest = HocpkgManifestSchema.parse({
    format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "test", packageName: "effects", version: "1.0.0" },
    metadata: { title: "Effects", description: "Test effects", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [{ id: "module", type: "plugin.module", apiVersion: 1, entry: "module.json", requires: [] }],
    files: [{ path: "effect.ogg", bytes: 3, sha256: await sha256(bytes), mediaType: "audio/ogg" }, { path: "module.json", bytes: 3, sha256: await sha256(bytes), mediaType: "application/json" }], extensions: {}
  });
  const access: ContentPackageAccess = { manifest, files: async function* () {}, packageId: "test/effects", readFile: vi.fn(async () => bytes), readJson: vi.fn(), resolveAsset: vi.fn() };
  return access;
}
afterEach(() => vi.restoreAllMocks());
it("rejects legacy module activation before reading or executing its code", async () => {
  const access = await fixture();
  const result = await loadPluginModules({ packages: async () => [access] });
  expect(result.registrations).toEqual([]);
  expect(access.readFile).not.toHaveBeenCalled();
  expect(result.handlers[0].apiVersions).toEqual([2]);
  expect(pluginCompatibilityError(access.manifest)).toContain("需要 API 2");
  result.release();
});
it("validates sound paths, declarations, size and digest before creating a playback URL", async () => {
  const access = await fixture(); const releases: Array<() => void> = [];
  const signal = new AbortController();
  const create = vi.spyOn(gameAudio, "createEffect").mockImplementation((_url, release) => ({ play: vi.fn(), dispose: release }));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  for (const path of ["../effect.ogg", "missing.ogg", "module.json"]) await expect(createPackageEffect(access, path, signal.signal, releases)).rejects.toThrow();
  vi.mocked(access.readFile!).mockResolvedValueOnce(new Uint8Array([1]));
  await expect(createPackageEffect(access, "effect.ogg", signal.signal, releases)).rejects.toThrow("完整性");
  vi.mocked(access.readFile!).mockResolvedValueOnce(new Uint8Array([3, 2, 1]));
  await expect(createPackageEffect(access, "effect.ogg", signal.signal, releases)).rejects.toThrow("完整性");
  expect(create).not.toHaveBeenCalled();
  await createPackageEffect(access, "effect.ogg", signal.signal, releases);
  expect(create).toHaveBeenCalledOnce(); releases.forEach((release) => release()); expect(revoke).toHaveBeenCalledOnce();
  signal.abort(); await expect(createPackageEffect(access, "effect.ogg", signal.signal, releases)).rejects.toThrow("已经释放");
});
