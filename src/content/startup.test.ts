import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HocpkgManifest } from "./packages";
import type { ContentPackageSource } from "./storage/contracts";
import { CONTENT_PERSISTENCE_REFUSED_WARNING } from "./storage/contracts";
import { encodeText, sha256 } from "./storage/encoding";
import { MemoryContentHostProvider } from "./storage/memory-host";
import { FileContentRepository } from "./storage/repository";
import { startContent } from "./startup";

const publicRoot = resolve(import.meta.dirname, "../../public");
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

async function incompletePackage(): Promise<ContentPackageSource> {
  const path = "resources/unknown.json";
  const bytes = encodeText("{}");
  const manifest: HocpkgManifest = {
    format: "house-of-chances-hocpkg",
    formatVersion: 1,
    identity: { authorId: "test", packageName: "incomplete", version: "1.0.0" },
    metadata: { title: "incomplete", description: "test", tags: [], creators: [{ displayName: "test", roles: ["design"] }] },
    resources: [{ id: "unknown", type: "test.unknown", apiVersion: 1, entry: path, requires: [] }],
    files: [{ path, bytes: bytes.byteLength, sha256: await sha256(bytes), mediaType: "application/json" }],
    extensions: {}
  };
  return { manifest, async *files() { yield { path, bytes }; } };
}

describe("content startup", () => {
  it("uses the embedded recovery source when no persistent host is available", async () => {
    const result = await startContent({ providers: [], embedded: { fetch: fileFetch } });
    expect(result.source).toBe("embedded");
    expect(result.content.packages).toHaveLength(7);
    expect(result.repositoryError).toBeInstanceOf(Error);
  });

  it("does not seed or repair a non-empty invalid repository before embedded fallback", async () => {
    const provider = new MemoryContentHostProvider();
    const repository = new FileContentRepository(provider.host);
    await repository.install(await incompletePackage());
    const before = await repository.listPackages();

    const result = await startContent({ providers: [provider], embedded: { fetch: fileFetch } });

    expect(result.source).toBe("embedded");
    expect(await new FileContentRepository(provider.host).listPackages()).toEqual(before);
  });

  it("continues seeding with a warning when persistent storage is refused", async () => {
    const provider = new MemoryContentHostProvider();
    const refusingProvider = {
      id: "refusing",
      async probe() { return true; },
      async open() {
        return {
          ...provider.host,
          capabilities: { ...provider.host.capabilities, canRequestPersistence: true, requestPersistence: async () => false }
        };
      }
    };

    const result = await startContent({ providers: [refusingProvider], embedded: { fetch: fileFetch } });

    expect(result.source).toBe("repository");
    expect(result.warnings).toEqual([CONTENT_PERSISTENCE_REFUSED_WARNING]);
    expect(await new FileContentRepository(provider.host).isEmpty()).toBe(false);
  });
});
