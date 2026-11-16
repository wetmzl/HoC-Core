import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from "@zip.js/zip.js/lib/zip-native.js";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

export async function encryptedZip(files: Record<string, Uint8Array>, password: string, zipCrypto = false, level: 0 | 6 = 0): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, bytes] of Object.entries(files)) await writer.add(name, new Uint8ArrayReader(bytes), { password, zipCrypto, level });
  return writer.close();
}
export function neutralPackage(name: string): Uint8Array {
  const body = Buffer.from(JSON.stringify({ name }));
  const manifest = { format: "house-of-chances-hocpkg", formatVersion: 1,
    identity: { authorId: "zip-test", packageName: name, version: "1.0.0" },
    metadata: { title: name, license: "CC0-1.0", description: "中性加密导入测试", tags: [], creators: [{ displayName: "Test", roles: ["design"] }] },
    resources: [{ id: "data", type: "test.data", apiVersion: 1, entry: "data.json", requires: [] }],
    files: [{ path: "data.json", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), mediaType: "application/json" }], extensions: {} };
  return zipSync({ "hocpkg-info.json": Buffer.from(JSON.stringify(manifest)), "data.json": body });
}
export async function nestedFixture(): Promise<Uint8Array> {
  const known = await encryptedZip({ "known.hocpkg": neutralPackage("known") }, "book-key", true, 6);
  const manual = await encryptedZip({ "manual.hocpkg": neutralPackage("manual") }, "manual-key", false, 6);
  const missingA = await encryptedZip({ "missing-a.hocpkg": neutralPackage("missing-a") }, "unknown-a");
  const missingB = await encryptedZip({ "missing-b.hocpkg": neutralPackage("missing-b") }, "unknown-b", true);
  const deeper = zipSync({ "missing-a.zip": missingA, "missing-b.zip": missingB });
  return encryptedZip({ "known.zip": known, "manual.zip": manual, "deeper.zip": deeper, "plain.hocpkg": neutralPackage("plain") }, "outer-key");
}
