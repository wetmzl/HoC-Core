import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileContentRepository } from "../storage/repository";
import { MemoryContentHostProvider } from "../storage/memory-host";
import { DEFAULT_CHARACTER_ID } from "../characters/catalog";
import { installContent, loadContent } from "./content-loader";
import { sha256Json } from "../storage/encoding";
import { EmbeddedContentSource, RepositoryContentSource, type ContentSource } from "./content-source";

const publicRoot = resolve(import.meta.dirname, "../../../public");
const fileFetch: typeof fetch = async (input) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "https://game.test");
  try {
    const body = readFileSync(resolve(publicRoot, `.${url.pathname}`));
    const contentType = url.pathname.endsWith(".json") ? "application/json" : "application/octet-stream";
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  } catch {
    return new Response("missing", { status: 404 });
  }
};

describe("content source contract", () => {
  it("builds the same registry from embedded and repository-backed packages", async () => {
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const index = await embedded.loadIndex();
    const talent = (await embedded.packages()).find((entry) => entry.packageId === "hoc-core/official-built-in-talents");
    expect(talent).toBeDefined();
    const onePackage: ContentSource = { packages: async () => [talent!] };
    const direct = await loadContent(onePackage, index);

    const provider = new MemoryContentHostProvider();
    const repository = new FileContentRepository(await provider.open());
    await repository.install(talent!);
    const stored = await loadContent(new RepositoryContentSource(repository), index);

    expect(stored.registry).toEqual(direct.registry);
    expect(stored.packages.map((entry) => entry.manifest.identity)).toEqual(direct.packages.map((entry) => entry.manifest.identity));
  });

  it("does not expose disabled repository packages to the runtime source", async () => {
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const talent = (await embedded.packages()).find((entry) => entry.packageId === "hoc-core/official-built-in-talents");
    expect(talent).toBeDefined();
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    await repository.install(talent!);
    await repository.disablePackage(talent!.packageId);

    await expect(new RepositoryContentSource(repository).packages()).resolves.toEqual([]);
  });

  it("selects the first available unlocked character when the indexed default package is disabled", async () => {
    const embedded = new EmbeddedContentSource({ fetch: fileFetch });
    const index = await embedded.loadIndex();
    const packages = await embedded.packages();
    const defaultPackage = packages.find((entry) => entry.packageId === "hoc-core/chatgpt");
    expect(index.defaultCharacterId).toBe("chatgpt");
    expect(defaultPackage).toBeDefined();
    const repository = new FileContentRepository(new MemoryContentHostProvider().host);
    for (const entry of packages) await repository.install(entry);
    await repository.disablePackage(defaultPackage!.packageId);
    const enabled = new RepositoryContentSource(repository);
    expect((await enabled.packages()).map((entry) => entry.packageId)).not.toContain(defaultPackage!.packageId);
    const content = await loadContent(enabled, index);
    installContent(content);

    expect(DEFAULT_CHARACTER_ID).toBe("claude");
    content.release();
  });
});


describe("neutral embedded directory distribution", () => {
  async function document() {
    const legacy = new EmbeddedContentSource({ indexUrl: "/characters/packages.json", fetch: fileFetch });
    const index = await legacy.loadIndex(), access = (await legacy.packages()).find(entry => entry.packageId.endsWith("official-built-in-talents"))!;
    const { format: _format, formatVersion: _version, $schema: _schema, ...descriptor } = access.manifest;
    const digest = await sha256Json(descriptor);
    const packageBase = resolve(publicRoot, "characters", index.packages.find(entry => entry.packageId === access.packageId)!.manifest, "..");
    const startup = Object.fromEntries(descriptor.files.filter(file => file.mediaType === "application/json").map(file => [file.path, readFileSync(resolve(packageBase, file.path), "utf8")]));
    return { format: "house-of-chances-embedded-content", formatVersion: 1, abilityCatalogVersion: index.abilityCatalogVersion,
      defaultCharacterId: index.defaultCharacterId, playerSkillOrder: index.playerSkillOrder,
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
