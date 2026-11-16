import { describe, expect, it, vi } from "vitest";
import { FileContentRepository } from "../storage/repository";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { createCharacterPackageDraft } from "../../authoring-api";
import { ABILITY_CATALOG_VERSION } from "../../core/abilities/registry";
import { loadContent, prepareContentRuntime } from "./content-loader";
import { encodeText, sha256, sha256Json } from "../storage/encoding";
import type { BuiltinPackageIndex, HocpkgManifest } from "./schema";
import { EmbeddedContentSource, RepositoryContentSource, type ContentSource } from "./content-source";
import { playlistDocument } from "../playlists/store";

// A few bytes per asset keep source/repository contracts independent of shipped artwork.
async function fixture() {
  const documents = new Map<string, Uint8Array>();
  const packages = [];
  for (const [id, locked] of [["z-locked", true], ["v-locked", true], ["y-first", false], ["x-second", false], ["w-default", true]] as const) {
    const draft = createCharacterPackageDraft(id, id);
    const match = JSON.parse(draft.files["resources/character.json"]!);
    if (locked) match.metadata.unlock = { type: "defeat-any" };
    const dialogue = JSON.parse(draft.files["resources/dialogue.json"]!);
    for (const pool of Object.values(dialogue.pools)) (pool as string[]).push("中性测试对白");
    const files = new Map<string, Uint8Array>([
      ["resources/character.json", encodeText(JSON.stringify(match))],
      ["resources/dialogue.json", encodeText(JSON.stringify(dialogue))]
    ]);
    for (const path of Object.values(match.definition.assets) as string[]) files.set(path, new Uint8Array([1, 2, 3]));
    const manifest: HocpkgManifest = { ...draft.manifest, files: await Promise.all([...files].map(async ([path, bytes]) => ({
      path, bytes: bytes.length, sha256: await sha256(bytes), mediaType: path.endsWith(".json") ? "application/json" : "image/png"
    }))) };
    const packageId = `${manifest.identity.authorId}/${manifest.identity.packageName}`;
    const manifestPath = `${id}/hocpkg-info.json`;
    documents.set(`/characters/${manifestPath}`, encodeText(JSON.stringify(manifest)));
    for (const [path, bytes] of files) documents.set(`/characters/${id}/${path}`, bytes);
    packages.push({ id, locked, packageId, manifest, files, manifestPath });
  }
  const index: BuiltinPackageIndex = {
    format: "house-of-chances-builtin-package-index", formatVersion: 2,
    abilityCatalogVersion: ABILITY_CATALOG_VERSION, defaultCharacterId: "w-default", playerSkillOrder: [],
    packages: await Promise.all(packages.map(async entry => ({
      packageId: entry.packageId, version: entry.manifest.identity.version, manifest: entry.manifestPath,
      contentDigest: await sha256Json({ ...entry.manifest, files: [...entry.manifest.files].sort((a, b) => a.path.localeCompare(b.path)) }),
      bytes: entry.manifest.files.reduce((total, file) => total + file.bytes, 0)
    })))
  };
  documents.set("/characters/packages.json", encodeText(JSON.stringify(index)));
  const fetch: typeof globalThis.fetch = async input => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, "https://game.test").pathname;
    const bytes = documents.get(path);
    return bytes ? new Response(Uint8Array.from(bytes).buffer, { headers: { "content-type": path.endsWith(".json") ? "application/json" : "image/png" } })
      : new Response("missing", { status: 404 });
  };
  return { index, packages, fetch };
}

describe("content source contract", () => {
  it("loads the independent standard default playlist without extending the strict index", async () => {
    const sample = await fixture();
    const document = playlistDocument("官方播放集", [{ packageId: sample.packages[0]!.packageId, version: "1.0.0" }]);
    const request = vi.fn<typeof fetch>(async (input, init) => String(input) === "/embedded/default-playlist.json"
      ? new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } }) : sample.fetch(input, init));
    const source = new EmbeddedContentSource({ fetch: request });
    await expect(source.loadDefaultPlaylist()).resolves.toEqual(document);
    await expect(source.loadDefaultPlaylist()).resolves.toEqual(document);
    expect(request.mock.calls.filter(([input]) => String(input) === "/embedded/default-playlist.json")).toHaveLength(1);
    expect(await source.loadIndex()).toEqual(sample.index);
  });

  it("honors older distributor index defaults when the independent template is absent", async () => {
    const sample = await fixture(), selected = sample.packages[1]!;
    const index = { ...sample.index, defaultEnabled: [selected.packageId] };
    const request: typeof fetch = async input => String(input) === "/custom/content.json"
      ? new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } }) : new Response("missing", { status: 404 });
    const source = new EmbeddedContentSource({ indexUrl: "/custom/content.json", fetch: request });
    await expect(source.loadDefaultPlaylist()).resolves.toEqual(playlistDocument("官方播放集", [{ packageId: selected.packageId, version: selected.manifest.identity.version }]));
  });

  it("rejects invalid embedded template membership and allows retry after the file is corrected", async () => {
    const sample = await fixture(); let corrected = false;
    const request: typeof fetch = async (input, init) => String(input) === "/embedded/default-playlist.json"
      ? new Response(JSON.stringify(playlistDocument("官方播放集", [{ packageId: corrected ? sample.packages[0]!.packageId : "missing/package" }])), { headers: { "content-type": "application/json" } })
      : sample.fetch(input, init);
    const source = new EmbeddedContentSource({ fetch: request });
    await expect(source.loadDefaultPlaylist()).rejects.toThrow("引用未内嵌");
    corrected = true;
    expect((await source.loadDefaultPlaylist()).packages).toEqual([{ packageId: sample.packages[0]!.packageId }]);
  });

  it("falls back to authoring content when the development server returns its HTML app shell", async () => {
    const sample = await fixture();
    const request = vi.fn<typeof fetch>(async input => String(input) === "/embedded/content.json"
      ? new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html; charset=utf-8" } })
      : sample.fetch(input));
    const source = new EmbeddedContentSource({ fetch: request });
    await expect(source.loadIndex()).resolves.toEqual(sample.index);
    expect(request.mock.calls.map(([input]) => String(input))).toEqual(["/embedded/content.json", "/characters/packages.json"]);
  });

  it("does not replace an explicitly selected index with the development fallback", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
    await expect(new EmbeddedContentSource({ indexUrl: "/custom/content.json", fetch: request }).loadIndex()).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("builds the same registry from embedded and repository-backed packages", async () => {
    const sample = await fixture();
    const embedded = new EmbeddedContentSource({ fetch: sample.fetch });
    const index = await embedded.loadIndex();
    const character = (await embedded.packages())[0]!;
    const onePackage: ContentSource = { packages: async () => [character] };
    const direct = await loadContent(onePackage, index);

    const provider = new MemoryContentHostProvider();
    const repository = new FileContentRepository(await provider.open());
    await repository.install(character);
    const stored = await loadContent(new RepositoryContentSource(repository), index);

    try {
      expect(stored.registry).toEqual(direct.registry);
      expect(stored.packages.map((entry) => entry.manifest.identity)).toEqual(direct.packages.map((entry) => entry.manifest.identity));
      expect(prepareContentRuntime(stored).catalog.map(entry => entry.id)).toEqual([sample.packages[0]!.id]);
    } finally {
      stored.release();
      direct.release();
    }
  });

  it("does not expose disabled repository packages to the runtime source", async () => {
    const sample = await fixture();
    const embedded = new EmbeddedContentSource({ fetch: sample.fetch });
    const character = (await embedded.packages())[0]!;
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.install(character);
    expect((await new RepositoryContentSource(repository).packages()).map(entry => entry.packageId)).toEqual([character.packageId]);
    await repository.disablePackage(character.packageId);

    await expect(new RepositoryContentSource(repository).packages()).resolves.toEqual([]);
  });

  it.each([
    { name: "prefers the indexed default even after an unlocked character", disabled: [], expected: "w-default" },
    { name: "skips locked characters when the indexed default is disabled", disabled: ["w-default"], expected: "y-first" },
    { name: "skips disabled alternatives and selects the next unlocked character", disabled: ["w-default", "y-first"], expected: "x-second" },
    { name: "makes the first remaining character available when all are locked", disabled: ["w-default", "y-first", "x-second"], expected: "z-locked" }
  ])("$name", async ({ disabled, expected }) => {
    const sample = await fixture();
    const embedded = new EmbeddedContentSource({ fetch: sample.fetch });
    const provider = new MemoryContentHostProvider();
    const repository = new FileContentRepository(provider.host);
    // Insertion and alphabetical order differ from the authored index order.
    for (const entry of [...await embedded.packages()].reverse()) await repository.install(entry);
    for (const id of disabled) await repository.disablePackage(`creator/${id}`);
    const enabled = new RepositoryContentSource(new FileContentRepository(provider.host));
    const remaining = sample.packages.filter(entry => !disabled.includes(entry.id));
    expect((await enabled.packages()).map(entry => entry.packageId).sort()).toEqual(remaining.map(entry => entry.packageId).sort());
    const content = await loadContent(enabled, sample.index);
    try {
      const prepared = prepareContentRuntime(content);
      expect(prepared.diagnostics).toEqual([]);
      expect(prepared.defaultCharacterId).toBe(expected);
      expect(prepared.catalog.map(entry => entry.id)).toEqual(remaining.map(entry => entry.id));
      for (const entries of [prepared.catalog, prepared.characters]) {
        expect(entries.map(entry => ({ id: entry.id, unlock: entry.unlock }))).toEqual(remaining.map(entry => ({
          id: entry.id, unlock: entry.locked && entry.id !== expected ? { type: "defeat-any" } : undefined
        })));
      }
    } finally { content.release(); }
  });

  it("rejects activation when no character package is enabled", async () => {
    const sample = await fixture();
    const content = await loadContent(new RepositoryContentSource(new FileContentRepository(new MemoryContentHostProvider().host)), sample.index);
    try {
      expect(() => prepareContentRuntime(content)).toThrow("没有可作为默认对手的角色");
    } finally { content.release(); }
  });
});


describe("neutral embedded directory distribution", () => {
  async function document() {
    const sample = await fixture();
    const entry = sample.packages[0]!;
    const { format: _format, formatVersion: _version, $schema: _schema, ...descriptor } = entry.manifest;
    const digest = await sha256Json(descriptor);
    const startup = Object.fromEntries([...entry.files].filter(([path]) => path.endsWith(".json")).map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
    return { format: "house-of-chances-embedded-content", formatVersion: 1, abilityCatalogVersion: sample.index.abilityCatalogVersion,
      defaultCharacterId: entry.id, playerSkillOrder: [],
      packages: [{ ...descriptor, contentDigest: digest, base: `/embedded/${digest}/`, startup }] };
  }
  it("parses and prepares a directory from one description request without fetching its media", async () => {
    const value = await document(), request = vi.fn<typeof fetch>(async () => Response.json(value));
    const source = new EmbeddedContentSource({ fetch: request }), index = await source.loadIndex();
    const content = await loadContent(source, index); expect(content.packages).toHaveLength(1); content.release();
    expect(request).toHaveBeenCalledTimes(1);
    await expect((await source.packages())[0]!.resolveAsset(value.packages[0]!.files.find(file => file.mediaType.startsWith("image/"))!.path)).resolves.toMatchObject({ url: expect.stringMatching(/^\/embedded\/[a-f0-9]{64}\//) });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects corrupt startup bytes and an altered descriptor before activating content", async () => {
    const value = await document();
    const path = Object.keys(value.packages[0]!.startup)[0]!; value.packages[0]!.startup[path] = "{}";
    const source = new EmbeddedContentSource({ fetch: async () => Response.json(value) });
    await expect((await source.packages())[0]!.readJson(path)).rejects.toThrow("校验失败");
    value.packages[0]!.metadata.title = "tampered";
    await expect(new EmbeddedContentSource({ fetch: async () => Response.json(value) }).packages()).rejects.toThrow("摘要不一致");
  });
});
