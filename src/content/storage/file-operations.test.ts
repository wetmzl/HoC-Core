import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { MemoryContentHostProvider } from "./memory-host";
import { openBrowserArchive } from "./browser-io";
import { crc32 } from "./browser-archive";
import { copyFile, inspectFiles } from "./file-operations";
import { encodeText, sha256 } from "./encoding";

describe("host file operations", () => {
  it("keeps byte and stored sources equivalent and observes cancellation", async () => {
    const fs = new MemoryContentHostProvider().fileSystem;
    const bytes = encodeText("shared contents");
    const expected = { bytes: bytes.length, sha256: await sha256(bytes) };
    expect(await copyFile(fs, { path: "payload", bytes }, "source")).toEqual(expected);
    expect(await copyFile(fs, { path: "payload", source: { kind: "stored", path: "source" } }, "destination")).toEqual(expected);
    expect(await inspectFiles(fs, ["source", "destination"])).toEqual([expected, expected]);
    const abort = new AbortController(); abort.abort();
    await expect(copyFile(fs, { path: "payload", bytes }, "cancelled", { signal: abort.signal })).rejects.toThrow();
    expect(await fs.read("cancelled")).toBeNull();
  });
  it("rejects deflated data larger than its declared size instead of accepting a truncated prefix", async () => {
    const fs = new MemoryContentHostProvider().fileSystem;
    const bytes = zipSync({ "payload": encodeText("abcdef") });
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 6, true);
    view.setUint32(central + 24, 1, true);
    view.setUint32(central + 16, crc32(encodeText("a")), true);
    const archive = await openBrowserArchive(fs, { kind: "blob", blob: new Blob([bytes]) });
    await expect(archive.extract("payload", "bad")).rejects.toThrow(/大小/);
    expect(await fs.read("bad")).toBeNull();
  });
  it("extracts one entry and rejects CRC corruption before writing", async () => {
    const fs = new MemoryContentHostProvider().fileSystem;
    const bytes = zipSync({ "one.json": encodeText("one"), "two.json": encodeText("two") }, { level: 0 });
    const archive = await openBrowserArchive(fs, { kind: "blob", blob: new Blob([bytes]) });
    await archive.extract("one.json", "one");
    expect(await fs.list("two")).toEqual([]);
    const corrupt = bytes.slice(); corrupt["one.json".length + 30] ^= 1;
    const damaged = await openBrowserArchive(fs, { kind: "blob", blob: new Blob([corrupt]) });
    await expect(damaged.extract("one.json", "bad")).rejects.toThrow(/校验/);
    expect(await fs.read("bad")).toBeNull();
  });
});
